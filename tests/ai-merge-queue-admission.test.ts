import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ModelCallQueue,ModelAdmissionStale} from '../packages/ai/src/controller/runtime/model-queue.js';
import {ProviderError} from '../packages/ai/src/controller/contracts/provider-error.js';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
const turn=()=>new Promise<void>(r=>setImmediate(r));

test('merged queue records cancelled wait while retaining definitely-unsent outcome and zero admission callbacks',async()=>{
 const queue=new ModelCallQueue(1),hold=deferred(),occupying=queue.run(new AbortController().signal,()=>hold.promise);
 await turn();const controller=new AbortController(),waits:{ms:number;admitted:boolean}[]=[];let checked=0,sent=0;
 const pending=queue.run(controller.signal,async()=>{sent++;},{interactive:true,beforeSend:()=>{checked++;},onStart:()=>{sent++;},onQueueWait:(ms,admitted)=>waits.push({ms,admitted})});
 assert.equal(queue.status.waiting,1);const rejected=assert.rejects(pending,error=>error instanceof ProviderError&&error.outcome==='not-sent'&&error.code==='cancelled');
 controller.abort();await rejected;assert.equal(checked,0);assert.equal(sent,0);assert.equal(waits.length,1);assert.equal(waits[0]!.admitted,false);assert.ok(waits[0]!.ms>=0);
 hold.resolve();await occupying;assert.deepEqual(queue.status,{limit:1,active:0,waiting:0});
});

test('merged queue distinguishes admitted diagnostics from checked and sent boundaries and releases stale admission',async()=>{
 const queue=new ModelCallQueue(1),events:string[]=[];let sends=0;
 await assert.rejects(queue.run(new AbortController().signal,async()=>{sends++;},{onQueueWait:(_ms,admitted)=>events.push(`queue:${admitted}`),beforeSend:()=>{events.push('check');throw new ModelAdmissionStale('new-commander-authority');},onStart:()=>events.push('sent')}),error=>error instanceof ModelAdmissionStale&&error.sent===false);
 assert.deepEqual(events,['queue:true','check']);assert.equal(sends,0);assert.deepEqual(queue.status,{limit:1,active:0,waiting:0});
 await queue.run(new AbortController().signal,async()=>{events.push('provider');sends++;},{onQueueWait:(_ms,admitted)=>events.push(`queue:${admitted}`),beforeSend:async()=>{events.push('fresh-check');await turn();},onStart:()=>events.push('sent')});
 assert.deepEqual(events,['queue:true','check','queue:true','fresh-check','sent','provider']);assert.equal(sends,1);assert.deepEqual(queue.status,{limit:1,active:0,waiting:0});
});

test('merged queue cancellation during final authority check cannot turn admitted wait into a provider dispatch',async()=>{
 const queue=new ModelCallQueue(1),check=deferred(),controller=new AbortController(),events:string[]=[];
 const pending=queue.run(controller.signal,async()=>{events.push('provider');},{onQueueWait:(_ms,admitted)=>events.push(`queue:${admitted}`),beforeSend:()=>check.promise,onStart:()=>events.push('sent')});
 await turn();assert.deepEqual(events,['queue:true']);controller.abort();const rejected=assert.rejects(pending,error=>error instanceof ProviderError&&error.outcome==='not-sent');check.resolve();await rejected;
 assert.deepEqual(events,['queue:true']);assert.deepEqual(queue.status,{limit:1,active:0,waiting:0});
});
