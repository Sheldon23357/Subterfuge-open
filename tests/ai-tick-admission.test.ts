import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';import {AiStore,initialState,type AiSnapshot} from '../packages/ai/src/index.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import type {BotMode} from '../packages/ai/src/controller/contracts/bot-mode.js';
import {runnerTestRuntime} from './helpers/runner-harness.js';
import {resumeSeatState} from '../packages/ai/src/controller/runtime/seat-lifecycle.js';
import {makeTask} from '../packages/ai/src/controller/runtime/decision.js';

function fixture(backgroundChat=false,beforeFinish?:()=>Promise<void>){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const store=new AiStore(':memory:'),state=initialState('tick-admission',0,{model:'',personality:'sentinel',provider:'offline'});
 const snapshot:AiSnapshot={observation:observation({state:createFleetScenario(setup),scheduled:[]},0,state.roomId),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 let rounds=0,withdrawals=0;const ingested:string[]=[];
 const mode:BotMode={...hybridMode,backgroundHandlesChat:backgroundChat,needsAnalysis:()=>false,
  ...(backgroundChat?{createBackground:()=>({observe:(s:Readonly<AiSnapshot>)=>{ingested.push(...s.chat.map(m=>m.id));},settling:false,pause:()=>{},drain:async()=>{}})}:{}),
  prepare:input=>({...hybridMode.prepare(input),run:async(request,services)=>{
   await request.beforeSend?.();services.markAssessed();rounds++;await beforeFinish?.();
   return{tokens:0,reply:{tool:'finish',arguments:{},summary:'done'}};
  }}),
 };
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No writes expected');}};
 const makeRunner=()=>new SeatRunner(state,store,gateway,{step:async()=>{throw Error('No model expected');}},1,{},()=>mode);
 const options={oneRoundPerTick:true,eventCoalesceMs:1,beforeDecision:async()=>{withdrawals++;}};
 return{snapshot,state,store,gateway,makeRunner,options,ingested,rounds:()=>rounds,withdrawals:()=>withdrawals};
}

for(const changedTick of [false,true])test(`fixed planning input ${changedTick?'defers a new tick':'ignores same-tick revisions and messages'}`,async()=>{
 let release!:()=>void,entered!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
 const f=fixture(false,async()=>{entered();await held;}),runner=f.makeRunner();
 let reads=0;const read=f.gateway.snapshot;f.gateway.snapshot=async()=>{reads++;return read();};
 try{
  const decision=runner.poll(0,false,false,f.options);await began;
  assert.equal(reads,1,'planning admission does not fetch the same tick again');
  f.snapshot.observation.revision='concurrent-change';
  if(changedTick)f.snapshot.observation.view.tick++;
  f.snapshot.chat=[{id:'during-compute',from:1,to:0,text:'new message',tick:f.snapshot.observation.view.tick,sentAt:0}];f.snapshot.chatCursor=1;
  runnerTestRuntime(runner).signals.set('late-threat',{key:'late-threat',kind:'fleet-state-change',category:'military',reason:'new threat after input was fixed',entities:[],urgent:true});
  await runner.poll(10,false,true,{observeOnly:true});release();await decision;
  assert.equal(f.state.error,null);assert.equal(f.rounds(),1);
  assert.equal(f.store.latest(f.state.roomId,0,'queued-stale-before-send'),null);
  assert.equal(f.store.latest<{reason:string}>(f.state.roomId,0,'completed')?.reason,changedTick?'stale-deferred':'finished');
  if(!changedTick){
   await runner.poll(20,false,true,f.options);assert.ok(runner.advanceReadiness());assert.equal(f.rounds(),1);
   assert.ok(runnerTestRuntime(runner).signals.has('late-threat'));assert.equal(f.state.chatCursor,0);
   f.snapshot.observation.view.tick++;f.snapshot.observation.revision='next-tick';
  }
  await runner.poll(30,false,false,f.options);await runner.poll(31,false,false,f.options);
  assert.equal(f.rounds(),2);
 }finally{release();runner.pause();f.store.close();}
});

test('one foreground admission per tick survives new causes, restart and deferred readiness',async()=>{
 const f=fixture();let runner=f.makeRunner();
 try{
  await runner.poll(0,false,false,f.options);assert.equal(f.rounds(),1);assert.equal(f.state.error,null);
  runnerTestRuntime(runner).signals.set('background-update',{key:'background-update',kind:'campaign-review',category:'strategy',reason:'new strategy',entities:[],urgent:true});
  f.snapshot.chat=[{id:'late-message',from:1,to:0,text:'new proposal',tick:f.snapshot.observation.view.tick,sentAt:0}];f.snapshot.chatCursor=1;
  await runner.poll(10,false,false,f.options);
  assert.equal(f.rounds(),1);assert.equal(f.withdrawals(),1);assert.ok(runner.advanceReadiness());
  assert.equal(f.store.latest(f.state.roomId,0,'interrupted-round-deferred'),null,'ordinary completed rounds need no interruption audit');
  assert.ok(runnerTestRuntime(runner).signals.has('background-update'));
  runner=f.makeRunner();await runner.poll(20,false,false,f.options);
  assert.equal(f.rounds(),1,'restart cannot reopen the same tick');assert.ok(runner.advanceReadiness());
  f.snapshot.observation.view.tick++;f.snapshot.observation.revision='next-tick';
  await runner.poll(30,false,false,f.options);await runner.poll(31,false,false,f.options);
  assert.equal(f.rounds(),2);assert.equal(f.withdrawals(),2);
  const task=f.store.latest<{reasons:string[]}>(f.state.roomId,0,'started');assert.ok(task?.reasons.includes('收到新消息'));
 }finally{runner.pause();f.store.close();}
});

test('a quiet tick closes durably before readiness and late causes wait for the next tick',async()=>{
 const f=fixture();let runner=f.makeRunner();
 try{
  await runner.poll(0,false,true,f.options);assert.equal(f.rounds(),1);
  f.snapshot.observation.view.tick++;f.snapshot.observation.revision='quiet-tick';
  await runner.poll(10,false,true,f.options);assert.equal(f.rounds(),1);assert.ok(runner.advanceReadiness());
  const tick=f.snapshot.observation.view.tick;runner.closeForeground(tick);runner.closeForeground(tick);
  assert.equal(f.store.history(f.state.roomId,0).filter(row=>row.kind==='foreground-closed').length,1);
  runnerTestRuntime(runner).signals.set('late',{key:'late',kind:'campaign-review',category:'strategy',reason:'published after closure',entities:[],urgent:true});
  await runner.poll(20,false,true,f.options);assert.equal(f.rounds(),1);assert.ok(runner.advanceReadiness());
  runner=f.makeRunner();await runner.poll(30,false,true,f.options);assert.equal(f.rounds(),1);assert.ok(runner.advanceReadiness());
  assert.ok(runnerTestRuntime(runner).signals.has('late'));
  f.snapshot.observation.view.tick++;f.snapshot.observation.revision='following-tick';
  await runner.poll(40,false,true,f.options);await runner.poll(41,false,true,f.options);assert.equal(f.rounds(),2);
 }finally{runner.pause();f.store.close();}
});

test('pause and same-tick resume retire the idle round marker durably without reopening planning',async()=>{
 let release!:()=>void,entered!:()=>void;
 const held=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{entered=r;});
 const f=fixture(false,async()=>{entered();await held;}),runner=f.makeRunner();
 try{
  const active=runner.poll(0,false,false,f.options);await began;runner.pause();release();await active;
  assert.ok(runnerTestRuntime(runner).inFlight);assert.equal(runner.running,false);
  const original=f.store.latest<{signals:{key:string}[]}>(f.state.roomId,0,'wake-state')!.signals.map(s=>s.key);
  resumeSeatState(f.state,0);f.snapshot.hasMore=true;
  await runner.poll(10,false,true,f.options);
  assert.equal(runnerTestRuntime(runner).inFlight,null);assert.equal(runner.advanceReadiness(),null,'incomplete paging must still block readiness');
  const saved=f.store.latest<{inFlight:unknown;signals:{key:string}[]}>(f.state.roomId,0,'wake-state')!;
  assert.equal(saved.inFlight,null);
  for(const key of original)assert.ok(saved.signals.some(s=>s.key===key),'original cause remains queued: '+key);
  assert.deepEqual(f.store.latest(f.state.roomId,0,'interrupted-round-deferred'),{sequence:1,tick:f.snapshot.observation.view.tick});
  assert.equal(f.store.latest(f.state.roomId,0,'completed'),null,'retirement is not a successful completion');
  f.snapshot.hasMore=false;
  for(const wall of [20,30])await runner.poll(wall,false,true,f.options);
  assert.ok(runner.advanceReadiness());assert.equal(f.rounds(),1);assert.equal(f.state.sequence,1);assert.equal(f.withdrawals(),1);
  f.snapshot.observation.view.tick++;f.snapshot.observation.revision='next-tick-after-interruption';
  await runner.poll(40,false,true,f.options);await runner.poll(41,false,true,f.options);
  assert.equal(f.rounds(),2);assert.equal(f.state.sequence,2);assert.ok(runner.advanceReadiness());
 }finally{release();runner.pause();f.store.close();}
});

