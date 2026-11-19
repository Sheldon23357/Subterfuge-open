// Build first. Uses an isolated generated room; never reads or updates live saves.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createGeneratedRoom } from '../dist/packages/server/src/generated-room.js';
import { simulatePlayerFrame, simulatePlayerFuture, createPlayerFrameCache } from '../dist/packages/server/src/player-forecast.js';

const room = await createGeneratedRoom(8, 4300);
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rows = [];
for (const ticks of [1, 24, 72, 144]) {
  const full = [], fast = [];
  // Alternate execution order and discard warmup to reduce JIT/order bias.
  for (let round = 0; round < 8; round++) {
    let expected, actual;
    const measureFull = () => {
      const start = performance.now();
      expected = simulatePlayerFuture(room, 0, ticks);
      if (round >= 2) full.push(performance.now() - start);
    };
    const measureFast = () => {
      const start = performance.now();
      actual = simulatePlayerFrame(room, 0, ticks);
      if (round >= 2) fast.push(performance.now() - start);
    };
    if (round % 2) { measureFast(); measureFull(); }
    else { measureFull(); measureFast(); }
    assert.equal(actual.status, expected.status);
    if (actual.status === 'conditional') assert.deepEqual(actual.result, expected.result);
  }
  const fullMs = median(full), frameMs = median(fast);
  rows.push({ ticks, fullMs: +fullMs.toFixed(2), frameMs: +frameMs.toFixed(2), speedup: +(fullMs / frameMs).toFixed(2) });
}
console.log(JSON.stringify({ players: 8, outposts: room.state.economy.outposts.length, seed: room.map.seed, rows }, null, 2));

// Model a continuous scrub near the 12-hour mark. Compare the previous
// frame-only implementation to checkpoint reuse, including projection costs.
const scrub = [];
for (let round = 0; round < 5; round++) {
  const cached = createPlayerFrameCache(), oldTimes = [], newTimes = [];
  cached(room, 0, 72);
  for (let ticks = 73; ticks <= 84; ticks++) {
    let start = performance.now();
    const expected = simulatePlayerFrame(room, 0, ticks);
    oldTimes.push(performance.now() - start);
    start = performance.now();
    const actual = cached(room, 0, ticks);
    newTimes.push(performance.now() - start);
    assert.deepEqual(actual, expected);
  }
  if (round) scrub.push({ oldMs: median(oldTimes), checkpointMs: median(newTimes) });
}
const oldMs = median(scrub.map(r => r.oldMs)), checkpointMs = median(scrub.map(r => r.checkpointMs));
console.log(JSON.stringify({ continuousScrub: { fromTick: 73, toTick: 84, oldMs: +oldMs.toFixed(2), checkpointMs: +checkpointMs.toFixed(2), speedup: +(oldMs / checkpointMs).toFixed(2) } }, null, 2));
