import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlayerProtocolClient,PlayerProtocolClientError,MemoryProtocolClientStore} from '../packages/player-sdk/src/index.js';
import {sdkFixture} from './player-sdk-test-helpers.js';

for(const write of [false,true])for(const stage of ['fetch','body'] as const)test(`hard deadline settles hung ${stage} with ${write?'unknown write':'read-only'} outcome even when cancellation stalls`,async()=>{
 let aborted=false,cancelled=false,timings=0;
 const sdk=new PlayerProtocolClient({serverUrl:'http://127.0.0.1:1234',token:'synthetic',store:new MemoryProtocolClientStore(),expectedIdentity:{roomId:'synthetic-room',gamePlayer:0},timeoutMs:25,onRequestTiming:()=>{timings++;},fetch:async(_,init)=>{
  init!.signal!.addEventListener('abort',()=>{aborted=true;});
  if(stage==='fetch')return new Promise<Response>(()=>{});
  return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('{"partial":'));},cancel(){cancelled=true;return new Promise<void>(()=>{});}}));
 }});
 const request=(sdk as unknown as {request:(path:string,body?:unknown)=>Promise<unknown>}).request.bind(sdk),started=Date.now();
 await assert.rejects(write?request('/player/v2/commands',{}):request('/player/v2/sync'),(error:unknown)=>error instanceof PlayerProtocolClientError&&error.code==='TRANSPORT_UNCONFIRMED'&&error.outcome===(write?'unknown':'read-only'));
 assert.ok(Date.now()-started<2000);assert.equal(aborted,true);assert.equal(timings,1);assert.equal(cancelled,stage==='body');
});

test('a late body cannot apply a revision-conflict mutation after its deadline',async()=>{
 const store=new MemoryProtocolClientStore();store.transaction(s=>{s.needsSnapshot=false;});let finish!:()=>void;
 const sdk=new PlayerProtocolClient({serverUrl:'http://127.0.0.1:1234',token:'synthetic',store,expectedIdentity:{roomId:'synthetic-room',gamePlayer:0},timeoutMs:25,fetch:async()=>new Response(new ReadableStream<Uint8Array>({start(c){finish=()=>{try{c.enqueue(new TextEncoder().encode('{"code":"REVISION_CONFLICT","outcome":"rejected"}'));c.close();}catch{}};},cancel(){return new Promise<void>(()=>{});}}),{status:409})});
 const request=(sdk as unknown as {request:(path:string)=>Promise<unknown>}).request.bind(sdk);
 await assert.rejects(request('/player/v2/sync'),PlayerProtocolClientError);finish();await new Promise(r=>setImmediate(r));assert.equal(store.load().needsSnapshot,false);
});

function client(response:()=>Response){
 return new PlayerProtocolClient({serverUrl:'http://127.0.0.1:1234',token:'synthetic',store:new MemoryProtocolClientStore(),expectedIdentity:{roomId:'synthetic-room',gamePlayer:0},fetch:async()=>response()});
}
for(const write of [false,true])for(const failure of ['deadline','disconnect'])test(`HTTP 200 body ${failure} retains ${write?'unknown write':'read-only transport'} outcome`,async()=>{
 const sdk=client(()=>new Response(new ReadableStream<Uint8Array>({start(controller){
  controller.enqueue(new TextEncoder().encode('{"partial":'));
  queueMicrotask(()=>controller.error(failure==='deadline'?new DOMException('Synthetic body deadline','TimeoutError'):new TypeError('Synthetic disconnected stream')));
 }}),{status:200}));
 const request=(sdk as unknown as {request:(path:string,body?:unknown)=>Promise<unknown>}).request.bind(sdk);
 await assert.rejects(write?request('/player/v2/commands',{}):request('/player/v2/sync'),(error:unknown)=>error instanceof PlayerProtocolClientError&&error.code==='TRANSPORT_UNCONFIRMED'&&error.status===200&&error.outcome===(write?'unknown':'read-only'));
});
for(const [name,response] of [
 ['malformed JSON',()=>new Response('{broken')],
 ['invalid UTF-8',()=>new Response(new Uint8Array([255]))],
 ['oversized body',()=>new Response('x'.repeat(400000))],
] as const)test(`${name} still fails strict response validation`,async()=>{
 const sdk=client(response),request=(sdk as unknown as {request:(path:string)=>Promise<unknown>}).request.bind(sdk);
 await assert.rejects(request('/player/v2/control'),(error:unknown)=>error instanceof PlayerProtocolClientError&&error.code==='INVALID_RESPONSE');
});

test('an accepted write with a broken HTTP 200 body reconciles its original receipt without resending',async t=>{
 let writes=0;
 const x=await sdkFixture(t,{fetcher:async(input,init)=>{
  const response=await fetch(input,init);if(!String(input).endsWith('/commands'))return response;
  writes++;await response.arrayBuffer();
  return new Response(new ReadableStream({start(controller){controller.error(new TypeError('Synthetic accepted response disconnect'));}}),{status:200});
 }});
 await x.client.acquire();
 await assert.rejects(x.client.command(await x.intent('same-durable-intent')),(error:unknown)=>error instanceof PlayerProtocolClientError&&error.code==='TRANSPORT_UNCONFIRMED'&&error.outcome==='unknown');
 assert.equal(x.h.store.load()!.room.state.commands.length,1);
 assert.equal(Object.values(x.client.state.outbox)[0]!.state,'unknown');
 const [entry]=await x.client.reconcile();assert.equal(entry!.receipt!.state,'applied');
 assert.equal(writes,1);assert.equal(x.h.store.load()!.room.state.commands.length,1);
});

test('an accepted write with a hanging body reaches its hard deadline and reconciles without resending',async t=>{
 let writes=0;
 const x=await sdkFixture(t,{fetcher:async(input,init)=>{
  const response=await fetch(input,init);if(!String(input).endsWith('/commands'))return response;
  writes++;await response.arrayBuffer();
  return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){return new Promise<void>(()=>{});}}));
 }});
 await x.client.acquire();const intent=await x.intent('deadline-durable-intent');
 const options=(x.client as unknown as {options:{timeoutMs:number}}).options;options.timeoutMs=250;
 await assert.rejects(x.client.command(intent),(error:unknown)=>error instanceof PlayerProtocolClientError&&error.code==='TRANSPORT_UNCONFIRMED'&&error.outcome==='unknown');
 assert.equal(x.h.store.load()!.room.state.commands.length,1);assert.equal(Object.values(x.client.state.outbox)[0]!.state,'unknown');
 options.timeoutMs=15000;const [entry]=await x.client.reconcile();assert.equal(entry!.receipt!.state,'applied');assert.equal(writes,1);
});