test('retiring an interrupted round never clears an unresolved order from the durable ledger',async()=>{
 const f=fixture();let runner=f.makeRunner();
 try{
  await runner.poll(0,false,false,f.options);
  const task=makeTask([],['已中断的前台轮'],[],false);
  f.store.save(f.state,'tool-intent',{id:'unresolved-order',tool:'order',arguments:{action:{kind:'launch',source:'source',destination:'target',drillers:1}}});
  runner=f.makeRunner();runnerTestRuntime(runner).inFlight=task;
  await runner.poll(10,false,true,f.options);
  assert.equal(runnerTestRuntime(runner).inFlight,null);
  assert.equal(runner.hasUnresolvedWrites,true);assert.equal(runner.advanceReadiness(),null);
  const pending=f.store.pendingWriteEvidence(f.state.roomId,0,['unresolved-order']);
  assert.equal(pending[0]?.intentRecorded,true);assert.equal(pending[0]?.evidence.kind,'no-durable-outcome');
  assert.equal(f.rounds(),1);assert.equal(f.state.sequence,1);
 }finally{runner.pause();f.store.close();}
});

test('incoming chat reaches background diplomacy without triggering a foreground round',async()=>{
 const f=fixture(true),runner=f.makeRunner();
 try{
  await runner.poll(0,false,false,f.options);runnerTestRuntime(runner).signals.clear();
  f.snapshot.chat=[{id:'background-message',from:1,to:0,text:'propose peace',tick:f.snapshot.observation.view.tick,sentAt:0}];f.snapshot.chatCursor=1;
  // Disable the admission gate here to prove chat routing itself suppresses the wake.
  await runner.poll(10,false,false,{eventCoalesceMs:1});await runner.poll(20,false,false,{eventCoalesceMs:1});
  assert.ok(f.ingested.includes('background-message'));assert.equal(f.state.chatCursor,1);assert.equal(f.rounds(),1);assert.ok(runner.advanceReadiness());
 }finally{runner.pause();f.store.close();}
});

