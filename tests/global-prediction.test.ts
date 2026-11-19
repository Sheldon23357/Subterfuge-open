import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import {
  createFleetScenario,
  submitFleetOrder,
  fleetOutpostMetrics,
  fleetOutpostInspector,
  projectGlobalActivity,
  projectPlayerActivity,
  fleetMatchOutcome,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import { createLabPrediction } from "../packages/prediction/src/index.js";
import {
  advanceRoom,
  fleetCountdowns,
  type LabRoom,
} from "../packages/server/src/planning.js";
import { scheduleOrder } from "../packages/server/src/scheduled-orders.js";

function fixture(): LabRoom {
  const cfg = JSON.parse(fs.readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  let room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
  room.state = submitFleetOrder(room.state, {
    id: "moving",
    player: 0,
    action: {
      kind: "launch",
      source: cfg.economy.outposts[0]!.id,
      destination: cfg.economy.outposts[1]!.id,
      drillers: 27,
    },
  }).state;
  room = scheduleOrder(room, {
    order: {
      id: "shield",
      player: 0,
      action: {
        kind: "set-shields",
        outpostId: cfg.economy.outposts[0]!.id,
        enabled: false,
      },
    },
    issueTick: 108,
  });
  return room;
}
function frame(
  session: ReturnType<typeof createLabPrediction>,
  target: number,
) {
  session.begin(target);
  let steps = 0;
  while (!session.step(target)) {
    assert.ok(++steps < 200);
  }
  const projection = session.result();
  let next = projection.next();
  while (!next.done) next = projection.next();
  return next.value;
}
test("global worker frames preserve combat, schedules and backward scrubbing without eager arrival estimates without changing live state", () => {
  const room = fixture(),
    before = JSON.stringify(room),
    session = createLabPrediction(room);
  for (const target of [112, 113, 104, 130, 108, 100, 140]) {
    const actual = frame(session, target),
      expected = advanceRoom(room, target, true),
      timings = fleetCountdowns(expected, 0);
    assert.equal(actual.tick, expected.state.economy.tick);
    assert.deepEqual(actual.players, expected.state.economy.players);
    assert.deepEqual(actual.scheduled, expected.scheduled);
    assert.deepEqual(
      actual.orders?.map((o) => [o.id, o.status]),
      expected.scheduledOrders?.map((o) => [o.id, o.status]),
    );
    assert.deepEqual(
      actual.outposts.map((o) => [
        o.id,
        o.owner,
        o.drillers,
        o.shield,
        o.metrics,
      ]),
      expected.state.economy.outposts.map((o) => [
        o.id,
        o.owner,
        o.drillers,
        o.shield,
        fleetOutpostMetrics(expected.state, o.id),
      ]),
    );
    assert.deepEqual(
      actual.fleets.map((f) => [
        f.id,
        f.position,
        f.drillers,
        f.arrivalMinutes,
      ]),
      expected.state.fleets
        .filter((f) => f.used)
        .map((f) => [
          f.id,
          f.position,
          f.drillers,
          null,
        ]),
    );
  }
  assert.equal(JSON.stringify(room), before);
});
test("partial global advances and arrival projections can be superseded by an earlier selection", () => {
  const room = fixture(),
    session = createLabPrediction(room);
  session.begin(1000);
  assert.equal(session.step(1000), false);
  assert.deepEqual(frame(session, 105), frame(createLabPrediction(room), 105));
  session.begin(110);
  while (!session.step(110));
  const abandoned = session.result();
  abandoned.next();
  assert.deepEqual(frame(session, 106), frame(createLabPrediction(room), 106));
  assert.throws(() => session.begin(99));
  assert.throws(() => session.begin(1541));
});
test("global incremental prediction stops at the terminal tick", () => {
  const room = fixture();
  room.state.initial.match = { mode: "mining", neptuniumGoal: 200 };
  room.state.economy.players[1]!.neptunium = 199;
  room.state.economy.outposts[1]!.miningProgress = 1000;
  const expected = advanceRoom(room, 140, true);
  assert.ok(fleetMatchOutcome(expected.state));
  const actual = frame(createLabPrediction(room), 140);
  assert.equal(actual.tick, expected.state.economy.tick);
  assert.equal(actual.match?.ended, true);
});
test("global worker reads one versioned source and cancels stale work before publishing the latest frame", async () => {
  const room = fixture(),
    before = JSON.stringify(room);
  const worker = new Worker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    let reads=0;
    globalThis.fetch=async url=>{
      if(url!=='/api/prediction-source?roomId=test-room&revision=test-revision'||++reads>1)throw Error('Unexpected host read');
      return {ok:true,json:async()=>({roomId:'test-room',revision:'test-revision',room:workerData.room})};
    };
    globalThis.postMessage=reply=>parentPort.postMessage(reply);
    import(workerData.module).then(()=>{
      parentPort.on('message',data=>globalThis.onmessage({data}));
      parentPort.postMessage({ready:true});
    }).catch(error=>{throw error;});
  `,
    {
      eval: true,
      workerData: {
        room,
        module: new URL(
          "../packages/client/src/global-prediction-worker.js",
          import.meta.url,
        ).href,
      },
    },
  );
  try {
    const replies: unknown[] = [];
    const result = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Worker timed out")), 10000);
      worker.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.on("message", (reply) => {
        if (reply.ready) {
          worker.postMessage({
            kind: "predict",
            id: 1,
            source: {roomId:"test-room",revision:"test-revision",startTick:100},
            targetTick: 1500,
          });
          worker.postMessage({ kind: "cancel", id: 1 });
          worker.postMessage({
            kind: "predict",
            id: 2,
            source: {roomId:"test-room",revision:"test-revision",startTick:100},
            targetTick: 110,
          });
        } else {
          replies.push(reply);
          clearTimeout(timer);
          resolve(reply);
        }
      });
    });
    assert.equal(result.id, 2);
    assert.ok(result.frame, result.error);
    assert.deepEqual(result.frame, frame(createLabPrediction(room), 110));
    assert.equal(replies.length, 1);
    assert.equal(JSON.stringify(room), before);
  } finally {
    await worker.terminate();
  }
});

test("OB activity snapshot avoids replay without changing complete frames, orders, combat or backward scrubbing", () => {
  let room = fixture();
  // A committed launch and past battle make the retained activity nonempty.
  room = advanceRoom(room, 106, true);
  const activity = projectGlobalActivity(room.state);
  assert.ok(activity.length > 0);
  const serialized = JSON.stringify(room), copied = structuredClone(activity);
  const restored = createLabPrediction(JSON.parse(serialized));
  const seeded = createLabPrediction(JSON.parse(serialized), copied);
  // Mutation of the caller's snapshot must not affect the prediction branch.
  copied.length = 0;
  for (const target of [106, 108, 120, 144, 109, 107, 160, 108]) {
    assert.deepEqual(frame(seeded, target), frame(restored, target), String(target));
  }
  assert.equal(JSON.stringify(room), serialized);
  assert.deepEqual(projectGlobalActivity(room.state), activity);
});

test("OB seeded activity preserves ordinary combat, economic projections and terminal outcomes", () => {
  const cfg = JSON.parse(fs.readFileSync("examples/fleet-lab.json", "utf8")).initial as FleetSetup;
  cfg.match = { mode: "mining", neptuniumGoal: 200 };
  let room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
  room.state = submitFleetOrder(room.state, { id: "ordinary-attack", player: 0,
    action: {kind: "launch", source: cfg.economy.outposts[0]!.id,
      destination: cfg.economy.outposts[1]!.id, drillers: 27,
       },
  }).state;
  room = scheduleOrder(room, { order: { id: "future-shield", player: 0,
    action: { kind: "set-shields", outpostId: cfg.economy.outposts[0]!.id, enabled: false } }, issueTick: 104 });
  room.state.economy.players[1]!.neptunium = 199;
  room.state.economy.outposts[1]!.miningProgress = 1000;
  const activity = projectGlobalActivity(room.state), saved = JSON.stringify(room);
  const seeded = createLabPrediction(JSON.parse(saved), activity);
  const fallback = createLabPrediction(JSON.parse(saved));
  for (const target of [101, 120, 104, 130, 101]) {
    const actual = frame(seeded, target);
    assert.deepEqual(actual, frame(fallback, target));
    assert.equal(actual.match?.ended, true);
    assert.ok(actual.orders?.some(p => p.status === "failed"));
  }
  assert.equal(JSON.stringify(room), saved);
});

test("OB inspector uses one shared context with identical metrics for every outpost", () => {
  const room = fixture();
  for (const tick of [100, 104, 112, 144]) {
    const state = advanceRoom(room, tick, true).state;
    const inspect = fleetOutpostInspector(state);
    assert.deepEqual(state.economy.outposts.map(o => inspect(o.id)),
      state.economy.outposts.map(o => fleetOutpostMetrics(state, o.id)));
  }
});


test("seeding an OB branch never installs a partial journal on the caller's state", () => {
  const room = fixture();
  const global = projectGlobalActivity(room.state);
  const player = projectPlayerActivity(room.state, 0);
  const detached = JSON.parse(JSON.stringify(room));
  createLabPrediction(detached, global);
  assert.deepEqual(projectPlayerActivity(detached.state, 0), player);
  createLabPrediction(room, global);
  assert.deepEqual(projectPlayerActivity(room.state, 0), player);
});

test("OB activity hydration retains bounded history IDs through ordinary combat and future orders", () => {
  const cfg = JSON.parse(fs.readFileSync("examples/fleet-lab.json", "utf8")).initial as FleetSetup;
  let room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
  for (let i = 0; i < 14; i++) room.state = submitFleetOrder(room.state, {
    id: `old-shield-${i}`, player: 0,
    action: { kind: "set-shields", outpostId: cfg.economy.outposts[0]!.id, enabled: i % 2 !== 0 },
  }).state;
  room.state = submitFleetOrder(room.state, { id: "ordinary-combat", player: 0,
    action: {kind: "launch", source: cfg.economy.outposts[0]!.id,
      destination: cfg.economy.outposts[1]!.id, drillers: 27,
       },
  }).state;
  room = scheduleOrder(room, { order: { id: "after-launch", player: 0,
    action: {kind: "set-shields", outpostId: cfg.economy.outposts[0]!.id, enabled: false} }, issueTick: 105 });
  const activity = projectGlobalActivity(room.state);
  assert.equal(activity.length, 10);
  assert.ok(activity[0]!.id > 0);
  const serialized = JSON.stringify(room);
  const seeded = createLabPrediction(JSON.parse(serialized), activity);
  const fallback = createLabPrediction(JSON.parse(serialized));
  for (const target of [100, 101, 112, 144, 103, 108, 100, 150]) {
    const actual = frame(seeded, target);
    assert.deepEqual(actual, frame(fallback, target));
    if(target >= 112) {
      assert.ok(actual.events.some(e => e.kind === "battle"));
      assert.ok(actual.orders?.some(p => p.status === "executed"));
    }
  }
  assert.equal(JSON.stringify(room), serialized);
});
