import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlayerProtocolClient,type ProtocolClientStore} from '../packages/player-sdk/src/index.js';
import {SqliteProtocolClientStore} from '../packages/ai/src/controller/transport/protocol-store.js';
import {sdkFixture} from './player-sdk-test-helpers.js';
import type {ProtocolEvent,ProtocolEventPage} from '../packages/contracts/src/index.js';
for(const phase of ['before','after'] as const)test(`S0${phase==='before'?'5':'6'} SQLite event crash ${phase} durable commit recovers without duplicate application`,async t=>{
  let fail=false,base!:SqliteProtocolClientStore;const x=await sdkFixture(t,{store:path=>{base=new SqliteProtocolClientStore(path);return{load:()=>base.load(),transaction:<T>(apply:Parameters<ProtocolClientStore['transaction']>[0]):T=>{if(fail&&phase==='before'){fail=false;throw Error('synthetic before commit');}const before=base.load().cursor,result=base.transaction(apply);if(fail&&phase==='after'&&base.load().cursor!==before){fail=false;throw Error('synthetic caller acknowledgement lost after commit');}return result as T;}};}});
  let baseClosed=false,restoredStore:SqliteProtocolClientStore|undefined;try{
  await x.client.acquire();await x.client.command(await x.intent());const before=x.client.state.cursor;fail=true;
  const apply=(event:ProtocolEvent,state:Record<string,unknown>)=>{state.sequences=[...(state.sequences as string[]??[]),event.seq];};await assert.rejects(x.client.events(apply),/synthetic/);
  assert.equal(x.client.state.cursor===before,phase==='before');base.close();baseClosed=true;const store=restoredStore=new SqliteProtocolClientStore(x.path);const restored=new PlayerProtocolClient({...x.settings,store});await restored.connect();const committed=restored.state.cursor;const page=await restored.events(apply),sequences=restored.state.application.sequences as string[];
  assert.equal(page.inputCursor,committed);assert.ok(sequences.length>0);assert.equal(new Set(sequences).size,sequences.length);if(phase==='after')assert.equal(page.events.length,0);else assert.ok(page.events.length>0);assert.equal(restored.writable,false);
  }finally{if(!baseClosed)base.close();restoredStore?.close();}
});
test('S09 expired cursor resynchronizes read state without losing an unknown command',async t=>{
  let expire=false;const x=await sdkFixture(t,{fetcher:async(input,init)=>{if(String(input).endsWith('/commands'))throw Error('packet outcome unknown');if(expire&&String(input).includes('/events?'))return Response.json({code:'RESYNC_REQUIRED',category:'resync',outcome:'read-only',safeMessage:'Synthetic cursor expiry',requestId:'synthetic'},{status:409});return fetch(input,init);}});
  await x.client.acquire();await assert.rejects(x.client.command(await x.intent()));const saved=structuredClone(x.client.state.outbox);expire=true;await assert.rejects(x.client.events(),/RESYNC_REQUIRED/);assert.deepEqual(x.client.state.outbox,saved);expire=false;await x.client.snapshot();assert.deepEqual(x.client.state.outbox,saved);assert.equal((await x.client.reconcile())[0]!.state,'unknown');assert.equal(x.client.writable,false);
});
test('S10 unknown optional events advance a contiguous cursor but never invoke the application reducer',async t=>{
  const x=await sdkFixture(t,{fetcher:async(input,init)=>{const response=await fetch(input,init);if(!String(input).includes('/events?'))return response;const page=await response.json() as ProtocolEventPage,event:ProtocolEvent={scope:page.scope,streamEpoch:page.streamEpoch,seq:(BigInt(page.coverage.fromExclusive)+1n).toString(),cursor:'synthetic-optional-end',type:'future.optional',schemaVersion:1,required:false,payload:{}};return Response.json({...page,events:[event],nextCursor:event.cursor,coverage:{...page.coverage,toInclusive:event.seq}});}});
  await x.client.snapshot();let applied=0;await x.client.events(()=>{applied++;});assert.equal(applied,0);assert.equal(x.client.state.cursor,'synthetic-optional-end');assert.equal(x.client.state.safetyStop,null);
});
test('C09 applied receipt v3 remains authoritative when accepted v1 arrives later',async t=>{
  let lower=false;const x=await sdkFixture(t,{fetcher:async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith('/commands')){const body=await response.json();return Response.json({...body,receiptVersion:'3'});}if(lower&&String(input).endsWith('/commands/lookup')){const body=await response.json();for(const item of body.results)item.receipt={...item.receipt,receiptVersion:'1',state:'accepted',effectCommitted:false};return Response.json(body);}return response;}});
  await x.client.acquire();await x.client.command(await x.intent());x.store.transaction(state=>{Object.values(state.outbox)[0]!.state='unknown';});lower=true;await x.client.reconcile();const receipt=Object.values(x.client.state.outbox)[0]!.receipt!;assert.equal(receipt.receiptVersion,'3');assert.equal(receipt.state,'applied');assert.equal(receipt.effectCommitted,true);
});
test('C11 mixed-key ledger recovery reconciles each applied or unknown operation without replacing intent',async t=>{
  let count=0;const x=await sdkFixture(t,{fetcher:async(input,init)=>{if(String(input).endsWith('/commands')){count++;if(count===2)throw Error('second key outcome unknown');}return fetch(input,init);}});
  await x.client.acquire();await x.client.command(await x.intent('known-first'));await assert.rejects(x.client.command(await x.intent('unknown-second')));const before=structuredClone(x.client.state.outbox);const rows=await x.client.reconcile();assert.equal(rows.find(row=>row.request.idempotencyKey==='known-first')!.receipt!.state,'applied');assert.equal(rows.find(row=>row.request.idempotencyKey==='unknown-second')!.state,'unknown');assert.equal(count,2);
  x.h.elapsed+=31000;const retired=await x.client.reconcile();assert.equal(retired.find(row=>row.request.idempotencyKey==='unknown-second')!.state,'settled');for(const [key,row]of Object.entries(before))assert.deepEqual(x.client.state.outbox[key]!.request,row.request);assert.equal(x.h.store.load()!.room.state.commands.length,1);assert.equal(count,2);
});