test('closed-tick background ingestion preserves the foreground facts and defers new state to the next tick',async()=>{
 const f=fixture(true),runner=f.makeRunner();
 try{
  await runner.poll(0,false,false,f.options);const before=runnerTestRuntime(runner).latestSnapshot!.observation;
  const signature=runner.advanceReadiness();assert.ok(signature);
  f.snapshot.observation.revision='later-same-tick';
  f.snapshot.chat=[{id:'background-only-message',from:1,to:0,text:'new offer',tick:before.view.tick,sentAt:0}];f.snapshot.chatCursor=1;
  f.snapshot.hasMore=true;
  await runner.poll(10,false,true,{backgroundOnly:true});
  assert.equal(runnerTestRuntime(runner).latestSnapshot!.observation.revision,before.revision,'background read cannot replace foreground facts');
  assert.deepEqual(runner.advanceReadiness(),signature,'diplomacy does not reopen completion');
  assert.equal(runner.backgroundPending,true);assert.ok(f.ingested.includes('background-only-message'));assert.equal(f.state.chatCursor,1);assert.equal(f.rounds(),1);
  f.snapshot.hasMore=false;await runner.poll(11,false,true,{backgroundOnly:true});assert.equal(runner.backgroundPending,false);
  f.snapshot.observation.view.tick++;f.snapshot.observation.revision='next-tick';
  runnerTestRuntime(runner).signals.set('deferred-strategy',{key:'deferred-strategy',kind:'campaign-review',category:'strategy',reason:'new result',entities:[],urgent:true});
  await runner.poll(20,false,true,f.options);await runner.poll(21,false,true,f.options);
  assert.equal(f.rounds(),2);assert.equal(runnerTestRuntime(runner).latestSnapshot!.observation.revision,'next-tick');
 }finally{runner.pause();f.store.close();}
});

