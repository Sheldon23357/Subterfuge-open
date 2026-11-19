import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { PreviewFrames } from '../packages/client/src/preview-frames.js';

test('scrubbing coalesces positions, keeps one request in flight and reuses frames', async () => {
  const requests: number[] = [], shown: number[] = [];
  const pending: ((value: number) => void)[] = [];
  const frames = new PreviewFrames<number>((ticks) => {
    requests.push(ticks);
    return new Promise(resolve => pending.push(resolve));
  }, frame => shown.push(frame), () => {}, 0);
  try {
    frames.select(1); frames.select(2); frames.select(3);
    await wait(10);
    assert.deepEqual(requests, [3]);
    frames.select(4); frames.select(5);
    assert.deepEqual(requests, [3]);
    pending.shift()!(3);
    await wait(10);
    assert.deepEqual(requests, [3, 5]);
    frames.select(3); // Cached frame while request for 5 is still running.
    pending.shift()!(5);
    await wait(10);
    assert.equal(shown.at(-1), 3);
    frames.select(5);
    assert.equal(shown.at(-1), 5);
    await wait(10);
    assert.deepEqual(requests, [3, 5]);
  } finally { frames.dispose(); }
});

test('returning to NOW and disposing a revision suppress late responses', async () => {
  let complete!: (value: number) => void;
  let signal!: AbortSignal;
  const shown: number[] = [];
  const frames = new PreviewFrames<number>((_, s) => {
    signal = s;
    return new Promise(resolve => { complete = resolve; });
  }, frame => shown.push(frame), () => {}, 0);
  frames.select(1); await wait(10);
  frames.select(0); complete(1); await wait(10);
  assert.deepEqual(shown, []);
  frames.select(2); await wait(10);
  frames.dispose(); complete(2); await wait(10);
  assert.equal(signal.aborted, true);
  assert.deepEqual(shown, []);
});

test('preview cache is bounded and failed positions can be retried', async () => {
  const requests: number[] = [], errors: string[] = [];
  let fail = true;
  const frames = new PreviewFrames<number>(async ticks => {
    requests.push(ticks);
    if (ticks === 4 && fail) { fail = false; throw Error('retry'); }
    return ticks;
  }, () => {}, (_, error) => { if (error) errors.push(error); }, 0, 2);
  try {
    for (const tick of [1, 2, 3, 1, 4, 4]) {
      frames.select(tick); await wait(10);
    }
    assert.deepEqual(requests, [1, 2, 3, 1, 4, 4]);
    assert.deepEqual(errors, ['retry']);
  } finally { frames.dispose(); }
});

test('local scrubbing aborts old work and can immediately return to its cancelled target', async () => {
  const requests: number[] = [], shown: number[] = [], errors: string[] = [];
  const pending: ((value: number) => void)[] = [];
  const frames = new PreviewFrames<number>((ticks, signal) => {
    requests.push(ticks);
    return new Promise((resolve, reject) => {
      pending.push(resolve);
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    });
  }, frame => shown.push(frame), (_, error) => { if (error) errors.push(error); }, 0, 32, true);
  try {
    frames.select(1); await wait(10);
    frames.select(2); frames.select(1); await wait(10);
    assert.deepEqual(requests, [1, 1]);
    pending[1]!(1); await wait(10);
    assert.deepEqual(shown, [1]); assert.deepEqual(errors, []);
  } finally { frames.dispose(); }
});
