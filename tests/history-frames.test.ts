import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { HistoryFrames } from '../packages/client/src/history-frames.js';

test('history coalesces absolute ticks including zero and reuses completed frames', async () => {
  const calls: number[] = [], shown: number[] = [];
  const frames = new HistoryFrames<number>(async tick => { calls.push(tick); return tick; }, frame => shown.push(frame), () => {}, 0);
  for (let tick = 40; tick >= 0; tick--) frames.select(tick);
  await wait(10); assert.deepEqual(calls, [0]); assert.deepEqual(shown, [0]);
  frames.select(12); await wait(10); frames.select(0);
  assert.deepEqual(calls, [0, 12]); assert.equal(shown.at(-1), 0);
  frames.dispose();
});

test('history supersession and NOW/room disposal suppress old frames', async () => {
  const calls: number[] = [], shown: number[] = [], pending: Array<() => void> = [];
  const frames = new HistoryFrames<number>((tick, signal) => {
    calls.push(tick);
    return new Promise((resolve, reject) => {
      pending.push(() => resolve(tick));
      signal.addEventListener('abort', () => reject(new DOMException('cancelled','AbortError')), { once: true });
    });
  }, tick => shown.push(tick), () => {}, 0);
  frames.select(100); await wait(10);
  frames.select(50); frames.select(60); await wait(10);
  pending[0]!(); pending[1]!(); await wait(10);
  assert.deepEqual(calls, [100, 60]); assert.deepEqual(shown, [60]);
  frames.select(90); await wait(10); frames.dispose(); pending[2]!(); await wait(10);
  assert.deepEqual(shown, [60]);
});

test('continuous history selections do not postpone the first frame forever', async () => {
  const calls: number[] = [];
  const frames = new HistoryFrames<number>(async tick => { calls.push(tick); return tick; }, () => {}, () => {}, 16);
  for (let tick = 1; tick <= 12; tick++) { frames.select(tick); await wait(4); }
  assert.ok(calls.length >= 2); await wait(25); assert.equal(calls.at(-1),12);
  frames.dispose();
});