test('advancing an idle tick preserves readiness without creating another decision',async()=>{
 const f=fixture(),runner=f.makeRunner();
 try{
  await runner.poll(0,false,false,f.options);assert.equal(f.rounds(),1);
  for(let tick=1;tick<=3;tick++){
   f.snapshot.observation.view.tick++;f.snapshot.observation.revision='idle-tick-'+tick;
   await runner.poll(tick*10,false,false,f.options);
   assert.equal(f.rounds(),1);assert.equal(f.withdrawals(),1);assert.ok(runner.advanceReadiness());
   assert.equal(runnerTestRuntime(runner).signals.size,0);
  }
 }finally{runner.pause();f.store.close();}
});

test('event observation feeds diplomacy while foreground computation is still running',async()=>{
 let release!:()=>void,started!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
 const f=fixture(true,async()=>{started();await held;}),runner=f.makeRunner();
 try{
  const decision=runner.poll(0,false,false,f.options);await began;
  f.snapshot.chat=[{id:'during-search',from:1,to:0,text:'urgent proposal',tick:f.snapshot.observation.view.tick,sentAt:0}];f.snapshot.chatCursor=1;
  await runner.poll(10,false,true,{observeOnly:true});
  assert.equal(runner.running,true);assert.ok(f.ingested.includes('during-search'));assert.equal(f.rounds(),1);
  release();await decision;assert.equal(f.state.error,null);
 }finally{release();runner.pause();f.store.close();}
});

test('poll timing separates ordinary observation from an admitted decision',async()=>{
 const f=fixture(),runner=f.makeRunner();
 try{
  await runner.poll(0,false,false,f.options);
  f.store.flushTimings();
  const first=f.store.latest<{startedDecision:boolean;snapshotReads:number;durationMs:number;decisionMs:number;snapshotMs:number;admissionMs:number}>(f.state.roomId,0,'runtime-poll-timing')!;
  assert.equal(first.startedDecision,true);assert.equal(first.snapshotReads,1);
  assert.ok(first.durationMs>=first.decisionMs+first.snapshotMs+first.admissionMs);
  await runner.poll(10,false,true,{...f.options,observeOnly:true});
  f.store.flushTimings();
  const next=f.store.latest<typeof first>(f.state.roomId,0,'runtime-poll-timing')!;
  assert.equal(next.startedDecision,false);assert.equal(next.decisionMs,0);assert.equal(next.snapshotReads,1);
  assert.equal(f.rounds(),1);
 }finally{f.store.close();}
});
