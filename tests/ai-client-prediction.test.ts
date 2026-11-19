import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFleetScenario, submitFleetOrder, type FleetSetup } from '../packages/engine/src/index.js';
import { attackRoutes, createKnownPrediction, forecastKnownObservation, compareKnownObservations, previewKnownDeployment, estimateKnownArrivals } from '../packages/prediction/src/index.js';
import { executeTool, initialState, PlayerGateway, type AiSnapshot, type GameGateway } from '../packages/ai/src/index.js';
import { observation } from '../packages/server/src/player-api.js';
import { scheduleOrder } from '../packages/server/src/scheduled-orders.js';
import type { LabRoom } from '../packages/server/src/planning.js';
import type { PlayerForecastResponse } from '../packages/contracts/src/index.js';

function fixture(hidden = false) {
  const cfg = JSON.parse(readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup;
  cfg.match = { mode: 'mining', neptuniumGoal: 200 };
  cfg.economy.outposts[2]!.owner = 0; cfg.economy.outposts[2]!.drillers = 20;
  if (hidden) { cfg.size = { width: 80, height: 80 }; cfg.positions['红方矿场'] = { x: 30, y: 30 }; }
  const room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
  const snapshot: AiSnapshot = { observation: observation(room, 0, 'known-ai'), chat: [], notifications: [], chatCursor: 0, notificationCursor: 0, chatPlayer: 0, chatCount: 2 };
  const requests: string[] = [];
  const gateway: GameGateway = { snapshot: async () => snapshot, request: async path => { requests.push(path); throw Error('Simulation transport forbidden'); },
    forecastBatch: async () => { throw Error('Alternate forecast gateway forbidden'); } };
  const state = initialState('known-ai', 0, { model: '', personality: 'schemer' });
  const details=new Map<string,any>();
  return { room, snapshot, requests, gateway, details, c: { state, snapshot, gateway, id: 'known-plan', spoken: 0, now: 60000,
    audit:(kind:string,payload:any)=>{if(kind==='prediction-detail'||kind==='campaign-detail')details.set(payload.id,payload);} } };
}

test('draft failures return the shared safe code and reason for both immediate and scheduled execution', () => {
  const f = fixture();
  f.snapshot.observation.view.outposts[0]!.drillers = 41;
  f.snapshot.observation.view.self.drillers = 61;
  f.snapshot.observation.intel[0]!.drillers = 61;
  for (const issueTick of [100, 102]) {
    const result = forecastKnownObservation(f.snapshot.observation, 103, [{ id: 'poor-mine', issueTick, action: { kind: 'toggle-mine', outpostId: '蓝方工厂' } }]);
    assert.equal(result.status, 'conditional');
    if (result.status === 'conditional') {
      assert.equal(result.orders[0]!.status, 'failed'); assert.equal(result.orders[0]!.code, 'insufficient-drillers'); assert.match(result.orders[0]!.reason!, /驻兵不足/);
    }
  }
});

test('only observed military waiting fleets can be recalled for the AI defense assumption', () => {
  const f = fixture();
  f.room.state = submitFleetOrder(f.room.state, { id: 'enemy-waiting', player: 1, action: { kind: 'launch', source: '红方矿场', destination: '蓝方工厂', drillers: 10, delaySeconds: 3600 } }).state;
  const now = observation(f.room, 0, 'known-ai');
  const normal = forecastKnownObservation(now, 101), defending = forecastKnownObservation(now, 101, [], 'defend');
  assert.equal(normal.status, 'conditional'); assert.equal(defending.status, 'conditional');
  if (normal.status === 'conditional' && defending.status === 'conditional') {
    assert.ok(normal.result.fleets.some(f => f.id === 'enemy-waiting'));
    assert.ok(!defending.result.fleets.some(f => f.id === 'enemy-waiting'));
    assert.equal(defending.result.outposts.find(p => p.id === '红方矿场')!.drillers, 11);
    assert.ok(defending.result.assumptions.some(s => s.includes('recalled')));
  }
});

test('arrival and deployment estimates are derived from the same observed trajectories', () => {
  const f = fixture(), draft = { id: 'move', issueTick: 100, action: { kind: 'launch', source: '红方后方', destination: '蓝方工厂', drillers: 10 } };
  const preview = previewKnownDeployment(f.snapshot.observation, draft);
  f.room.state = submitFleetOrder(f.room.state, { id: draft.id, player: 0, action: { kind: 'launch', source: '红方后方', destination: '蓝方工厂', drillers: 10 } }).state;
  const estimates = estimateKnownArrivals(observation(f.room, 0, 'known-ai'));
  assert.equal(preview.status, 'conditional'); assert.equal(estimates.arrivals[0]!.arrivalTick, 'arrivalTick' in preview ? preview.arrivalTick : null);
});

test('gateway batch compatibility method is also observation-only and rejects invalid alternatives', async () => {
  const f = fixture(), gateway = new PlayerGateway('http://unused.invalid', 'unused', 'known-ai', 0, 2);
  gateway.request = async () => { throw Error('No simulation HTTP'); };
  const before = structuredClone(f.snapshot.observation);
  assert.deepEqual(await gateway.attackRoutes(f.snapshot.observation), attackRoutes(f.snapshot.observation));
  assert.deepEqual(f.snapshot.observation, before);
  const scenarios = [{ id: 'hold', targetTick: 110, drafts: [] }, { id: 'other', targetTick: 110, drafts: [] }];
  assert.deepEqual(await gateway.forecastBatch(f.snapshot.observation, scenarios), compareKnownObservations(f.snapshot.observation, scenarios));
  assert.throws(() => compareKnownObservations(f.snapshot.observation, [scenarios[0]!]));
  assert.throws(() => forecastKnownObservation(f.snapshot.observation, 110, [{ id: 'override', issueTick: 100, action: { kind: 'resign' } }]));
});
