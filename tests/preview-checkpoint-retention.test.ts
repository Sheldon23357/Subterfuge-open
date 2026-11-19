import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retainPredictionCheckpoint } from '../packages/prediction/src/prediction-checkpoints.js';

test('future checkpoints keep twelve distributed states and four recent cancellation bases', () => {
  const points = new Map<number, number>();
  for (let tick = 8; tick <= 1440; tick += 8) {
    retainPredictionCheckpoint(points, tick, tick);
    assert.ok(points.size <= 12);
    assert.ok(points.has(tick));
    for (let n = 1; n <= 3 && tick > n * 8; n++) assert.ok(points.has(tick - n * 8));
  }
  assert.ok(points.has(8));
  assert.ok([...points.keys()].some(tick => tick > 400 && tick < 900));
  // A new backward branch must protect its recent points, not only high ticks.
  retainPredictionCheckpoint(points, 401, 401);
  retainPredictionCheckpoint(points, 409, 409);
  assert.ok(points.has(401)); assert.ok(points.has(409));
  retainPredictionCheckpoint(points, 409, 409);
  assert.equal(points.size, 12);
});
