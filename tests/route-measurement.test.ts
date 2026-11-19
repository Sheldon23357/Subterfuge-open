import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RouteMeasurement} from '../packages/client/src/route-measurement.js';

test('continuous movement samples the latest position while the pointer is still moving', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const measurement = new RouteMeasurement();
  const calls: number[] = [], results: number[] = [];
  const request = (x: number) => measurement.schedule({
    source: 'origin', point: {x, y: 0}, tick: 0,
    estimate: async (_source, point) => {
      calls.push(point.x);
      return {minutes: point.x, arrivalTick: point.x};
    },
    result: value => results.push(value.minutes!),
    error: () => assert.fail('unexpected estimate error'),
  });
  for (let x = 0; x < 21; x++) {
    request(x);
    t.mock.timers.tick(10);
    await Promise.resolve();
  }
  assert.deepEqual(calls, [6, 13, 20]);
  assert.deepEqual(results, calls);
  // Remaining snapped onto one outpost must not repeat the same work.
  request(20);
  t.mock.timers.tick(700);
  assert.equal(calls.length, 3);
  measurement.cancel();
});

test('superseded and cancelled asynchronous estimates cannot replace the current result', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const measurement = new RouteMeasurement();
  type Value = {minutes: number; arrivalTick: number};
  const pending: {signal: AbortSignal; resolve: (value: Value) => void; reject: (reason: Error) => void}[] = [];
  const results: number[] = [];
  const request = (x: number) => measurement.schedule({
    source: 'origin', point: {x, y: 0}, tick: 0,
    estimate: (_source, _point, _tick, signal) => new Promise<Value>((resolve, reject) => pending.push({signal, resolve, reject})),
    result: value => results.push(value.minutes!),
    error: () => assert.fail('stale error must be ignored'),
  });
  request(1); t.mock.timers.tick(70);
  request(2); t.mock.timers.tick(70);
  assert.equal(pending[0]!.signal.aborted, true);
  pending[1]!.resolve({minutes: 2, arrivalTick: 2});
  await Promise.resolve();
  pending[0]!.reject(Error('old request failed'));
  await Promise.resolve();
  assert.deepEqual(results, [2]);
  request(3); t.mock.timers.tick(70);
  measurement.cancel();
  assert.equal(pending[2]!.signal.aborted, true);
  pending[2]!.resolve({minutes: 3, arrivalTick: 3});
  await Promise.resolve();
  request(4); measurement.cancel(); t.mock.timers.tick(70);
  assert.equal(pending.length, 3);
  assert.deepEqual(results, [2]);
});

test('a failed estimate can be retried at the same point', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const measurement = new RouteMeasurement();
  let attempts = 0, errors = 0;
  const request = {
    source: 'origin', point: {x: 1, y: 0}, tick: 0,
    estimate: async () => { attempts++; throw Error('unavailable'); },
    result: () => assert.fail('unexpected result'),
    error: () => { errors++; },
  };
  measurement.schedule(request); t.mock.timers.tick(70); await Promise.resolve();
  measurement.schedule(request); t.mock.timers.tick(70); await Promise.resolve();
  assert.equal(attempts, 2);
  assert.equal(errors, 2);
  measurement.cancel();
});
