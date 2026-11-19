import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createFleetScenario,
  originalMapCandidate,applyGameplayMapComposition,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import type {
  ChatMessage,
  CommanderThread,
  ProtocolCommandRequest,
  ProtocolHelloResponse,
  ProtocolLease,
} from "../packages/contracts/src/index.js";
import type { PlayerAccessFile } from "../packages/server/src/player-access.js";
import { createWaitingLobby } from "../packages/server/src/waiting-lobby.js";
import { LobbyStore } from "../packages/server/src/lobby-store.js";
import { ChatStore } from "../packages/server/src/chat.js";
import { CommanderStore } from "../packages/server/src/commander-store.js";
import { createLifecycleService } from "../packages/server/src/lifecycle-service.js";

const wall = 1_800_000_000_000;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hello = {
  supportedVersions: [{ major: 2, minor: 0 }],
  requiredCapabilities: ["core/2"],
  optionalCapabilities: ["chat.read/1", "commander.read/1"],
  executorInstanceId: "synthetic-lifecycle-executor",
};
const chatMessage = (id: string, from: number, to: number): ChatMessage => ({
  id,
  from,
  to,
  text: "Synthetic " + id,
  tick: 0,
  sentAt: 1000,
});
const commanderThread = (player: number, text: string): CommanderThread => ({
  roomId: "synthetic-lifecycle-room",
  player,
  messages: [],
  directives: { version: 1, text, appliedVersion: 0 },
});

