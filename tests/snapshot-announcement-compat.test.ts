import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFleetScenario,
  submitFleetOrder,
  saveFleetSnapshot,
  restoreFleetSnapshot,
  advanceFleetScenario,
  projectPlayerAnnouncements,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import { RoomStore } from "../packages/server/src/room-store.js";
test("current mine announcement metadata survives storage and rejects missing or corrupt recipients", async () => {
  const cfg = JSON.parse(fs.readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;

  cfg.economy.outposts[0]!.drillers=250;
  let s=advanceFleetScenario(submitFleetOrder(createFleetScenario(cfg),{id:'mine',player:0,action:{kind:'toggle-mine',outpostId:cfg.economy.outposts[0]!.id}}).state,101);
  const announcements = projectPlayerAnnouncements(s, 1),
    snapshot = JSON.parse(saveFleetSnapshot(s));
  assert.equal(announcements.length, 1);
  const missing=structuredClone(snapshot);
  for(const e of missing.expected.events)if(e.kind==='mine-created')delete e.audience;
  assert.throws(()=>restoreFleetSnapshot(JSON.stringify(missing)),/disagree/);
  const restored = restoreFleetSnapshot(JSON.stringify(snapshot));
  assert.deepEqual(restored, snapshot.expected);
  assert.deepEqual(projectPlayerAnnouncements(restored, 1), announcements);
  // Explicit metadata and gameplay changes must still fail validation.
  const bad = structuredClone(snapshot);
  bad.expected.events.find(
    (e: { kind: string }) => e.kind === "mine-created",
  ).audience = [];
  assert.throws(() => restoreFleetSnapshot(JSON.stringify(bad)), /disagree/);
  const corrupt = structuredClone(snapshot);
  corrupt.expected.economy.outposts[0].drillers++;
  assert.throws(
    () => restoreFleetSnapshot(JSON.stringify(corrupt)),
    /disagree/,
  );
  const dir = await mkdtemp(join(tmpdir(), "subterfuge-restored-audience-")),
    store = new RoomStore(join(dir, "room.sqlite"));
  try {
    const revision = store.commit({ state: restored, scheduled: [] }, 0);
    const loaded = store.load()!;
    assert.deepEqual(loaded.room.state, restored);
    const next = submitFleetOrder(loaded.room.state, {
      id: "shield",
      player: 0,
      action: {
        kind: "set-shields",
        outpostId: cfg.economy.outposts[0]!.id,
        enabled: false,
      },
    }).state;
    store.commit({ ...loaded.room, state: next }, revision);
    assert.deepEqual(store.load()!.room.state, next);
    assert.deepEqual(
      projectPlayerAnnouncements(store.load()!.room.state, 1),
      announcements,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
