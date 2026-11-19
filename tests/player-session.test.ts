import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFleetScenario,
  originalMapCandidate,applyGameplayMapComposition,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import {
  playerLobbyGameSeat,
  type PlayerLobbyView,
} from "../packages/contracts/src/index.js";
import {
  PlayerConnection,
  PlayerRequestError,
} from "../packages/client/src/player-connection.js";
import {
  lobbyControls,
  lobbySeconds,
  lobbyChatPeople,
  lobbyStage,
} from "../packages/client/src/player-lobby.js";
import { createPlayerApi } from "../packages/server/src/player-api.js";
import {
  PlayerAccess,
  SerialExecutor,
} from "../packages/server/src/player-access.js";
import { createWaitingLobby } from "../packages/server/src/waiting-lobby.js";
import { LobbyStore } from "../packages/server/src/lobby-store.js";
import { ChatStore } from "../packages/server/src/chat.js";
import { createLifecycleService } from "../packages/server/src/lifecycle-service.js";
import { protocolHarness } from "./player-protocol-test-helpers.js";
import type { LabRoom } from "../packages/server/src/planning.js";

function waitingRoom(count: number, roomId: string): LabRoom {
  const cfg = JSON.parse(readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  cfg.economy.initialTick = 0;
  cfg.economy.players = Array.from({ length: count }, () => ({
    active: true,
    neptunium: 0,
    minesCreated: 0,
  }));
  cfg.match = { mode: "mining", neptuniumGoal: 200 };
  return {
    state: createFleetScenario(cfg),
    scheduled: [],
    playerRoomId: roomId,
  };
}
function connection(
  token: string,
  url: () => string,
  beforeObserve?: () => Promise<void>,
) {
  return new (class extends PlayerConnection {
    constructor(){super(token,url());}
    override async observe(signal?: AbortSignal) {
      await beforeObserve?.();
      return super.observe(signal);
    }
  })();
}

test("lobby controls match the original consecutive-seat start gate and preserve stable chat identities", () => {
  const lobby: PlayerLobbyView = {
    roomId: "room",
    player: 0,
    revision: 1,
    status: "waiting",
    capacity: 4,
    occupied: [true, true, false, false],
  };
  assert.equal(lobbyControls(lobby).canStart, true);
  assert.equal(lobbyControls(lobby).delayHours * 60, 5);
  assert.equal(lobbyControls({...lobby,occupied:[true,true,true,true]}).delayHours * 60, 5);
  assert.equal(lobbyControls({ ...lobby, player: 1 }).canStart, false);
  assert.equal(
    lobbyControls({ ...lobby, occupied: [true, false, true, false] }).canStart,
    false,
  );
  assert.equal(
    lobbyControls({ ...lobby, occupied: [true, false, false, false] }).canStart,
    false,
  );
  assert.equal(playerLobbyGameSeat({ ...lobby, player: 2 }), null);
  assert.equal(playerLobbyGameSeat(lobby), 0);
  const started = {
    ...lobby,
    status: "starting" as const,
    player: 3,
    gameSeat: 1,
    occupied: [true, false, false, true],
    secondsRemaining: 28800,
  };
  assert.equal(playerLobbyGameSeat(started), 1);
  assert.equal(lobbyStage(lobby), "waiting");
  assert.equal(lobbyStage(started), "game");
  assert.equal(playerLobbyGameSeat({ ...started, gameSeat: null }), null);
  assert.equal(playerLobbyGameSeat({ ...lobby, status: "cancelled" }), null);
  const people = lobbyChatPeople(started);
  assert.equal(people.player, 3);
  assert.deepEqual(people.participants, [0, 3]);
  assert.equal(people.peers[3]!.name, "赤潮");
  assert.ok(people.peers[1]!.name.includes("已离开"));
  assert.equal(lobbySeconds(started, 999), 28800);
  assert.equal(lobbySeconds(started, 1000), 28799);
  assert.equal(lobbySeconds(started, 1e10), 0);
});

test("direct game sessions probe the optional lobby once and continue using only authenticated game data", async t => {
  const h = protocolHarness(t),accessFile = PlayerAccess.generate(2),
    requests: string[] = [];
  const ownerToken=accessFile.credentials[0]!.token;
  const server = createPlayerApi({
    protocol:{repository:h.repository,roomId:'fixture-room',serial:new SerialExecutor(),load:()=>h.store.load()!,commit:(room,revision)=>h.store.commit(room,revision),ownerIdentity:authorization=>authorization===`Bearer ${ownerToken}`?{roomId:'fixture-room',player:0}:null},
  });
  server.on("request", (req) => requests.push(req.url!));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const conn = connection(
    ownerToken,
    () => `http://127.0.0.1:${address.port}`,
  );
  try {
    for (let i = 0; i < 2; i++) {
      const current = await conn.session();
      assert.equal(current.lobby, null);
      assert.equal(current.observation!.view.player, 0);
    }
    assert.equal(requests.filter((p) => p === "/lobby/v2").length, 1);
    assert.equal(requests.filter((p) => p === "/player/v2/owner/observation").length, 2);
    assert.ok(requests.every((p) => p === "/lobby/v2" || p.startsWith("/player/v2/owner/")));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("player sessions join, leave, survive start/read compaction races and keep pregame private chat and read marks with their credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subterfuge-player-session-")),
    access = PlayerAccess.generate(4),
    room = waitingRoom(4, access.roomId),
    store = new LobbyStore(join(dir, "lifecycle.sqlite"));
  store.commit(createWaitingLobby(access), 0, room);
  const chat = new ChatStore(join(dir, "chat.json"));
  await chat.load();
  let now = 1800000000000,
    seed = 4300;
  while (seed < 4800 && !applyGameplayMapComposition(originalMapCandidate(2, seed),seed).valid) seed++;
  assert.ok(seed < 4800);
  const service = createLifecycleService(store, {
    now: () => now,
    chat: () => chat,
    selectSeed: async () => seed,
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const address = service.server.address();
  assert.ok(address && typeof address === "object");
  const base = () => `http://127.0.0.1:${address.port}`;
  const worldRequests = [0, 0, 0, 0];
  service.server.on("request", (req) => {
    if (req.url === "/player/v2/owner/observation") {
      const player = access.credentials.findIndex(
        (c) => req.headers.authorization === `Bearer ${c.token}`,
      );
      if (player >= 0) worldRequests[player]!++;
    }
  });
  const host = connection(access.credentials[0]!.token, base),
    old = connection(access.credentials[1]!.token, base);
  let startDuringRead = false;
  const guest = connection(access.credentials[3]!.token, base, async () => {
    if (startDuringRead) {
      startDuringRead = false;
      const current = await host.lobby();
      await host.lobbyCommand("start", "start", current.revision);
    }
  });
  try {
    const initial = await guest.session();
    assert.equal(initial.observation, null);
    assert.equal(initial.lobby!.player, 3);
    assert.equal(worldRequests[3], 0);
    await host.lobbyCommand("join", "join", 1);
    await old.lobbyCommand("join", "join", 2);
    await host.sendChat(
      "private-old",
      1,
      "only the old credential may read this",
    );
    await old.lobbyCommand("leave", "leave", 3);
    assert.equal((await old.session()).observation, null);
    await assert.rejects(
      guest.lobbyCommand("join", "stale", 1),
      (e: unknown) =>
        e instanceof PlayerRequestError &&
        e.status === 409 &&
        e.lobby?.player === 3,
    );
    await guest.lobbyCommand("join", "join", 4);
    const joined = await guest.session();
    assert.equal(joined.observation!.view.player, 3);
    assert.equal(joined.observation!.view.playerCount, 4);
    await host.sendChat(
      "private-new",
      3,
      "same identity before and after start",
    );
    assert.deepEqual(
      (await guest.chat(0)).messages.map((m) => m.id),
      ["private-new"],
    );
    await guest.markChatSeen("0,3", 1);
    assert.equal(
      (await guest.conversations()).conversations.find((c) => c.id === "0,3")!
        .unread,
      0,
    );
    startDuringRead = true;
    const started = await guest.session();
    assert.equal(started.lobby!.status, "starting");
    assert.equal(started.lobby!.player, 3);
    assert.equal(started.lobby!.gameSeat, 1);
    assert.equal(started.observation!.view.player, 1);
    assert.equal(started.observation!.view.playerCount, 2);
    const postStart = await guest.chat(0);
    assert.deepEqual(
      postStart.messages.map((m) => m.id),
      ["private-new"],
    );
    assert.equal(postStart.messages[0]!.to, 3);
    assert.equal(
      (await guest.conversations()).conversations.find((c) => c.id === "0,3")!
        .unread,
      0,
    );
    await assert.rejects(
      guest.markChatSeen("0,1", 1),
      (e: unknown) => e instanceof PlayerRequestError && e.status === 400,
    );
    await guest.sendChat("reply", 0, "reply after compaction");
    const hostMessages = (await host.chat(0)).messages;
    assert.equal(hostMessages.find((m) => m.id === "reply")!.from, 3);
    assert.ok(hostMessages.some((m) => m.id === "private-old"));
    const nonparticipant = await old.session();
    assert.equal(nonparticipant.observation, null);
    assert.equal(nonparticipant.lobby!.gameSeat, null);
    assert.equal(
      (await guest.lobbyEvents(0)).events.filter((e) => e.kind === "starting")
        .length,
      1,
    );
    now += 300000;
    await service.synchronize();
    const running = await guest.session();
    assert.equal(running.lobby!.status, "in-progress");
    assert.equal(running.observation!.view.player, 1);
    const repeated = await host.lobbyCommand("start", "start", 5);
    assert.equal(repeated.status, "in-progress");
    assert.equal(
      (await guest.lobbyEvents(0)).events.filter((e) => e.kind === "started")
        .length,
      1,
    );
    assert.equal(
      existsSync(join(dir, "chat.json")),
      false,
      "the migrated store must not start dual-writing a legacy file",
    );
    const disk = new ChatStore(join(dir, "chat.json"));
    await disk.bindDurable(
      store.protocol.domainDocument(
        () => store.protocol.currentEpoch(access.roomId),
        "chat",
        "journal",
      ),
    );
    assert.deepEqual(
      disk.listForSeat(3).map((m) => m.id),
      ["private-new", "reply"],
    );
    assert.equal(
      disk.conversationsForSeat(3).find((c) => c.id === "0,3")!.unread,
      0,
    );
  } finally {
    service.stopClock();
    service.server.closeAllConnections();
    await new Promise<void>((resolve) => service.server.close(() => resolve()));
    await service.drain();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
