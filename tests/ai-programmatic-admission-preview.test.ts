import {commanderModelFactory} from './helpers/model-fixture.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelCallQueue,ModelAdmissionStale} from '../packages/ai/src/controller/runtime/model-queue.js';
import {SeatRunner} from './helpers/scripted-controller.js';
import {AiStore,initialState,executeTool,type AiSnapshot,type AgentRequest} from '../packages/ai/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {memoryConsistency} from '../packages/ai/src/controller/storage/memory-consistency.js';
import {createRoundWorkset,appendRoundReceipt} from '../packages/ai/src/controller/execution/round-workset.js';
import {emptyReceiptObservations,reduceReceiptJournal,receiptObservationKind} from '../packages/ai/src/controller/execution/receipt-observation.js';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const settle=()=>new Promise<void>(r=>setImmediate(r));
function fixture(path=':memory:'){
 const initial=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o=observation({state:createFleetScenario(initial),scheduled:[]},0,'room');
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,notebook:[],reminders:[]};
 const state=initialState('room',0,{model:'',personality:'schemer'}),store=new AiStore(path);
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No real writes');}};
 snapshot.memoryConsistency=memoryConsistency(state.memory,snapshot);
 return {snapshot,state,store,gateway};
}
test('queued stale admission never calls provider, releases slot, and preserves FIFO',async()=>{
 const q=new ModelCallQueue(1),hold=deferred(),signal=new AbortController().signal,order:string[]=[];
 const first=q.run(signal,()=>hold.promise);let sends=0;
 const stale=q.run(signal,async()=>{sends++;},{beforeSend:()=>{throw new ModelAdmissionStale('private-state');}});
 const rejected=assert.rejects(stale,e=>e instanceof ModelAdmissionStale&&e.sent===false);
 const next=q.run(signal,async()=>{order.push('next');});
 assert.equal(q.status.waiting,2);hold.resolve();await Promise.all([first,rejected,next]);
 assert.equal(sends,0);assert.deepEqual(order,['next']);assert.deepEqual(q.status,{limit:1,active:0,waiting:0});
});
test('admission abort and async validation failure release capacity without onSend',async()=>{
 const q=new ModelCallQueue(1),gate=deferred(),controller=new AbortController();let sent=0;
 const pending=q.run(controller.signal,async()=>{sent++;},{beforeSend:()=>gate.promise,onStart:()=>sent++});
 await settle();controller.abort();gate.resolve();await assert.rejects(pending);assert.equal(sent,0);assert.equal(q.status.active,0);
 await assert.rejects(q.run(new AbortController().signal,async()=>{}, {beforeSend:async()=>{throw Error('check failed');}}),/check failed/);
 assert.equal(q.status.active,0);
});
test('once provider starts a later stale condition never replays or reclassifies its result',async()=>{
 const q=new ModelCallQueue(1),hold=deferred();let checks=0,sends=0;
 const pending=q.run(new AbortController().signal,async()=>{sends++;await hold.promise;return 'accepted';},{beforeSend:()=>{checks++;}});
 await settle();hold.resolve();assert.equal(await pending,'accepted');assert.equal(checks,1);assert.equal(sends,1);
});
test('runner atomically commits new notes on the first finish without a review round trip',async()=>{
 const f=fixture();let calls=0;
 try{
  const provider={step:async()=>{calls++;return {tokens:0,reply:{tool:'finish',arguments:{notebook:{set:[{id:'n',kind:'fact',text:'Final fact'}]},memory:{strategy:'守矿'}},summary:'Finish'}};}};
  await new SeatRunner(f.state,f.store,f.gateway,provider).poll(0,true);
  assert.equal(calls,1);assert.equal(f.store.notebook('room',0,0)[0]!.text,'Final fact');
  assert.equal(f.state.memory.strategy,'守矿');assert.equal(f.store.memoryReviews('room',0).length,0);
  assert.equal(f.store.latest('room',0,'full-memory-review'),null);
 }finally{f.store.close();}
});

test('runtime audit commits preserve current memory atomically while explicit submissions retain last-writer-wins',()=>{
 const f=fixture();try{
  f.store.save(f.state);const stale=structuredClone(f.state);
  const latest={...f.state,memory:{...f.state.memory,strategy:'New strategy from another channel'}};
  f.store.save(latest,'memory-maintained',{seconds:0});
  const audited=f.store.saveEvents(stale,[{kind:'context-selected',details:{sequence:1}}],undefined,f.store.localWriteBasis('room',0),{preserveMemory:true});
  assert.equal(audited.memory.strategy,latest.memory.strategy);
  assert.equal(f.store.load('room',0)!.memory.strategy,latest.memory.strategy);
  assert.equal(f.store.latest('room',0,'memory-overwritten'),null);
  const submitted={...audited,memory:{...audited.memory,strategy:'Explicit later submission'}};
  f.store.saveEvents(submitted,[{kind:'memory-maintained',details:{seconds:0}}],undefined,f.store.localWriteBasis('room',0));
  assert.equal(f.store.load('room',0)!.memory.strategy,'Explicit later submission');
  assert.ok(f.store.latest('room',0,'memory-overwritten'));
 }finally{f.store.close();}
});
test('commander lane rebuilds an unsent observation inside its acquired queue slot without a retry',async()=>{
 const {CommanderWorker}=await import('../packages/ai/src/controller/runtime/commander-worker.js'),{CommanderStore}=await import('../packages/server/src/commander-store.js');
 const f=fixture(),threads=new CommanderStore(),q=new ModelCallQueue(1),hold=deferred(),occupying=q.run(new AbortController().signal,()=>hold.promise);let sends=0;
 const worker=new CommanderWorker({state:f.state,expectedPlayer:0,roster:()=>[],store:f.store,available:()=>true,onDirectives:()=>{},provider:commanderModelFactory(()=>({step:r=>q.run(r.signal,async()=>{sends++;assert.match(r.prompt,/commander-authoritative-revision/);return {tokens:0,reply:{tool:'finish',arguments:{},summary:'最新可见情况已核对。'}};},{interactive:true,...(r.beforeSend?{beforeSend:r.beforeSend}:{}),...(r.onSend?{onStart:r.onSend}:{})})})),transport:{request:async(path,data)=>{if(path==='/tool/observation')return structuredClone(f.snapshot.observation);assert.equal(path,'/tool/commander/worker');return data?threads.worker('room',0,data,f.snapshot.observation.view.tick):threads.read('room',0);}}});
 const drain=async()=>{for(let i=0;i<100&&worker.busy;i++)await settle();assert.equal(worker.busy,false);};
 try{
  await threads.send('room',0,{id:'question',text:'当前情况如何？',references:[]},f.snapshot.observation);worker.tick();
  for(let i=0;i<100&&q.status.waiting===0;i++)await settle();assert.equal(q.status.waiting,1);
  f.snapshot.observation.revision='commander-authoritative-revision';hold.resolve();await occupying;await drain();assert.equal(sends,1);
  assert.equal(threads.read('room',0).messages.length,2);assert.equal(f.store.latest('room',0,'commander-call-failed'),null);
  worker.tick(Date.now()+2000);await drain();assert.equal(sends,1);assert.equal(threads.read('room',0).messages.length,2);assert.ok(f.store.latest('room',0,'provider-request-sent'));
 }finally{hold.resolve();await worker.close();f.store.close();}
});