async function fixture(
  t: TestContext,
  count = 2,
  legacy?: { chat: ChatMessage[]; commander: CommanderThread[] },
) {
  const dir = mkdtempSync(join(tmpdir(), "protocol-lifecycle-")),
    path = join(dir, "lifecycle.sqlite"),
    chatFile = join(dir, "chat.json"),
    commanderFile = join(dir, "commander.json");
  const access: PlayerAccessFile = {
    format: "player-access/1",
    roomId: "synthetic-lifecycle-room",
    credentials: Array.from({ length: count }, (_, player) => ({
      player,
      token: hash("synthetic_owner_only_" + player),
    })),
  };
  const setup = JSON.parse(readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  setup.economy.initialTick = 0;
  setup.economy.players = Array.from({ length: count }, () => ({
    active: true,
    neptunium: 0,
    minesCreated: 0,
  }));
  let now = wall,
    elapsed = 100,
    store = new LobbyStore(path, {
      wallNow: () => now,
      elapsedNow: () => elapsed,
    });
  store.commit(createWaitingLobby(access), 0, {
    state: createFleetScenario(setup),
    scheduled: [],
    playerRoomId: access.roomId,
  });
  if (legacy) {
    writeFileSync(
      chatFile,
      JSON.stringify({
        format: "chat-store/2",
        messages: legacy.chat,
        reads: [],
      }),
    );
    writeFileSync(
      commanderFile,
      JSON.stringify({
        format: "commander-store/1",
        threads: legacy.commander,
      }),
    );
  }
  let service: ReturnType<typeof createLifecycleService>,
    url = "",
    closed = false;
  const open = async () => {
    service = createLifecycleService(store, {
      now: () => now,
      selectSeed: async (players) => {
        let seed = 4300;
        while (!applyGameplayMapComposition(originalMapCandidate(players, seed),seed).valid) seed++;
        return seed;
      },
      ...(legacy
        ? {
            chat: () => new ChatStore(chatFile),
            commander: new CommanderStore(commanderFile),
          }
        : {}),
    });
    service.server.listen(0, "127.0.0.1");
    await once(service.server, "listening");
    const address = service.server.address();
    assert.ok(address && typeof address === "object");
    url = `http://127.0.0.1:${address.port}`;
  };
  const stop = async () => {
    service.stopClock();
    service.server.closeAllConnections();
    await new Promise<void>((resolve) => service.server.close(() => resolve()));
    await service.drain();
    store.close();
  };
  await open();
  t.after(async () => {
    if (!closed) {
      closed = true;
      await stop();
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (
    path: string,
    body?: unknown,
    token = access.credentials[0]!.token,
    headers: Record<string, string> = {},
  ) =>
    fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const owner = (
    player: number,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => request(path, body, access.credentials[player]!.token, headers);
  const membership = (player: number, kind: "join" | "leave" | "start") =>
    owner(player, "/lobby/v2/commands", {
      id: `${kind}-${store.load()!.revision}`,
      kind,
      revision: store.load()!.revision,
    });
  let grants = 0,
    acquisitions = 0;
  const grant = async (ownerSeat = 0) => {
    const number = ++grants,
      token = hash("synthetic_executor_only_" + number),
      response = await owner(ownerSeat, "/player/v2/owner/grants", {
        grantId: "synthetic-grant-" + number,
        tokenHash: hash(token),
        scopes: [
          "observe",
          "events.read",
          "commands.write",
          "control.lease",
          "chat.send",
          "commander.worker",
        ],
        expiresAtMs: now + 1_000_000_000,
      });
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    return { token, info: await response.json() };
  };
  const connect = async (token: string) => {
    const response = await request("/player/v2/sessions/hello", hello, token);
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    return response.json();
  };
  const snapshot = async (token: string) => {
    const response = await request("/player/v2/snapshot", undefined, token);
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    let page = await response.json(),
      text = page.page.text;
    const first = page;
    while (page.page.nextPageToken) {
      page = await (
        await request(
          `/player/v2/snapshot?snapshotId=${page.snapshotId}&pageToken=${page.page.nextPageToken}`,
          undefined,
          token,
        )
      ).json();
      text += page.page.text;
    }
    return { envelope: first, document: JSON.parse(text) };
  };
  const acquire = async (
    token: string,
    session: Awaited<ReturnType<typeof connect>>,
  ) => {
    const response = await request(
      "/player/v2/control/acquire",
      {
        roomEpoch: session.scope.roomEpoch,
        sessionId: session.sessionId,
        idempotencyKey: "synthetic-acquire-" + ++acquisitions,
      },
      token,
    );
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    return (await response.json()).current;
  };
  return {
    dir,
    path,
    access,
    chatFile,
    commanderFile,
    request,
    owner,
    membership,
    grant,
    connect,
    snapshot,
    acquire,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
    advanceElapsed: (ms: number) => {
      elapsed += ms;
    },
    async restart() {
      await stop();
      store = new LobbyStore(path, {
        wallNow: () => now,
        elapsedNow: () => elapsed,
      });
      await open();
      await service.ready;
    },
  };
}
async function start(f: Awaited<ReturnType<typeof fixture>>, seats = [0, 1]) {
  for (const player of seats)
    assert.equal((await f.membership(player, "join")).status, 200);
  const response = await f.membership(0, "start");
  assert.equal(
    response.status,
    200,
    JSON.stringify(await response.clone().json()),
  );
}

function command(
  session: ProtocolHelloResponse,
  lease: Pick<ProtocolLease, "generation">,
  revision: string,
  id: string,
  action: unknown,
): ProtocolCommandRequest {
  return {
    roomEpoch: session.scope.roomEpoch,
    sessionId: session.sessionId,
    fence: lease.generation,
    authorizationVersion: session.authorizationVersion,
    idempotencyKey: id,
    clientCommandId: id,
    expectedRevision: revision,
    instructionsVersion: "0",
    kind: "order",
    payload: { action },
  };
}

test("default lifecycle listener exposes durable v2, guards startup, requires joined observation and started control, and verifies actual owner credentials", async (t) => {
  const f = await fixture(t);
  const advertised = await f.request("/player/v2/protocol");
  assert.equal(advertised.status, 200);
  assert.ok((await advertised.json()).capabilities.includes("chat.read/1"));
  const delegated = await f.grant();
  assert.equal(
    (await f.request("/player/v2/snapshot", undefined, delegated.token)).status,
    403,
  );
  assert.equal(
    (
      await f.request("/player/v2/owner/observation", undefined, delegated.token, {
        "X-Subterfuge-Controller": "manual",
        "X-Subterfuge-Role": "owner",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/player/v2/owner/grants", undefined, delegated.token, {
        "X-Subterfuge-Role": "owner",
      })
    ).status,
    401,
  );
  assert.equal((await f.membership(0, "join")).status, 200);
  const session = await f.connect(delegated.token),
    snapshot = await f.snapshot(delegated.token);
  assert.equal(snapshot.document.observation.view.player, 0);
  assert.equal(
    snapshot.document.coverage.chat,
    "bounded-tail-with-complete-cursor",
  );
  assert.equal(
    (
      await f.request(
        "/player/v2/control/acquire",
        {
          roomEpoch: session.scope.roomEpoch,
          sessionId: session.sessionId,
          idempotencyKey: "before-start",
        },
        delegated.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.owner(0, "/player/v2/owner/control", {
        action: "acquire",
        sessionId: "synthetic-before-start-session",
      })
    ).status,
    409,
  );
  const before = f.store.protocol.currentEpoch(f.access.roomId);
  assert.equal((await f.membership(1, "join")).status, 200);
  assert.equal((await f.membership(0, "start")).status, 200);
  assert.notEqual(
    f.store.protocol.currentEpoch(f.access.roomId),
    before,
    "even unchanged roster starts a fresh epoch",
  );
  assert.equal(
    (await f.request("/player/v2/snapshot", undefined, delegated.token)).status,
    401,
  );
  const current = await f.grant(),
    active = await f.connect(current.token);
  await f.acquire(current.token, active);
  assert.equal(
    (
      await f.owner(0, "/player/v2/owner/control", {
        action: "acquire",
        sessionId: "synthetic-owner-competing-session",
      })
    ).status,
    409,
  );
});

test("lifecycle roster compaction preserves original chat identities but remaps commander threads and revokes waiting grants", async (t) => {
  const f = await fixture(t, 4, {
    chat: [
      chatMessage("for-former-seat-one", 0, 1),
      chatMessage("for-original-seat-three", 0, 3),
    ],
    commander: [
      commanderThread(1, "Private discarded player's plan"),
      commanderThread(3, "Correct original seat three plan"),
    ],
  });
  assert.equal((await f.membership(0, "join")).status, 200);
  assert.equal((await f.membership(3, "join")).status, 200);
  const waiting = await f.grant(3),
    oldSession = await f.connect(waiting.token),
    before = await f.snapshot(waiting.token);
  assert.equal(oldSession.identity.gamePlayer, 3);
  assert.equal(
    before.document.commander.directives.text,
    "Correct original seat three plan",
  );
  const sourceChat = readFileSync(f.chatFile, "utf8"),
    sourceCommander = readFileSync(f.commanderFile, "utf8");
  assert.equal((await f.membership(0, "start")).status, 200);
  assert.equal(
    (await f.request("/player/v2/snapshot", undefined, waiting.token)).status,
    401,
  );
  assert.equal((await f.owner(1, "/player/v2/owner/observation")).status, 401);
  const delegated = await f.grant(3),
    session = await f.connect(delegated.token),
    current = await f.snapshot(delegated.token);
  assert.equal(session.identity.gamePlayer, 1);
  assert.equal(session.identity.lobbySeat, 3);
  assert.equal(session.identity.chatPlayer, 3);
  assert.equal(session.identity.chatCount, 4);
  assert.deepEqual(session.identity.roster, [
    { chatPlayer: 0, gamePlayer: 0 },
    { chatPlayer: 3, gamePlayer: 1 },
  ]);
  assert.deepEqual(
    current.document.chat.messages.map((m: ChatMessage) => m.id),
    ["for-original-seat-three"],
  );
  assert.equal(current.document.commander.player, 1);
  assert.equal(
    current.document.commander.directives.text,
    "Correct original seat three plan",
  );
  assert.equal(
    JSON.stringify(current.document).includes(
      "Private discarded player's plan",
    ),
    false,
  );
  const control = await (await f.owner(3, "/player/v2/owner/control")).json();
  assert.equal(control.player, 1);
  const identity=await(await f.owner(3,'/player/v2/owner/identity')).json();
  assert.equal(identity.chatPlayer, 3);
  assert.equal(readFileSync(f.chatFile, "utf8"), sourceChat);
  assert.equal(readFileSync(f.commanderFile, "utf8"), sourceCommander);
  const epoch = f.store.protocol.currentEpoch(f.access.roomId);
  writeFileSync(f.chatFile, "corrupt non-authoritative leftover");
  writeFileSync(f.commanderFile, "corrupt non-authoritative leftover");
  await f.restart();
  assert.equal(f.store.protocol.currentEpoch(f.access.roomId), epoch);
  const after = await f.snapshot(delegated.token);
  assert.deepEqual(after.document.chat, current.document.chat);
  assert.deepEqual(after.document.commander, current.document.commander);
});

test("owner and executor v2 share durable fencing and restart cannot resurrect an old session", async (t) => {
  const f = await fixture(t);
  await start(f);
  const delegated = await f.grant(),
    session = await f.connect(delegated.token),
    lease = await f.acquire(delegated.token, session),
    initial = await f.snapshot(delegated.token);
  const own = initial.document.observation.view.outposts.find(
    (o: { owner?: number }) => o.owner === 0,
  );
  assert.ok(own);
  assert.equal(
    (await f.owner(0, "/player/v2/owner/control", { action: "takeover", mode: "manual" }))
      .status,
    200,
  );
  const stale = await f.request(
    "/player/v2/commands",
    command(
      session,
      lease,
      initial.document.observation.revision,
      "stale-after-takeover",
      { kind: "set-shields", outpostId: own.id, enabled: false },
    ),
    delegated.token,
  );
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "FENCE_STALE");
  assert.equal(f.store.load()!.runtime!.room.state.commands.length, 0);
  const ownerSession = "synthetic-persistent-owner-session";
  assert.equal(
    (
      await f.owner(0, "/player/v2/owner/control", {
        action: "acquire",
        sessionId: ownerSession,
      })
    ).status,
    200,
  );
  const competing = await f.connect(delegated.token);
  assert.equal(
    (
      await f.request(
        "/player/v2/control/acquire",
        {
          roomEpoch: competing.scope.roomEpoch,
          sessionId: competing.sessionId,
          idempotencyKey: "compete-with-owner",
        },
        delegated.token,
      )
    ).status,
    409,
  );
  const epoch = f.store.protocol.currentEpoch(f.access.roomId);
  await f.restart();
  assert.equal(f.store.protocol.currentEpoch(f.access.roomId), epoch);
  assert.equal(
    (await f.owner(0, "/player/v2/owner/control", { action: "renew", sessionId: ownerSession }))
      .status,
    409,
  );
  assert.equal(
    (
      await f.owner(0, "/player/v2/owner/control", {
        action: "acquire",
        sessionId: ownerSession,
      })
    ).status,
    409,
  );
  const fresh = await f.connect(delegated.token),
    renewed = await f.acquire(delegated.token, fresh);
  assert.ok(BigInt(renewed.generation) > BigInt(lease.generation));
});

test("lifecycle world, receipt, projections and phase metadata roll back together on a command storage failure", async (t) => {
  const f = await fixture(t);
  await start(f);
  const delegated = await f.grant(),
    session = await f.connect(delegated.token),
    lease = await f.acquire(delegated.token, session),
    initial = await f.snapshot(delegated.token);
  const own = initial.document.observation.view.outposts.find(
      (o: { owner?: number }) => o.owner === 0,
    ),
    request = command(
      session,
      lease,
      initial.document.observation.revision,
      "atomic-lifecycle-order",
      { kind: "set-shields", outpostId: own.id, enabled: false },
    );
  const before = f.store.load(),
    epoch = f.store.protocol.currentEpoch(f.access.roomId),
    phase = f.store.protocol.domainDocument(epoch, "lifecycle", "phase").read(),
    db = new DatabaseSync(f.path);
  try {
    db.exec(
      "CREATE TRIGGER lifecycle_receipt_failure BEFORE UPDATE ON protocol_operations BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END",
    );
    const failed = await f.request(
      "/player/v2/commands",
      request,
      delegated.token,
    );
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).outcome, "unknown");
    assert.deepEqual(f.store.load(), before);
    assert.equal(
      f.store.protocol.domainDocument(epoch, "lifecycle", "phase").read(),
      phase,
    );
    const v2 = await (await f.owner(0, "/player/v2/owner/observation")).json();
    assert.equal(v2.revision, initial.document.observation.revision);
    const lookup = await (
      await f.request(
        "/player/v2/commands/lookup",
        { roomEpoch: epoch, idempotencyKeys: [request.idempotencyKey] },
        delegated.token,
      )
    ).json();
    assert.equal(lookup.results[0].receipt.state, "accepted");
    db.exec("DROP TRIGGER lifecycle_receipt_failure");
    const response = await f.request(
      "/player/v2/commands",
      request,
      delegated.token,
    );
    assert.equal(response.status, 200);
    const applied = await response.json();
    assert.equal(applied.state, "applied");
    assert.equal(f.store.load()!.runtime!.room.state.commands.length, 1);
    const fresh = await f.snapshot(delegated.token),
      current = await (await f.owner(0, "/player/v2/owner/observation")).json();
    assert.equal(fresh.document.observation.revision, current.revision);
    assert.notEqual(current.revision, v2.revision);
    const events = await (
      await f.request(
        "/player/v2/events?after=" + initial.envelope.cursor,
        undefined,
        delegated.token,
      )
    ).json();
    assert.ok(
      events.events.some(
        (event: any) =>
          event.type === "observation.changed" &&
          event.payload.revision === current.revision,
      ),
    );
    assert.deepEqual(
      await (
        await f.request("/player/v2/commands", request, delegated.token)
      ).json(),
      applied,
    );
    assert.equal(f.store.load()!.runtime!.room.state.commands.length, 1);
  } finally {
    db.close();
  }
});

test("rolled-back start does not publish a phase cache or lose chat; retried same-roster start forks exactly once", async (t) => {
  const f = await fixture(t, 2, {
    chat: [chatMessage("before-start", 0, 1)],
    commander: [commanderThread(1, "Retained directive")],
  });
  assert.equal((await f.membership(0, "join")).status, 200);
  assert.equal((await f.membership(1, "join")).status, 200);
  const oldEpoch = f.store.protocol.currentEpoch(f.access.roomId),
    oldPhase = f.store.protocol
      .domainDocument(oldEpoch, "lifecycle", "phase")
      .read(),
    before = f.store.load()!;
  assert.throws(
    () =>
      f.store.protocol.atomic(() => {
        f.store.commitStart(
          before.waitingRoom!,
          {
            id: "synthetic-aborted-start",
            player: 0,
            seed: 4300,
            startedAtMs: f.now,
          },
          before.revision,
        );
        assert.notEqual(
          f.store.protocol.currentEpoch(f.access.roomId),
          oldEpoch,
        );
        assert.equal(f.store.load()!.start!.id, "synthetic-aborted-start");
        throw Error("synthetic outer rollback");
      }),
    /synthetic outer rollback/,
  );
  assert.deepEqual(f.store.load(), before);
  assert.equal(f.store.protocol.currentEpoch(f.access.roomId), oldEpoch);
  assert.equal(
    f.store.protocol.domainDocument(oldEpoch, "lifecycle", "phase").read(),
    oldPhase,
  );
  assert.equal((await f.membership(0, "start")).status, 200);
  const newEpoch = f.store.protocol.currentEpoch(f.access.roomId);
  assert.notEqual(newEpoch, oldEpoch);
  assert.equal(f.store.protocol.inspect().epochs.length, 2);
  const delegated = await f.grant(1),
    current = await f.snapshot(delegated.token);
  assert.deepEqual(
    current.document.chat.messages.map((m: ChatMessage) => m.id),
    ["before-start"],
  );
  assert.equal(
    current.document.commander.directives.text,
    "Retained directive",
  );
  await f.service.synchronize();
  await f.restart();
  assert.equal(f.store.protocol.currentEpoch(f.access.roomId), newEpoch);
  assert.equal(f.store.protocol.inspect().epochs.length, 2);
});

test("cancelled waiting lifecycle denies previously joined observers without revealing another room or advancing time", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.membership(0, "join")).status, 200);
  const delegated = await f.grant();
  await f.snapshot(delegated.token);
  const response = await f.owner(0, "/lobby/v2/commands", {
    id: "synthetic-cancel",
    kind: "cancel",
    revision: f.store.load()!.revision,
  });
  assert.equal(response.status, 200);
  assert.equal(
    (await f.request("/player/v2/snapshot", undefined, delegated.token)).status,
    403,
  );
  assert.equal(
    (await f.request("/player/v2/owner/grants", undefined, delegated.token))
      .status,
    401,
  );
  await f.service.synchronize();
  assert.equal(f.store.load()!.waitingRoom!.state.economy.tick, 0);
  assert.equal(f.store.load()!.start, undefined);
});

