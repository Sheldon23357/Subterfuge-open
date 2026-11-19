import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFleetScenario, submitFleetOrder, type FleetSetup } from '../packages/engine/src/index.js';
import { scheduleOrder } from '../packages/server/src/scheduled-orders.js';
import { simulatePlayerFrame, simulatePlayerFuture, createPlayerFrameSession, createPlayerFrameCache } from '../packages/server/src/player-forecast.js';
import { createRoomPreviewCache } from '../packages/server/src/room-preview-cache.js';
import { createPlayerArrivalsCache, estimatePlayerArrivals } from '../packages/server/src/player-game-preview.js';
import { advanceRoom } from '../packages/server/src/planning.js';
import type { LabRoom } from '../packages/server/src/planning.js';

test('arrival polling reuses a frame and invalidates on seat, phase, orders and live state', () => {
  const cfg = JSON.parse(fs.readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup;
  let room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
  room.state = submitFleetOrder(room.state, { id: 'arrival-cache', player: 0, action: {
    kind: 'launch', source: cfg.economy.outposts[0]!.id, destination: cfg.economy.outposts[1]!.id, drillers: 27,
  } }).state;
  const cached = createPlayerArrivalsCache(), before = JSON.stringify(room);
  const initial = cached(room, 0);
  assert.strictEqual(cached({ ...room }, 0), initial);
  for (const phase of [0, 250, 599]) for (const player of [0, 1]) {
    const current = { ...room, state: { ...room.state, secondsSinceLastTick: phase } };
    assert.deepEqual(cached(room, player, phase), estimatePlayerArrivals(current, player));
  }
  assert.equal(JSON.stringify(room), before);
  room = scheduleOrder(room, { order: { id: 'check', player: 0, action: { kind: 'check-in' } }, issueTick: 104 });
  assert.notStrictEqual(cached(room, 0), initial);
  assert.deepEqual(cached(room, 0), estimatePlayerArrivals(room, 0));
  const scheduled = cached(room, 0);
  room.state = advanceRoom(room, 101).state;
  assert.notStrictEqual(cached(room, 0), scheduled);
  assert.deepEqual(cached(room, 0), estimatePlayerArrivals(room, 0));
});

test('fast time-machine frames match full forecasts across combat, schedules, phases and horizons', () => {
  for (const seconds of [0, 250, 599]) {
    const cfg = JSON.parse(fs.readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup;
    let room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
    room.state = submitFleetOrder(room.state, { id: 'attack', player: 0, action: {
      kind: 'launch', source: cfg.economy.outposts[0]!.id, destination: cfg.economy.outposts[1]!.id, drillers: 27,
    } }, seconds).state;
    room = scheduleOrder(room, { order: { id: 'check', player: 0, action: { kind: 'check-in' } }, issueTick: 102 });
    room.state.secondsSinceLastTick = seconds;
    const before = JSON.stringify(room);
    for (const player of [0, 1]) {
      const session = createPlayerFrameSession(room, player);
      for (const tick of [101, 103, 110, 172, 244, 110, 111, 102, 1540, 244])
        assert.deepEqual(session(tick), simulatePlayerFrame(room, player, tick));
    }
    for (const player of [0, 1]) for (const ticks of [1, 3, 10, 72, 144, 1440]) {
      const fast = simulatePlayerFrame(room, player, 100 + ticks);
      const full = simulatePlayerFuture(room, player, 100 + ticks);
      assert.equal(fast.status, full.status);
      if (fast.status === 'conditional' && full.status === 'conditional') {
        assert.deepEqual(fast.result, full.result);
        assert.deepEqual(fast.orders, full.orders);
        assert.equal('notificationTimeline' in fast, false);
      }
    }
    assert.equal(JSON.stringify(room), before);
  }
});

test('checkpoint caches invalidate on live state, phase, seat and agenda changes', () => {
  const cfg = JSON.parse(fs.readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup;
  let room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
  const cached = createPlayerFrameCache();
  for (const phase of [0, 250, 599, 250]) for (const player of [0, 1]) {
    const current = { ...room, state: { ...room.state, secondsSinceLastTick: phase } };
    for (const tick of [110, 111, 105]) assert.deepEqual(cached(room, player, tick, phase), simulatePlayerFrame(current, player, tick));
  }
  room = scheduleOrder(room, { order: { id: 'check', player: 0, action: { kind: 'check-in' } }, issueTick: 104 });
  assert.deepEqual(cached(room, 0, 110), simulatePlayerFrame(room, 0, 110));
  room = { ...room, state: submitFleetOrder(room.state, { id: 'attack', player: 0, action: {
    kind: 'launch', source: cfg.economy.outposts[0]!.id, destination: cfg.economy.outposts[1]!.id, drillers: 27,
  } }).state };
  assert.deepEqual(cached(room, 0, 110), simulatePlayerFrame(room, 0, 110));
  // A host can retain its room object while replacing the immutable state.
  room.state = advanceRoom(room, 101).state;
  assert.deepEqual(cached(room, 0, 110), simulatePlayerFrame(room, 0, 110));
  assert.throws(() => cached(room, 0, 100, 250), /horizon/);
});

test('a cached unknown allied activity branch cannot poison an earlier supported target', () => {
  const cfg = JSON.parse(fs.readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup;
  cfg.economy.initialTick = 500;

  let room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
  delete room.state.initial.match;room.state.economy.initial.teamSize=2;room.state.activity=room.state.economy.players.map(()=>({lastCheckinTime:500*600,inactivityWarningCount:0,autoResigned:false}));
  room=scheduleOrder(room,{order:{id:'ally-check-in',player:1,action:{kind:'check-in'}},issueTick:503});
  const session = createPlayerFrameSession(room, 0), before = JSON.stringify(room);
  for (const tick of [501, 502, 503, 504, 501, 502]) assert.deepEqual(session(tick), simulatePlayerFrame(room, 0, tick));
  assert.equal(session(503).status, 'unsupported');
  assert.equal(session(502).status, 'conditional');
  assert.equal(JSON.stringify(room), before);
});

test('observer checkpoints match independent advancement and never modify the live room', () => {
  const cfg = JSON.parse(fs.readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup;
  let room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
  const cached = createRoomPreviewCache(), before = JSON.stringify(room);
  for (const tick of [110, 111, 104, 120, 105, 1540, 150, 151]) assert.deepEqual(cached(room, tick), advanceRoom(room, tick, true));
  for (let tick = 101; tick <= 116; tick++) assert.deepEqual(cached(room, tick), advanceRoom(room, tick, true));
  assert.deepEqual(cached(room, 100), advanceRoom(room, 100, true));
  assert.equal(JSON.stringify(room), before);
  room = advanceRoom(room, 102);
  assert.deepEqual(cached(room, 110), advanceRoom(room, 110, true));
});

test('fast previews preserve the terminal tick and match end', () => {
  const cfg = JSON.parse(fs.readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup;
  cfg.match = { mode: 'mining', neptuniumGoal: 200 };
  cfg.economy.players[1]!.neptunium = 199;
  cfg.economy.outposts[1]!.miningProgress = 1000;
  const room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
  const fast = simulatePlayerFrame(room, 1, 110), full = simulatePlayerFuture(room, 1, 110);
  assert.equal(fast.status, 'conditional'); assert.equal(full.status, 'conditional');
  if (fast.status === 'conditional' && full.status === 'conditional') {
    assert.deepEqual(fast.result, full.result);
    assert.equal(fast.result.targetTick, 101);
  }
  const session = createPlayerFrameSession(room, 1);
  for (const tick of [110, 112, 101, 1440]) assert.deepEqual(session(tick), simulatePlayerFrame(room, 1, tick));
});
