import test from "node:test";
import assert from "node:assert/strict";
import { createEightPlayerScenario } from "../packages/server/src/eight-player.js";
import {
  advanceRoom,
  scheduleLaunch,
  cancelSchedule,
  saveRoom,
  restoreRoom,
  fleetCountdowns,
} from "../packages/server/src/planning.js";
import { submitFleetOrder } from "../packages/engine/src/index.js";
const fresh = () => ({ state: createEightPlayerScenario(), scheduled: [] });
const order = {
  id: "scheduled-a",
  player: 0,
  action: {
    kind: "launch" as const,
    source: "织女星",
    destination: "回声",
    drillers: 20,
  },
};
test("scheduled launch persists, previews independently, departs at requested tick", () => {
  const original = fresh(),
    now = original.state.economy.tick;
  const room = scheduleLaunch(original, { order, departureTick: now + 8 });
  assert.equal(room.state.fleets.length, original.state.fleets.length);
  assert.deepEqual(restoreRoom(saveRoom(room)), room);
  assert.deepEqual(
    scheduleLaunch(room, { order, departureTick: now + 8 }),
    room,
  );
  const preview = advanceRoom(room, now + 9);
  assert.equal(room.scheduled[0]!.status, "pending");
  assert.equal(preview.scheduled[0]!.status, "executed");
  assert.equal(
    preview.state.events.find(
      (e) => e.kind === "departed" && e.subject === order.id,
    )?.tick,
    now + 9,
  );
  assert.deepEqual(advanceRoom(restoreRoom(saveRoom(room)), now + 9), preview);
  assert.throws(() => cancelSchedule(room, order.id, 1));
  assert.equal(
    advanceRoom(cancelSchedule(room, order.id, 0), now + 8).state.fleets.length,
    original.state.fleets.length,
  );
});
test("future invalidation survives restoration and reports failure when due", () => {
  let room = scheduleLaunch(fresh(), {
    order: {
      ...order,
      action: { ...order.action,  },
    },
    departureTick: 108,
  });
  room = {
    ...room,
    state: submitFleetOrder(room.state, {
      id: "drain",
      player: 0,
      action: {
        kind: "launch",
        source: "织女星",
        destination: "回声",
        drillers: 100,
      },
    }).state,
  };
  // Spending the source troops must fail the future order without invalidating the save.

  const restored = restoreRoom(saveRoom(room));
  const result = advanceRoom(restored, 108);
  assert.equal(result.scheduled[0]!.status, "failed");
  assert.ok(result.scheduled[0]!.reason);
});
test("countdown agrees with departure and arrival events without mutating live room", () => {
  const room = scheduleLaunch(fresh(), { order, departureTick: 101 });
  const before = saveRoom(room),
    timing = fleetCountdowns(room).get(order.id)!;
  assert.equal(timing.departureMinutes, 10);
  assert.ok(timing.arrivalMinutes !== null);
  const arrived = advanceRoom(room, Math.ceil(100 + timing.arrivalMinutes! / 10));
  assert.ok(
    arrived.state.events.some(
      (e) => e.subject === order.id && e.kind === "unloaded",
    ),
  );
  assert.equal(saveRoom(room), before);
  assert.equal(
    fleetCountdowns(advanceRoom(room, 101)).get(order.id)!.departureMinutes,
    0,
  );
});

test("historical/simulated second-precision departure survives save/replay without allowing new fractional bookings", () => {
  const original = fresh();
  for (const seconds of [600, 601, 755, 86399, 86400]) {
    const departureTick = 100 + seconds / 600;
    if(!Number.isInteger(departureTick))assert.throws(()=>scheduleLaunch(original,{order,departureTick}),/整数/);
    const room = scheduleLaunch(original, { order, departureTick },0,{simulation:true});
    const restored = restoreRoom(saveRoom(room));
    const end = Math.floor(departureTick) + 1;
    const result = advanceRoom(restored, end);
    const event = result.state.events.find(
      (e) => e.subject === order.id && e.kind === "departed",
    )!;
    assert.ok(event);
    assert.ok(
      Math.abs((event.tick - 1 + event.fraction - 100) * 600 - seconds) < 1e-6,
    );
    assert.deepEqual(restoreRoom(saveRoom(result)), result);
  }
  for (const seconds of [599, 86401, 600.5])
    assert.throws(() =>
      scheduleLaunch(original, { order, departureTick: 100 + seconds / 600 }),
    );
});

test("cancelled future plans stay cancelled after reload and never launch", () => {
  const original = fresh();
  let planned = scheduleLaunch(original, {
    order,
    departureTick: original.state.economy.tick + 80,
  });
  planned = scheduleLaunch(planned, {
    order: {
      ...order,
      id: "second-future-plan",
      action: { ...order.action, drillers: 30 },
    },
    departureTick: original.state.economy.tick + 90,
  });
  planned = cancelSchedule(planned, order.id, 0);
  planned = cancelSchedule(planned, "second-future-plan", 0);
  const restored = restoreRoom(saveRoom(planned));
  assert.equal(
    restored.scheduled.filter((p) => p.status === "pending").length,
    0,
  );
  const later = advanceRoom(restored, original.state.economy.tick + 100);
  assert.equal(
    later.scheduled.every((p) => p.status === "cancelled"),
    true,
  );
  assert.equal(
    later.state.fleets.some(
      (f) => f.id === order.id || f.id === "second-future-plan",
    ),
    false,
  );
});