test("lifecycle HTTP and clock wait for asynchronous domain initialization before serving", async (t) => {
  const store = new LobbyStore(":memory:");
  const access: PlayerAccessFile = {
    format: "player-access/1",
    roomId: "synthetic-startup-room",
    credentials: [0, 1].map((player) => ({
      player,
      token: hash("synthetic-startup-owner-" + player),
    })),
  };
  const setup = JSON.parse(readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  setup.economy.initialTick = 0;
  store.commit(createWaitingLobby(access), 0, {
    state: createFleetScenario(setup),
    scheduled: [],
    playerRoomId: access.roomId,
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  class PausedChat extends ChatStore {
    override async bindDurable(
      document: Parameters<ChatStore["bindDurable"]>[0],
    ) {
      await barrier;
      await super.bindDurable(document);
    }
  }
  const service = createLifecycleService(store, {
    chat: () => new PausedChat(),
    now: () => wall,
  });
  t.after(async () => {
    release();
    service.stopClock();
    service.server.closeAllConnections();
    await new Promise<void>((resolve) => service.server.close(() => resolve()));
    await service.drain();
    store.close();
  });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const address = service.server.address();
  assert.ok(address && typeof address === "object");
  let answered = false,
    synchronized = false;
  const received = once(service.server, "request");
  const request = fetch(`http://127.0.0.1:${address.port}/lobby/v2`, {
    headers: { Authorization: "Bearer " + access.credentials[0]!.token },
  }).then((response) => {
    answered = true;
    return response;
  });
  const sync = service.synchronize().then(() => {
    synchronized = true;
  });
  await received;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(answered, false);
  assert.equal(synchronized, false);
  assert.equal(store.load()!.revision, 1);
  release();
  await service.ready;
  await sync;
  assert.equal((await request).status, 200);
});

test("lifecycle compaction isolates previous occupants' receipts and preserves the original player's history", async (t) => {
  const f = await fixture(t, 4);
  for (const player of [0, 1, 3])
    assert.equal((await f.membership(player, "join")).status, 200);
  const writeReceipt = async (player: number) => {
    const grant = await f.grant(player),
      session = await f.connect(grant.token),
      key = "synthetic-private-seat-" + player;
    const response = await f.request(
      "/player/v2/commander/worker",
      {
        roomEpoch: session.scope.roomEpoch,
        sessionId: session.sessionId,
        authorizationVersion: session.authorizationVersion,
        idempotencyKey: key,
        clientCommandId: key,
        instructionsVersion: "0",
        kind: "commander-worker",
        payload: {
          op: "notice",
          id: "synthetic-private-notice-" + player,
          reply: "Synthetic private seat discussion " + player,
        },
      },
      grant.token,
    );
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    const receipt = await response.json();
    assert.equal(receipt.state, "applied");
    return { session, key, receipt };
  };
  const former = await writeReceipt(1),
    own = await writeReceipt(3);
  assert.equal((await f.membership(1, "leave")).status, 200);
  assert.equal((await f.membership(0, "start")).status, 200);
  const next = await f.grant(3),
    current = await f.connect(next.token);
  assert.equal(current.identity.gamePlayer, 1);
  assert.notEqual(current.scope.roomEpoch, former.session.scope.roomEpoch);
  assert.equal(current.scope.playerId, own.session.scope.playerId);
  assert.notEqual(current.scope.playerId, former.session.scope.playerId);
  const lookup = await f.request(
    "/player/v2/commands/lookup",
    {
      roomEpoch: former.session.scope.roomEpoch,
      idempotencyKeys: [former.key, own.key],
    },
    next.token,
  );
  assert.equal(lookup.status, 200);
  const [other, mine] = (await lookup.json()).results;
  assert.equal(other.status, "absent_within_retained_scope");
  assert.equal(other.receipt, undefined);
  assert.equal(mine.status, "found");
  assert.deepEqual(mine.receipt, own.receipt);
  const direct = await f.request(
    "/player/v2/commands/" + former.receipt.commandId,
    undefined,
    next.token,
  );
  assert.equal(direct.status, 404);
  assert.equal(JSON.stringify(await direct.json()).includes(former.key), false);
  const directOwn = await f.request(
    "/player/v2/commands/" + own.receipt.commandId,
    undefined,
    next.token,
  );
  assert.equal(directOwn.status, 404);
});
