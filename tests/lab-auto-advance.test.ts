import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LabAutoAdvance } from '../packages/server/src/lab-auto-advance.js';
import { SerialExecutor } from '../packages/server/src/player-access.js';

test('service pulses advance immediately after AI convergence, without browser requests', async () => {
  let settled=false,tick=0;
  const clock=new LabAutoAdvance(new SerialExecutor(),async()=>{if(settled)tick++;});
  clock.setEnabled(true);
  await clock.pulse();await clock.pulse();assert.equal(tick,0);
  settled=true;await clock.pulse();assert.equal(tick,1);
  settled=false;await clock.pulse();assert.equal(tick,1,'new tick must converge independently');
  clock.setEnabled(true);settled=true;await clock.pulse();assert.equal(tick,2);
  clock.setEnabled(false);await clock.pulse();assert.equal(tick,2);
  clock.setEnabled(true);await clock.pulse();assert.equal(tick,3);
});

test('slow saves cannot overlap or queue duplicate pulses; stopping invalidates queued work', async () => {
  const serial = new SerialExecutor();
  let calls = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const clock = new LabAutoAdvance(serial, async () => { calls++; await held; });
  clock.setEnabled(true);
  const first = clock.pulse();
  await Promise.resolve();
  await clock.pulse(); await clock.pulse(); assert.equal(calls, 1);
  release(); await first;
  let unblock!: () => void;
  const blocker = serial.run(() => new Promise<void>(resolve => { unblock = resolve; }));
  await Promise.resolve();
  const queued = clock.pulse();
  clock.setEnabled(false); unblock(); await blocker; await queued;
  assert.equal(calls, 1);
});

test('advance failure stops the clock visibly and is not retried until explicitly enabled', async t => {
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  const clock = new LabAutoAdvance(new SerialExecutor(), async () => { calls++; throw Error('disk full'); });
  clock.setEnabled(true); await clock.pulse();
  assert.deepEqual(clock.status(), { enabled: false, error: 'disk full' });
  await clock.pulse(); assert.equal(calls, 1);
  clock.setEnabled(true); assert.deepEqual(clock.status(), { enabled: true, error: null });
  clock.stop();
});

test('pulse diagnostics separate queue and execution and cannot stop advancement',async()=>{
 const serial=new SerialExecutor();let release!:()=>void,advanced=0;
 const held=serial.run(()=>new Promise<void>(resolve=>{release=resolve;}));await Promise.resolve();
 const samples:{queueMs:number;executionMs:number;durationMs:number}[]=[];
 const clock=new LabAutoAdvance(serial,async()=>{advanced++;},sample=>{samples.push(sample);throw Error('diagnostic sink unavailable');});
 clock.setEnabled(true);const pulse=clock.pulse();release();await held;await pulse;
 assert.equal(advanced,1);assert.equal(samples.length,1);assert.ok(samples[0]!.queueMs>=0);assert.ok(samples[0]!.durationMs>=samples[0]!.queueMs+samples[0]!.executionMs);assert.equal(clock.status().error,null);
});
