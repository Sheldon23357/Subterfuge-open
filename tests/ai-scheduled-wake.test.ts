import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {AiStore,initialState,type AiSnapshot} from '../packages/ai/src/index.js';
import {classifyChanges,classifyNotice} from '../packages/ai/src/controller/runtime/decision.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import type {QueuedOrderView} from '../packages/contracts/src/index.js';
import type {Campaign} from '../packages/ai/src/controller/storage/campaign-state.js';
import type {KnownDefenseEvidence} from '../packages/prediction/src/index.js';
function fixture(){
 const snapshot:AiSnapshot={observation:observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'schedule-wake'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const store=new AiStore(':memory:'),state=initialState('schedule-wake',0,{model:'',personality:'sentinel'});
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No game writes expected');}};
 const provider={step:async()=>({tokens:1,reply:{tool:'finish',arguments:'{}',summary:'已复核'}})};
 return {snapshot,store,state,gateway,provider};
}
const order=(status:QueuedOrderView['status']='pending',extra:Partial<QueuedOrderView>={}):QueuedOrderView=>({id:'scheduled-launch',player:0,issueTick:102,status,action:{kind:'launch',source:'home',destination:'target',drillers:5},...extra});
for(const [name,beforeOrders,afterOrders] of [
 ['new',[],[order()]],
 ['executed',[order()],[order('executed')]],
 ['cancelled',[order()],[order('cancelled')]],
 ['removed',[order()],[]],
 ['edited',[order()],[order('pending',{issueTick:103})]],
] as [string,QueuedOrderView[],QueuedOrderView[]][]){
 test(`schedule ${name} alone records context without a wake, including after restart`,async()=>{
  const f=fixture();try{
   f.snapshot.observation.scheduled=beforeOrders;
   let runner=new SeatRunner(f.state,f.store,f.gateway,f.provider);await runner.pollAndFlush(0);
   f.snapshot.observation.scheduled=afterOrders;f.snapshot.observation.revision=name;
   await runner.pollAndFlush(6000);await runner.pollAndFlush(22000);
   assert.equal(f.state.calls,0);assert.equal(runner.readyToAdvance(f.snapshot.observation.view.tick),true);
   const wake=f.store.latest<{observed?:AiSnapshot['observation'];signals:unknown[];deferred:{key:string;count:number}[]}>('schedule-wake',0,'wake-state')!;
   assert.deepEqual(f.store.latest<AiSnapshot['observation']>('schedule-wake',0,'wake-observation')!.scheduled,afterOrders);
   assert.equal(wake.observed,undefined);assert.deepEqual(wake.signals,[]);
   assert.equal(wake.deferred.find(e=>e.key==='scheduled')?.count,1);
   runner=new SeatRunner(f.state,f.store,f.gateway,f.provider);await runner.pollAndFlush(40000);await runner.pollAndFlush(56000);
   assert.equal(f.state.calls,0);
   assert.equal(f.store.latest<typeof wake>('schedule-wake',0,'wake-state')!.deferred.find(e=>e.key==='scheduled')?.count,1);
  }finally{f.store.close();}
 });
}
for(const failure of [order('failed',{reason:'Insufficient drillers'}),order('cancelled',{failed:true,reason:'A related launch modification failed'}),order('pending',{failed:true,reason:'A related launch modification failed'})]){
 test(`schedule ${failure.status} failure wakes urgently once and survives restart`,async()=>{
  const f=fixture();try{
   f.snapshot.observation.scheduled=[order()];let runner=new SeatRunner(f.state,f.store,f.gateway,f.provider);await runner.pollAndFlush(0);
   const before=structuredClone(f.snapshot.observation);
   f.snapshot.observation.scheduled=[failure];f.snapshot.observation.revision='failure';
   const signal=classifyChanges(before,f.snapshot.observation,{ignoreOwnEffects:true}).important.find(s=>s.key==='scheduled-failed:scheduled-launch');
   assert.ok(signal?.urgent);assert.match(signal.reason,/失败/);
   await runner.pollAndFlush(6000);assert.equal(f.state.calls,0);await runner.pollAndFlush(22000);assert.equal(f.state.calls,0);
   runner=new SeatRunner(f.state,f.store,f.gateway,f.provider);await runner.pollAndFlush(40000);assert.equal(f.state.calls,0);
  }finally{f.store.close();}
 });
}
test('newly observed failed orders and changed failure details wake, unchanged failures do not',()=>{
 const f=fixture();try{
  const before=structuredClone(f.snapshot.observation),after=structuredClone(before);after.scheduled=[order('failed',{reason:'invalid target'})];
  assert.equal(classifyChanges(before,after).important.length,1);
  assert.equal(classifyChanges(after,structuredClone(after)).important.length,0);
  const changed=structuredClone(after);changed.scheduled[0]!.reason='source lost';
  assert.equal(classifyChanges(after,changed).important.length,1);
  assert.equal(classifyChanges(null,after).important.length,0); // First-entry wake owns baseline initialization.
 }finally{f.store.close();}
});

test('schedule success still permits an independently due reminder to wake',async()=>{
 const f=fixture();try{
  f.snapshot.observation.scheduled=[order()];const runner=new SeatRunner(f.state,f.store,f.gateway,f.provider);await runner.pollAndFlush(0);
  f.store.save(f.state,'reminder-set',{id:'review',atSeconds:f.snapshot.observation.view.tick*600,note:'核对前线',category:'military',entities:[]});
  f.provider.step=async()=>({tokens:1,reply:{tool:'finish',arguments:JSON.stringify({reminders:{complete:['review']}}),summary:'已复核'}});
  f.snapshot.observation.scheduled=[order('executed')];await runner.pollAndFlush(6000);
  assert.equal(f.state.calls,0);
  assert.ok((f.store.decisionPage('schedule-wake',0).entries[0]!.payload as {reasons:string[]}).reasons.some(r=>r.includes('提醒到期')));
 }finally{f.store.close();}
});
for(const resource of ['drillers','shield'] as const){
 test(`own outpost ${resource} loss alone is deferred and stays quiet across restart`,async()=>{
  const f=fixture();try{
   const own=f.snapshot.observation.view.outposts.find(o=>o.owner===0)!;own[resource]=20;
   let runner=new SeatRunner(f.state,f.store,f.gateway,f.provider);await runner.pollAndFlush(0);
   own[resource]=19;f.snapshot.observation.revision='loss';await runner.pollAndFlush(6000);await runner.pollAndFlush(22000);
   assert.equal(f.state.calls,0);assert.equal(runner.readyToAdvance(f.snapshot.observation.view.tick),true);
   const saved=f.store.latest<{observed?:AiSnapshot['observation'];deferred:{key:string;count:number}[]}>('schedule-wake',0,'wake-state')!;
   assert.equal(f.store.latest<AiSnapshot['observation']>('schedule-wake',0,'wake-observation')!.view.outposts.find(o=>o.id===own.id)![resource],19);
   assert.equal(saved.observed,undefined);
   assert.equal(saved.deferred.find(e=>e.key===`damage:${own.id}`)?.count,1);
   runner=new SeatRunner(f.state,f.store,f.gateway,f.provider);await runner.pollAndFlush(40000);await runner.pollAndFlush(56000);assert.equal(f.state.calls,0);
   assert.equal(f.store.latest<typeof saved>('schedule-wake',0,'wake-state')!.deferred.find(e=>e.key===`damage:${own.id}`)?.count,1);
  }finally{f.store.close();}
 });
}
test('combined normal schedule and post loss preserve independent enemy and ownership wakes',()=>{
 const f=fixture();try{
  const before=structuredClone(f.snapshot.observation),own=before.view.outposts.find(o=>o.owner===0)!;
  before.scheduled=[order()];const after=structuredClone(before);after.scheduled=[order('executed')];
  after.view.outposts.find(o=>o.id===own.id)!.drillers!--;
  after.view.fleets.push({id:'hostile',owner:1,position:{x:1,y:0},state:'moving',drillers:50,gift:false,destination:{kind:'outpost',id:own.id}});
  assert.ok(classifyChanges(before,after).important.some(s=>s.key==='threat:hostile'&&s.urgent));
  after.view.outposts.find(o=>o.id===own.id)!.owner=1;
  assert.ok(classifyChanges(before,after).important.some(s=>s.key===`post:${own.id}`&&s.urgent));
 }finally{f.store.close();}
});
test('battle notices still wake immediately alongside schedule success and post damage',async()=>{
 const f=fixture();try{
  f.snapshot.observation.scheduled=[order()];const runner=new SeatRunner(f.state,f.store,f.gateway,f.provider);await runner.pollAndFlush(0);
  const own=f.snapshot.observation.view.outposts.find(o=>o.owner===0)!;own.drillers!--;
  f.snapshot.observation.scheduled=[order('executed')];
  const notice={id:0,kind:'battle',text:'本人据点发生战斗',tick:f.snapshot.observation.view.tick,location:{kind:'outpost',id:own.id}} as AiSnapshot['notifications'][number];
  assert.ok(classifyNotice(notice,f.snapshot.observation.view)?.urgent);
  f.snapshot.notifications=[notice];f.snapshot.notificationCursor=1;
  await runner.pollAndFlush(6000);assert.equal(f.state.calls,0);await runner.pollAndFlush(22000);assert.equal(f.state.calls,0);
 }finally{f.store.close();}
});
test('moving fleet losses and economy thresholds keep their independent signals',()=>{
 const f=fixture();try{
  const before=structuredClone(f.snapshot.observation),own=before.view.outposts.find(o=>o.owner===0)!;
  before.view.fleets.push({id:'moving',owner:0,position:{x:0,y:0},state:'moving',drillers:10,gift:false,destination:{kind:'outpost',id:own.id}});
  const after=structuredClone(before);after.view.fleets.find(f=>f.id==='moving')!.drillers=9;
  assert.ok(classifyChanges(before,after).important.some(s=>s.key==='fleet-damage:moving'&&s.urgent));
  const old=before.view.outposts.find(o=>o.id===own.id)!,post=after.view.outposts.find(o=>o.id===own.id)!;
  old.type=post.type='factory';old.minePending=post.minePending=false;old.drillers=before.view.self.mineCreationCost-1;post.drillers=after.view.self.mineCreationCost;
  assert.ok(classifyChanges(before,after).important.some(s=>s.key===`funded:${own.id}`));
  post.minePending=true;
  assert.ok(classifyChanges(before,after).important.some(s=>s.key===`economy:${own.id}`));
 }finally{f.store.close();}
});
test('deferred source losses do not revive or mutate archived unbooked comparisons across restart',async()=>{
 for(const resource of ['drillers','shield'] as const){
  const f=fixture();try{
   const o=f.snapshot.observation,own=o.view.outposts.find(p=>p.owner===o.view.player)!,target=o.view.outposts.find(p=>p.owner!==o.view.player)!;
   own.drillers=100;own.shield=20;own.shieldsEnabled=true;
   let runner=new SeatRunner(f.state,f.store,f.gateway,f.provider);await runner.pollAndFlush(0);
   const plan:Campaign={id:'source-plan',target:target.id,objective:'capture',holdPlan:'hold',cancelWhen:'source changes',stage:'assembling',createdTick:o.view.tick,reviewAtTick:o.view.tick+8,allocations:[],accountedFleets:[],issues:[],comparison:{resultRef:'source-proof',planId:'attack'}};
   const evidence:KnownDefenseEvidence={roomId:o.roomId,player:o.view.player,basisRevision:o.revision,observedTick:o.view.tick,observedSeconds:o.view.tick*600,targetTick:o.view.tick+20,targets:structuredClone(o.view.outposts),fleets:[],arrivals:[],drafts:[{id:'later-attack',issueTick:o.view.tick+10,action:{kind:'launch',source:own.id,destination:target.id,drillers:40}}]};
   f.store.save(f.state,'comparison-evidence',{id:'source-proof',planId:'attack',evidence});
   f.store.save(f.state,'campaign-state',{plans:[plan]});
   own[resource]=resource==='drillers'?39:19;f.snapshot.observation.revision=`source-${resource}-loss`;
   await runner.pollAndFlush(6000);await runner.pollAndFlush(22000);
   assert.equal(f.state.calls,0,`${resource}: source loss must not wake`);
   assert.equal(f.store.latest<{plans:Campaign[]}>('schedule-wake',0,'campaign-state')!.plans[0]!.comparisonInvalidated,undefined,`${resource}: archived plans are not live execution obligations`);
   assert.equal(runner.readyToAdvance(o.view.tick),true);
   runner=new SeatRunner(f.state,f.store,f.gateway,f.provider);await runner.pollAndFlush(40000);
   assert.equal(f.state.calls,0);
   assert.equal(f.store.latest<{plans:Campaign[]}>('schedule-wake',0,'campaign-state')!.plans[0]!.comparisonInvalidated,undefined);
  }finally{f.store.close();}
 }
});

test('successful schedule changes preserve threats and arrivals while damage is deferred',()=>{
 const f=fixture();try{
  const before=structuredClone(f.snapshot.observation);before.scheduled=[order()];
  const own=before.view.outposts.find(o=>o.owner===0)!;
  before.view.fleets.push({id:'arriving',owner:0,position:{x:0,y:0},state:'moving',drillers:5,gift:false,destination:{kind:'outpost',id:own.id}});

  const after=structuredClone(before);after.scheduled=[order('executed')];
  after.view.outposts.find(o=>o.id===own.id)!.drillers!--;
  after.view.fleets=after.view.fleets.filter(f=>f.id!=='arriving');
  after.view.fleets.push({id:'enemy',owner:1,position:{x:1,y:0},state:'moving',drillers:50,gift:false,destination:{kind:'outpost',id:own.id}});
  const signals=classifyChanges(before,after).important;
  for(const key of ['threat:enemy','arrival:arriving'])assert.ok(signals.some(s=>s.key===key),key);
  assert.equal(signals.some(s=>s.key==='scheduled'||s.key===`damage:${own.id}`),false);
  assert.ok(classifyChanges(before,after).minor.some(s=>s.key===`damage:${own.id}`));
 }finally{f.store.close();}
});
