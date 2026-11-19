import {SeatRunner,scriptedExecution} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';import {AiStore,initialState} from '../packages/ai/src/index.js';
import {makeTask} from '../packages/ai/src/controller/runtime/decision.js';
import {recoverySignals} from '../packages/ai/src/controller/runtime/decision-recovery.js';
import {restoreDecisionSignal,restoreDecisionTask,validateReminderSource} from '../packages/ai/src/controller/contracts/decision-task-validation.js';
import {ModelAdmissionStale} from '../packages/ai/src/controller/runtime/model-queue.js';
import type {AiSnapshot,DecisionSignal,DecisionTask} from '../packages/ai/src/controller/contracts/types.js';
import {runnerTestRuntime,runDecisionForTest} from './helpers/runner-harness.js';
import {samePlanningTick} from '../packages/ai/src/controller/runtime/decision-loop.js';

function fixture(){
 const room={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]};
 const snapshot:AiSnapshot={observation:observation(room,0,'first-call-runtime'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const state=initialState(snapshot.observation.roomId,0,{model:'synthetic-only',personality:'sentinel'});state.lastThought=0;
 const store=new AiStore(':memory:');store.save(state,'observation-baseline',snapshot.observation);
 return {snapshot,state,store};
}
const signal:DecisionSignal={key:'fleet-change',kind:'fleet-state-change',sources:[{kind:'observation',id:'revision-1',observedSeconds:600}],category:'military',scope:'local',reason:'核对实际结果，不推定抵达',entities:['蓝方工厂'],urgent:true};
const task=():DecisionTask=>({...makeTask([signal],[],[],false),memoryReview:{factsNeeded:true,strategicReview:true,cleanupNeeded:true},notebookReview:true,fullContext:true});

test('planning material identity uses room, seat and tick rather than same-tick revisions or cursors',()=>{
 const f=fixture();try{
  const same=structuredClone(f.snapshot);assert.equal(samePlanningTick(f.snapshot,same),true);
  same.observation.secondsSinceLastTick++;assert.equal(samePlanningTick(f.snapshot,same),true);
  for(const mutate of [(s:AiSnapshot)=>{s.observation.revision='changed';},(s:AiSnapshot)=>{s.chatCursor++;},(s:AiSnapshot)=>{s.notificationCursor++;}]){const next=structuredClone(f.snapshot);mutate(next);assert.equal(samePlanningTick(f.snapshot,next),true);}
  for(const mutate of [
   (s:AiSnapshot)=>{s.observation.view.tick++;},
   (s:AiSnapshot)=>{s.observation.roomId='other';},
   (s:AiSnapshot)=>{s.observation.view.player=1;},
  ]){const next=structuredClone(f.snapshot);mutate(next);assert.equal(samePlanningTick(f.snapshot,next),false);}
 }finally{f.store.close();}
});

for(const cause of ['admission','result'] as const)test(`stale ${cause} ends the round without retry and preserves original and incoming causes`,async()=>{
 const f=fixture();let calls=0;
 const incoming:DecisionSignal={...signal,key:'new-threat',reason:'新增事实需要复查'};
 const provider={step:async()=>{
  calls++;runnerTestRuntime(runner).signals.set(incoming.key,incoming);
  if(cause==='admission')throw new ModelAdmissionStale('planning-tick-changed');
  const next=structuredClone(f.snapshot);next.observation.view.tick++;runnerTestRuntime(runner).latestSnapshot=next;
  return {tokens:0,reply:{tool:'finish',summary:'old',arguments:{}}};
 }};
 const runner=new SeatRunner(f.state,f.store,{snapshot:async()=>structuredClone(f.snapshot),request:async()=>{throw Error('No writes');}},provider,undefined,undefined,()=>({...scriptedExecution(provider),deferStaleUntilNextTick:true}));
 try{
  await runDecisionForTest(runner,{...f.snapshot,task:task()},task());
  assert.equal(calls,1);
  assert.equal(f.state.status,'waiting');
  assert.equal(f.store.latest<{reason:string}>(f.state.roomId,0,'completed')?.reason,'stale-deferred');
  const wake=f.store.latest<{signals:DecisionSignal[];inFlight:unknown}>(f.state.roomId,0,'wake-state')!;
  assert.equal(wake.inFlight,null);
  assert.ok(wake.signals.some(s=>s.key===incoming.key));
  const inherited=makeTask(wake.signals,[],[],false);
  assert.deepEqual(inherited.memoryReview,task().memoryReview);
  assert.ok(inherited.triggers!.some(s=>s.sources?.some(source=>source.id==='revision-1')));
  assert.equal(f.store.latest(f.state.roomId,0,'tool-intent'),null);
 }finally{f.store.close();}
});

test('recovery retains all typed causes, exact identities and mandatory review requirements',()=>{
 const original=task();original.triggers!.push({key:'chat:1:msg',kind:'diplomacy-message',category:'diplomacy',reason:'检查提案版本',sources:[{kind:'chat',id:'1:msg'}],entities:[],urgent:false});original.reasons.push('检查提案版本');
 const recovered=makeTask(recoverySignals(original,'interrupted','核账后续办',true),[],[],false);
 assert.deepEqual(recovered.memoryReview,original.memoryReview);assert.equal(recovered.notebookReview,true);assert.equal(recovered.fullContext,true);
 assert.ok(recovered.triggers!.some(t=>t.kind==='recovery'));
 assert.ok(recovered.triggers!.some(t=>t.kind==='fleet-state-change'&&t.sources?.some(s=>s.id==='revision-1')));
 assert.ok(recovered.triggers!.some(t=>t.kind==='diplomacy-message'&&t.sources?.some(s=>s.id==='1:msg')));
 assert.ok(recovered.triggers!.every(t=>t.role==='inherited-trigger'));assert.deepEqual(original.triggers![0],signal);
});

test('old saved tasks become explicitly unknown without guessing from reason text',()=>{
 const original:DecisionTask={category:'military',scope:'local',weight:'medium',reasons:['战役提醒到期，继续等待'],entities:['entity'],deferred:[]};
 const restored=restoreDecisionTask(original);
 assert.equal(restored.triggers![0]!.kind,'unknown');assert.equal(restored.triggers![0]!.reason,original.reasons[0]);
 assert.equal(restored.scope,'local');assert.equal(original.triggers,undefined);
});

test('saved typed context rejects malformed fields instead of clearing or repairing them',()=>{
 for(const mutation of [
  {kind:'invented'}, {sources:[{kind:'observation',id:4}]}, {sources:[{kind:'observation',id:'r',observedSeconds:-1}]},
  {sources:[{kind:'observation',id:'r',extra:true}]}, {sources:[{kind:['observation'],id:'r'}]}, {role:'done'}, {role:['inherited-trigger']}, {category:['military']}, {scope:['local']}, {relatedCampaignIds:[1]},
  {reviewRequirements:{factsNeeded:true,strategicReview:false}}, {requiresFullContext:'yes'}, {notebookReview:1}, {surprise:true},
 ])assert.throws(()=>restoreDecisionSignal({...signal,...mutation}),/Invalid saved decision context/);
 for(const mutation of [{triggers:{}},{triggers:[{...signal,kind:'invented'}]},{memoryReview:{factsNeeded:true,strategicReview:1,cleanupNeeded:false}},{fullContext:1},{category:['military']},{weight:['medium']},{scope:['local']}])assert.throws(()=>restoreDecisionTask({...task(),...mutation}),/Invalid saved decision context/);
 assert.doesNotThrow(()=>validateReminderSource({id:'old',atSeconds:600,note:'original'}));
 assert.throws(()=>validateReminderSource({id:'campaign:one',atSeconds:600,note:'original',source:{kind:'campaign',campaignId:'two'}}),/reminder.source/);
});

test('restart and pause preserve typed multi-cause review obligations',()=>{
 const f=fixture();try{
  const unfinished=task();unfinished.deferred=[{key:'minor',summary:'仍未消费的上下文',count:1,firstSeconds:0,lastSeconds:600}];
  f.store.save(f.state,'wake-state',{signals:[],deferred:[],inFlight:unfinished,observed:f.snapshot.observation});
  const runner=new SeatRunner(f.state,f.store,{snapshot:async()=>f.snapshot,request:async()=>{throw Error('No writes');}},{step:async()=>{throw Error('No model');}});
  const resumed=makeTask([...runnerTestRuntime(runner).signals.values()],[],[],false);
  assert.deepEqual(resumed.memoryReview,unfinished.memoryReview);assert.equal(resumed.triggers!.find(t=>t.kind==='fleet-state-change')!.sources![0]!.id,'revision-1');
  runnerTestRuntime(runner).inFlight=unfinished;runner.pause();
  const saved=f.store.latest<{signals:DecisionSignal[];deferred:unknown[]}>(f.state.roomId,0,'wake-state')!;
  assert.deepEqual(makeTask(saved.signals,[],[],false).memoryReview,unfinished.memoryReview);assert.equal(saved.deferred.length,1);
 }finally{f.store.close();}
});

test('retired strategicReview fields are rejected without manufacturing a global review',async()=>{
 const f=fixture();let calls=0;
 try{
  const runner=new SeatRunner(f.state,f.store,{snapshot:async()=>structuredClone(f.snapshot),request:async()=>{throw Error('No game writes');}},{step:async()=>{
   if(++calls===1)return {tokens:0,reply:{tool:'finish',summary:'attempted narrow global review',arguments:{strategicReview:{reason:'must not certify from a narrow input'}}}};
   f.state.enabled=false;return {tokens:0,reply:{tool:'finish',summary:'read-only',arguments:{}}};
  }});
  const business=makeTask([{key:'activity',kind:'activity-warning',category:'plan',reason:'核对活跃状态',entities:[],urgent:true}],[],[],false);
  await runDecisionForTest(runner,{...f.snapshot,task:business},business);
  assert.equal(calls,2);assert.equal(f.store.latest(f.state.roomId,0,'full-memory-review'),null);
  const rejection=f.store.latest<{result:unknown}>(f.state.roomId,0,'tool-rejected');assert.ok(rejection);assert.match(JSON.stringify(rejection),/strategicReview|INVALID_TOOL_FIELDS/i);
 }finally{f.store.close();}
});

test('realtime planning survives ticks but never changes room or seat identity',()=>{
 const f=fixture();try{f.snapshot.observation.realtime=true;const next=structuredClone(f.snapshot);next.observation.view.tick+=2;next.observation.revision='new';assert.equal(samePlanningTick(f.snapshot,next),true);next.observation.roomId='other';assert.equal(samePlanningTick(f.snapshot,next),false);next.observation.roomId=f.snapshot.observation.roomId;next.observation.view.player++;assert.equal(samePlanningTick(f.snapshot,next),false);}finally{f.store.close();}
});
