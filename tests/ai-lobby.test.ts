import {SeatRunner} from './helpers/scripted-controller.js';
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";import {AiStore,initialState,type AiSnapshot} from "../packages/ai/src/index.js";
import {ProviderError} from '../packages/ai/src/controller/contracts/provider-error.js';
import {observation} from '../packages/server/src/player-api.js';
import { LobbyAi } from "../packages/server/src/ai-lobby.js";
import { LobbyStore } from "../packages/server/src/lobby-store.js";
import { PlayerAccess } from "../packages/server/src/player-access.js";
import {
  createWaitingLobby,
  submitLobbyMembership,
} from "../packages/server/src/waiting-lobby.js";
import { createLifecycleService } from "../packages/server/src/lifecycle-service.js";
import {
  createFleetScenario,
  type FleetSetup,
} from "../packages/engine/src/index.js";

test("host adds multiple bot seats, cannot overwrite human seats; configuration persists without private data exposure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subterfuge-ai-lobby-")),
    store = new LobbyStore(join(dir, "lobby.sqlite")),
    aiStore = new AiStore(join(dir, "ai.sqlite")),
    access = PlayerAccess.generate(4);
  const cfg = JSON.parse(readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  cfg.economy.initialTick = 0;
  cfg.economy.players.push(
    { ...cfg.economy.players[0]! },
    { ...cfg.economy.players[0]! },
  );
  let lobby = createWaitingLobby(access);
  lobby = submitLobbyMembership(lobby, { id: "host", player: 0, kind: "join" });
  lobby = submitLobbyMembership(lobby, {
    id: "human",
    player: 3,
    kind: "join",
  });
  store.commit(lobby, 0, {
    state: createFleetScenario(cfg),
    scheduled: [],
    playerRoomId: access.roomId,
  });
  const ai = new LobbyAi(store, aiStore, {
      step: async () => {
        throw Error("No model calls before start");
      },
    }),
    service = createLifecycleService(store, { ai });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const address = service.server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const settings = {
    model: "example-model",
    personality: "schemer",
  };
  const request = (seat: number, data?: unknown) =>
    fetch(url + "/ai/v2", {
      method: data ? "POST" : "GET",
      headers: { Authorization: `Bearer ${access.credentials[seat]!.token}` },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  try {
    assert.equal((await fetch(url + "/ai/v2")).status, 401);
    assert.equal((await request(3)).status, 403);
    assert.equal(
      (await request(0, { action: "add", seat: 3, settings })).status,
      400,
    );
    assert.equal(
      (await request(0, { action: "add", seat: 1, settings })).status,
      200,
    );
    assert.equal(
      (
        await request(0, {
          action: "add",
          seat: 2,
          settings: { ...settings, personality: "honorable" },
        })
      ).status,
      200,
    );
    assert.deepEqual(store.load()!.lobby.seats, [1, 1, 1, 1]);
    assert.equal(
      (await request(0, { action: "add", seat: 1, settings })).status,
      400,
    );
    assert.equal((await request(0, { action: "pause", seat: 1 })).status, 200);
    assert.equal(aiStore.load(access.roomId, 1)!.enabled, false);
    assert.equal(
      (await request(0, { action: "resume", seat: 1, settings })).status,
      200,
    );
    const state = aiStore.load(access.roomId, 1)!;
    state.memory.deceptions = "private plan";
    aiStore.save(state);
    const text = await (await request(0)).text();
    assert.ok(!text.includes("private plan"));
    assert.ok(!text.includes(access.credentials[1]!.token));
    assert.equal(new LobbyAi(store, aiStore).status().seats.length, 2);
    ai.start(url);
    ai.tick();
    assert.equal(aiStore.load(access.roomId, 1)!.calls, 0);
  } finally {
    await ai.stop();
    service.server.closeAllConnections();
    await new Promise<void>((resolve) => service.server.close(() => resolve()));
    aiStore.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
