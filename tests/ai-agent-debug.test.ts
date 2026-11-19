import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WriteBreakpointGate,DebugStopError} from '../packages/ai/src/controller/execution/agent-debug.js';
const context=(controller=new AbortController())=>({turn:'turn1',revision:'revision1',deadline:Date.now()+10000,signal:controller.signal});
test('write breakpoint is finite, cancellable and cannot be resumed twice',async()=>{
  const gate=new WriteBreakpointGate();gate.enabled=true;
  const pending=gate.beforeWrite('/tool/order',{order:{id:'same-id'}},context());let sent=false;void pending.then(()=>{sent=true;});
  const id=gate.status().pending!.id;assert.equal(sent,false);
  await gate.resume(id,async()=>{});await pending;assert.equal(sent,true);await assert.rejects(gate.resume(id,async()=>{}));
  const abort=new AbortController(),cancelled=gate.beforeWrite('/tool/chat',{text:'hello'},context(abort));abort.abort();await assert.rejects(cancelled,DebugStopError);
  gate.ttlMs=100;const expired=gate.beforeWrite('/tool/order',{},context());await assert.rejects(expired,e=>e instanceof DebugStopError&&e.reason==='expired');
});
test('stale revalidation destroys the candidate without releasing a write',async()=>{
  const gate=new WriteBreakpointGate();gate.enabled=true;const pending=gate.beforeWrite('/tool/schedule',{},context());const rejection=assert.rejects(pending,DebugStopError);
  await assert.rejects(gate.resume(gate.status().pending!.id,async()=>{throw new DebugStopError('stale');}),DebugStopError);await rejection;
  assert.equal(gate.status().pending,null);assert.equal(gate.status().last!.reason,'stale');
});
test('malformed or unavailable control validation is a fatal boundary, never ordinary tool feedback',async()=>{
  const gate=new WriteBreakpointGate();gate.enabled=true;
  const pending=gate.beforeWrite('/tool/order',{},context()),rejected=assert.rejects(pending,e=>e instanceof DebugStopError&&e.reason==='control-lost');
  await assert.rejects(gate.resume(gate.status().pending!.id,async()=>{throw Error('Invalid control protocol');}),DebugStopError);
  await rejected;assert.equal(gate.status().last!.outcome,'not-sent');
});
