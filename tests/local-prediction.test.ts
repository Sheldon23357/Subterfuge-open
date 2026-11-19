import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { build } from 'esbuild';
import { createKnownPrediction, previewKnownDeployment, type KnownPredictionDraft } from '../packages/prediction/src/index.js';
import { LocalPrediction, type PredictionWorker } from '../packages/client/src/local-prediction.js';
import { createFleetScenario, submitFleetOrder, advanceFleetScenario, type FleetSetup } from '../packages/engine/src/index.js';
import { observation } from '../packages/server/src/player-api.js';
import { advanceRoom, type LabRoom } from '../packages/server/src/planning.js';
import { scheduleOrder } from '../packages/server/src/scheduled-orders.js';
import type { PlayerObservation } from '../packages/contracts/src/index.js';

function setup() { return JSON.parse(fs.readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup; }
function knownRoom() {
  const cfg = setup();
  cfg.economy.outposts[2]!.owner = 0;

  return { state: createFleetScenario(cfg), scheduled: [] } as LabRoom;
}
function conditional(result: ReturnType<ReturnType<typeof createKnownPrediction>['predict']>) {
  assert.equal(result.status, 'conditional');
  if (result.status !== 'conditional') throw Error('Expected local frame');
  return result.result;
}

test('observation-only prediction uses original production, movement and combat without changing its inputs', () => {
  let room = knownRoom();
  room.state = submitFleetOrder(room.state, { id: 'attack', player: 0, action: { kind: 'launch', source: '蓝方工厂', destination: '红方矿场', drillers: 27 } }).state;
  const now = observation(room, 0, 'local'), before = JSON.stringify(now), saved = JSON.stringify(room);
  const local = createKnownPrediction(now);
  for (const tick of [101, 102, 103, 110, 104, 111]) {
    const predicted = conditional(local.predict(tick));
    const expected = observation(advanceRoom(room, tick, true), 0, 'local');
    for (const post of expected.view.outposts.filter(p => p.visibility === 2)) {
      if (!('drillers' in post)) continue;
      const actual = predicted.outposts.find(p => p.id === post.id)!;
      assert.equal(actual.drillers, post.drillers, `${tick}/${post.id} troops`);
      assert.equal(actual.shield, post.shield, `${tick}/${post.id} shield`);
    }
    assert.deepEqual(predicted.fleets.map(f => [f.id, f.position, f.drillers]), expected.view.fleets.map(f => [f.id, f.position, f.drillers]));
  }
  assert.equal(JSON.stringify(now), before); assert.equal(JSON.stringify(room), saved);
});

test('unknown nodes stay unknown on arrival and no placeholder becomes an undefended conquest', () => {
  const cfg = setup(); cfg.size = { width: 80, height: 80 };
  cfg.positions['红方矿场'] = { x: 25, y: 0 }; cfg.positions['红方后方'] = { x: 35, y: 0 };
  const room: LabRoom = { state: submitFleetOrder(createFleetScenario(cfg), { id: 'blind', player: 0, action: {
    kind: 'launch', source: '蓝方工厂', destination: '红方矿场', drillers: 27,
  } }).state, scheduled: [] };
  const now = observation(room, 0, 'blind'), local = createKnownPrediction(now);
  assert.equal(now.view.outposts[1]!.visibility, 0);
  const frame = conditional(local.predict(1000)), unknown = frame.outposts.find(p => p.id === '红方矿场')!;
  assert.equal(unknown.visibility, 0); assert.equal('drillers' in unknown, false); assert.equal('shield' in unknown, false);
  assert.equal(unknown.owner, 1); assert.ok(frame.unknownArrivals.some(a => a.fleetId === 'blind'));
  assert.equal('match' in frame, false);
});

test('hidden economics and actor slots cannot influence a local result', () => {
  const cfg = setup(); cfg.size = { width: 80, height: 80 };
  cfg.positions['红方矿场'] = { x: 30, y: 30 }; cfg.positions['红方后方'] = { x: 35, y: 35 };
  const room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
  const a = observation(room, 0, 'hidden');
  room.state.economy.outposts[1]!.miningProgress += 1;
  room.state.subCounters[1] = 77;

  const b = observation(room, 0, 'hidden');
  // Revisions can differ for public changes; here the hidden timers are absent.
  assert.deepEqual(a, b);
  assert.deepEqual(createKnownPrediction(a).predict(144), createKnownPrediction(b).predict(144));
  const output = JSON.stringify(createKnownPrediction(a).predict(144));
  for (const key of ['retainedWorld', 'visibleRuntime', 'subCounters', 'specialistSlots', 'recruitmentSeed']) assert.equal(output.includes('"' + key + '"'), false);
});

test('known schedules preserve reservations but reject cancellation exactly at departure deadline', () => {
  let room = knownRoom();
  room = scheduleOrder(room, { order: { id: 'later', player: 0, action: { kind: 'launch', source: '蓝方工厂', destination: '红方矿场', drillers: 10 } }, issueTick: 102 });
  room = scheduleOrder(room, { order: { id: 'cancel', player: 0, action: { kind: 'cancel-launch', fleetId: 'later' } }, issueTick: 103 });
  const now = observation(room, 0, 'plans'), local = createKnownPrediction(now);
  const launched = local.predict(102); assert.equal(conditional(launched).fleets[0]!.drillers, 10);
  const cancelled = local.predict(103); assert.equal(conditional(cancelled).fleets.length, 1);
  if (cancelled.status === 'conditional') assert.notEqual(cancelled.orders.find(p=>p.id==='cancel')!.status,'executed');
  assert.deepEqual(local.predict(102), createKnownPrediction(now).predict(102));
});

test('foreign scheduled activity cannot change owner-only local predictions', () => {
  let room = knownRoom(); room = advanceRoom(room, 500);
  delete room.state.initial.match;room.state.economy.initial.teamSize=2;room.state.activity=room.state.economy.players.map(()=>({lastCheckinTime:500*600,inactivityWarningCount:0,autoResigned:false}));
  room=scheduleOrder(room,{order:{id:'ally-check-in',player:1,action:{kind:'check-in'}},issueTick:503});
  const observed=observation(room,0,'local-activity'),before=structuredClone(observed);
  const local = createKnownPrediction(observed),ownOnly=createKnownPrediction({...observed,scheduled:observed.scheduled.filter(p=>p.player===0)});
  assert.equal(local.predict(502).status, 'conditional');
  assert.deepEqual(local.predict(503),ownOnly.predict(503));
  assert.equal(local.predict(501).status, 'conditional');
  assert.deepEqual(observed,before);
});

test('an unresolved visible pursuit contact keeps its last known position without inventing a hidden target', () => {
  const now = observation(knownRoom(), 0, 'unknown-route');
  now.view.fleets.push({ id: 'contact', owner: 1, position: { x: 1, y: 0 }, drillers: 25, state: 'moving', gift: false, destination: null });
  const frame = conditional(createKnownPrediction(now).predict(105));
  assert.deepEqual(frame.fleets.find(f => f.id === 'contact')!.position, { x: 1, y: 0 });
});

test('browser worker bundle runs on another thread, supports cancellation and resets its seat context', async () => {
  const bundle = await build({ entryPoints: ['packages/client/src/prediction-worker.ts'], platform: 'browser', bundle: true, write: false, format: 'esm' });
  const code = bundle.outputFiles[0]!.text;
  // Browser worker adapter: execute the actual browser bundle in a real Node
  // worker thread; only the message transport is adapted, no simulation mock.
  const createWorker = (): PredictionWorker => {
    const worker = new NodeWorker(`const {parentPort}=require('node:worker_threads');
      globalThis.postMessage=data=>parentPort.postMessage(data);let ready=false;const queued=[];
      parentPort.on('message',data=>ready?globalThis.onmessage({data}):queued.push(data));
      import(${JSON.stringify('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))}).then(()=>{
        ready=true;for(const data of queued)globalThis.onmessage({data});
      });`, { eval: true });
    const bridge: PredictionWorker = { onmessage: null, onerror: null,
      postMessage: message => worker.postMessage(message), terminate: () => { void worker.terminate(); } };
    worker.on('message', data => bridge.onmessage?.({ data } as MessageEvent));
    worker.on('error', error => bridge.onerror?.({ message: error.message } as ErrorEvent));
    return bridge;
  };
  const client = new LocalPrediction(createWorker), now: PlayerObservation = observation(knownRoom(), 0, 'worker');
  const isolated = createWorker(), draft: KnownPredictionDraft = {
    id: 'local-deployment', issueTick: now.view.tick,
    action: { kind: 'launch', source: '蓝方工厂', destination: '红方矿场', drillers: 1 }
  };
  try {
    const result = new Promise<unknown>((resolve, reject) => {
      isolated.onmessage = event => {
        const value = event.data;
        if ('error' in value) reject(Error(value.error));
        else if ('deployment' in value) resolve(value.deployment);
        else reject(Error('Wrong worker response'));
      };
      isolated.onerror = event => reject(Error(event.message));
    });
    isolated.postMessage({ kind: 'deploy', id: 90, observation: now, draft });
    assert.deepEqual(await result, { ...previewKnownDeployment(now, draft), roomId: now.roomId, revision: now.revision });
  } finally { isolated.terminate(); }
  try {
    assert.deepEqual(await client.predict(now, 103), createKnownPrediction(now).predict(103));
    const controller = new AbortController(), cancelled = client.predict(now, 1540, controller.signal);
    const rejected = assert.rejects(cancelled, { name: 'AbortError' }); controller.abort();
    assert.deepEqual(await client.predict(now, 104), createKnownPrediction(now).predict(104)); await rejected;
    const old = client.predict(now, 1540), stale = assert.rejects(old, { name: 'AbortError' });
    const other = observation(knownRoom(), 1, 'another-room');
    const frame = await client.predict(other, 105); await stale;
    assert.equal(conditional(frame).player, 1); assert.equal(frame.roomId, 'another-room');
  } finally { client.dispose(); }
});
