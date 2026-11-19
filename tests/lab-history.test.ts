import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFleetScenario, submitFleetOrder, advanceFleetScenario, exportFleetReplay, projectPlayerHistory, replayFleetScenario, createFleetReplaySession, type FleetSetup } from '../packages/engine/src/index.js';
import { replayLabHistory, createLabHistory } from '../packages/prediction/src/index.js';
import { Worker } from 'node:worker_threads';

function fixture() {
  const setup = JSON.parse(fs.readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup;
  let state = createFleetScenario(setup);
  state = submitFleetOrder(state, { id: 'historical-launch', player: 0, action: {
    kind: 'launch', source: setup.economy.outposts[0]!.id, destination: setup.economy.outposts[1]!.id, drillers: 27,
  } }).state;
  const past = advanceFleetScenario(state, 110);
  state = advanceFleetScenario(past, 120);
  state = submitFleetOrder(state, { id: 'later-shields', player: 0, action: { kind: 'set-shields', outpostId: setup.economy.outposts[0]!.id, enabled: false } }).state;
  return { state, past, input: { replay: exportFleetReplay(state) } };
}
test('lab history reconstructs earlier armies and events without executing later orders or changing live state', () => {
  const { state, past, input } = fixture(), before = JSON.stringify(state), source = JSON.stringify(input);
  const result = replayLabHistory(input, 110, -1);
  assert.ok('global' in result);
  assert.equal(result.global.tick, 110);
  assert.deepEqual(result.global.outposts.map(o => [o.id, o.owner, o.drillers, o.shieldsEnabled]), past.economy.outposts.map(o => [o.id, o.owner, o.drillers, o.shieldsEnabled]));
  assert.ok(result.global.events.every(e => e.tick <= 110));
  assert.equal(result.global.orders?.length, 0);
  assert.equal(JSON.stringify(state), before);
  assert.equal(JSON.stringify(input), source);
});
test('lab seat history uses the historical fog and public statistics, rather than present-day visibility', () => {
  const { state, input } = fixture();
  for (const player of [0, 1]) {
    const result = replayLabHistory(input, 110, player), expected = projectPlayerHistory(state, player, 110);
    assert.ok('player' in result);
    assert.deepEqual(result.player, expected.view);
    assert.deepEqual(result.intel, expected.intel);
    assert.ok(result.player.outposts.filter(o => o.visibility !== 2).every(o => !('drillers' in o)));
  }
});
test('history stops at the actual scenario start and exported head', () => {
  const { input } = fixture();
  for (const target of [99, 121, -1, 110.5]) assert.throws(() => replayLabHistory(input, target, -1), /历史范围/);
  assert.ok('global' in replayLabHistory(input, 100, -1));
  assert.ok('global' in replayLabHistory(input, 120, -1));
});

test('checkpoint replay preserves same-tick phases, command order and journals when seeking backwards', () => {
  const setup = JSON.parse(fs.readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup;
  const id = setup.economy.outposts[0]!.id;
  let state = createFleetScenario(setup);
  state = submitFleetOrder(state, { id: 'off', player: 0, action: { kind: 'set-shields', outpostId: id, enabled: false } }, 100).state;
  state = submitFleetOrder(state, { id: 'on', player: 0, action: { kind: 'set-shields', outpostId: id, enabled: true } }, 101).state;
  state = advanceFleetScenario(state, 140);
  state = submitFleetOrder(state, { id: 'late-off', player: 0, action: { kind: 'set-shields', outpostId: id, enabled: false } }, 250).state;
  state = advanceFleetScenario(state, 260);
  const input = { replay: exportFleetReplay(state) }, before = JSON.stringify(input), session = createFleetReplaySession(input.replay), history = createLabHistory(input);
  session.begin(250); session.step(); // Superseded before completion.
  for (const target of [260, 200, 201, 140, 100, 260, 160, 141]) {
    session.begin(target); while (!session.step());
    const expected = replayFleetScenario({ ...input.replay, targetTick: target, commands: input.replay.commands.filter(c => c.tick <= target) });
    assert.deepEqual(session.snapshot(), expected);
    for (const seat of [-1, 0, 1]) {
      history.begin(target, seat); while (!history.step());
      assert.deepEqual(history.result(), replayLabHistory(input, target, seat));
    }
  }
  assert.equal(JSON.stringify(input), before);
});

test('completed history frames and nearby checkpoints avoid reprocessing the opening and have bounded memory', () => {
  const { input } = fixture(); input.replay.targetTick = 300;
  const session = createLabHistory(input);
  const frame = (target: number) => { session.begin(target, -1); while (!session.step()); return session.result(); };
  frame(250); const cold = session.stats();
  frame(251); assert.equal(session.stats().advancedTicks - cold.advancedTicks, 1);
  const beforeRepeat = session.stats();
  const repeated = frame(250); assert.ok('global' in repeated); repeated.global.tick = -1;
  assert.equal(session.stats().advancedTicks, beforeRepeat.advancedTicks);
  const unchanged = frame(250); assert.ok('global' in unchanged); assert.equal(unchanged.global.tick, 250);
  for (let target = 100; target < 150; target++) frame(target);
  assert.ok(session.stats().checkpoints <= 24);
  assert.ok(session.stats().frames <= 32);
  assert.ok(session.stats().cacheHits >= 2);
});

test('persistent history worker cancels an old seek and accepts the next seek without resending the replay', async () => {
  const { input } = fixture(); input.replay.targetTick = 1000;
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    globalThis.postMessage=reply=>parentPort.postMessage(reply);
    import(workerData.module).then(()=>{
      parentPort.on('message',data=>globalThis.onmessage({data}));
      parentPort.postMessage({ready:true});
    });
  `, { eval: true, workerData: { module: new URL('../packages/client/src/lab-history-worker.js', import.meta.url).href } });
  try {
    const replies: any[] = [];
    const progress: number[] = [];
    const final = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('History worker timed out')), 10000);
      worker.on('error', error => { clearTimeout(timer); reject(error); });
      worker.on('message', reply => {
        if ('progress' in reply) { if (reply.id === 2) progress.push(reply.progress); return; }
        if (reply.ready) {
          worker.postMessage({ kind: 'read', id: 1, input, targetTick: 1000, player: 0 });
          worker.postMessage({ kind: 'cancel', id: 1 });
          worker.postMessage({ kind: 'read', id: 2, targetTick: 150, player: 0 });
        } else if (reply.id === 2) {
          replies.push(reply);
          worker.postMessage({ kind: 'read', id: 3, targetTick: 151, player: 0 });
        } else { replies.push(reply); clearTimeout(timer); resolve(reply); }
      });
    });
    assert.deepEqual(replies.map(r => r.id), [2, 3]);
    assert.ok(progress.length > 0);
    assert.ok(progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1]!)));
    assert.deepEqual(final.frame, replayLabHistory(input, 151, 0));
  } finally { await worker.terminate(); }
});
