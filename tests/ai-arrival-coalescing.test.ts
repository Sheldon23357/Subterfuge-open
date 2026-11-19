import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {AiStore,initialState,type AiSnapshot} from '../packages/ai/src/index.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {roundArrivalEstimates} from '../packages/ai/src/controller/presentation/round-map.js';
import {observation} from '../packages/server/src/player-api.js';
import type {PlayerObservation} from '../packages/contracts/src/index.js';
import {classifyChanges,makeTask} from '../packages/ai/src/controller/runtime/decision.js';
import {arrivalEstimates,coalesceOwnArrivals,ARRIVAL_COALESCED_PREFIX,type ArrivalEstimates} from '../packages/ai/src/controller/observation/arrival-coalescing.js';
import type {AiReminder,AgentRequest} from '../packages/ai/src/controller/contracts/types.js';

let fixtureSequence=0;
function fixture(){
  const before:PlayerObservation=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'arrival-test');
  before.revision=`arrival-before-${++fixtureSequence}`;before.view.tick=100;before.secondsSinceLastTick=0;before.scheduled=[];before.view.size={width:40,height:40};
  before.view.outposts=[
    {id:'home',owner:0,type:'generator',position:{x:0,y:0},visibility:2,drillers:100,shield:0,shieldMax:10,shieldsEnabled:true},
    {id:'target',owner:0,type:'mine',position:{x:1,y:0},visibility:2,drillers:1,shield:0,shieldMax:10,shieldsEnabled:true},
  ];
  before.outpostNames={home:'HAVEN',target:'REEF'};before.activity=[];before.activityCursor=0;
  before.view.fleets=[{id:'supply',owner:0,drillers:12,state:'moving',gift:false,position:{x:.98,y:0},destination:{kind:'outpost',id:'target'}}];
  before.view.self.outpostCount=2;
  const after=structuredClone(before);after.revision=`arrival-after-${fixtureSequence}`;after.view.tick=101;after.view.fleets=[];after.view.outposts[1]!.drillers=13;after.activity=[{id:0,kind:'fleet-arrived',tick:100,seconds:360,actor:0,subject:'supply',source:'home',destination:{kind:'outpost',id:'target'},drillers:12,enabled:null,arrival:{outpost:'target',outcome:'delivered',drillers:12}}];after.activityCursor=1;
  const reminders:AiReminder[]=[{id:'review',atSeconds:61200,note:'review central defense',category:'military',entities:['target']}];
  const estimates=arrivalEstimates(before,{status:'conditional',arrivals:[{id:'supply',arrivalMinutes:6}]});
  const result=(o=after,e:ArrivalEstimates|null=estimates,r=reminders)=>coalesceOwnArrivals(before,o,classifyChanges(before,o).important,e,r,[]);
  return {before,after,reminders,estimates,result};
}

test('only known ordinary supply matched to visible growth merges into a related review within ten minutes',()=>{
  const f=fixture(),r=f.result();assert.deepEqual(r.immediate,[]);assert.equal(r.delayed.length,1);
  assert.equal(r.delayed[0]!.atSeconds,61200);assert.equal(r.delayed[0]!.reminderId,'review');
  assert.deepEqual(r.delayed[0]!.signal.entities,['supply','target']);assert.match(r.delayed[0]!.signal.reason,/12兵/);
  assert.equal(f.result(f.after,null).immediate.length,1);
  for(const reminders of [[],[{...f.reminders[0]!,atSeconds:61201}],[{...f.reminders[0]!,atSeconds:60600}],[{...f.reminders[0]!,entities:['home']}]])
    assert.equal(f.result(f.after,f.estimates,reminders).delayed.length,0);
});



test('the entire arrival batch must match and other important events are never deferred',()=>{
  const f=fixture();f.before.view.fleets.push({...f.before.view.fleets[0]!,id:'supply-two',drillers:6});
  f.estimates.fleets.push({...f.estimates.fleets[0]!,id:'supply-two',drillers:6});
  f.after.view.outposts[1]!.drillers=19;f.after.activity!.push({...f.after.activity![0]!,id:1,subject:'supply-two',drillers:6,arrival:{outpost:'target',outcome:'delivered',drillers:6}});f.after.activityCursor=2;
  assert.equal(f.result().delayed.length,2);
  f.estimates.fleets.pop();assert.equal(f.result().delayed.length,0);
  const g=fixture(),signals=[...classifyChanges(g.before,g.after).important,{key:'damage:home',reason:'battle',category:'military' as const,entities:['home'],urgent:true}];
  assert.deepEqual(coalesceOwnArrivals(g.before,g.after,signals,g.estimates,g.reminders,[]).immediate,signals);
});

function runnerFixture(){
  const f=fixture(),store=new AiStore(':memory:'),state=initialState('arrival-test',0,{model:'',personality:'sentinel'});
  state.lastThought=60000;
  store.save(state,'arrival-estimates',f.estimates);store.save(state,'reminder-set',f.reminders[0]);
  store.save(state,'wake-state',{signals:[],deferred:[],observed:f.before});
  const snapshot:AiSnapshot={observation:f.after,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
  const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No game writes expected');}};
  const requests:AgentRequest[]=[];
  const provider={step:async(r:AgentRequest)=>{requests.push(r);return {tokens:1,reply:{tool:'finish',arguments:snapshot.observation.view.tick>=102?{reminders:{complete:['review']}}:{},summary:'review'}};}};
  return {...f,store,state,snapshot,gateway,requests,provider};
}

test('battle notices and unread observation pages prevent initially delaying an arrival',async()=>{
  for(const battle of [true,false]){
    const f=runnerFixture();
    if(battle){f.snapshot.notificationCursor=1;f.snapshot.notifications=[{id:0,kind:'battle',tick:101,seconds:0,text:'actual combat',details:null,urgent:true,sendNotification:true,
      location:{kind:'outpost',id:'home',position:{x:0,y:0}}}];}
    else f.snapshot.hasMore=true;
    const runner=new SeatRunner(f.state,f.store,f.gateway,f.provider);
    try{
      await runner.poll(0);await runner.poll(20000);assert.equal(f.requests.length,1);
      assert.equal(f.store.latest<{coalescedArrivals:unknown[]}>('arrival-test',0,'wake-state')!.coalescedArrivals.length,0);
      assert.doesNotMatch(f.requests[0]!.prompt,/预期援军到账合并/);
    }finally{runner.pause();f.store.close();}
  }
});

test('unrelated diplomatic replies retain the full map and leave the arrival for its original review',async()=>{
  const f=runnerFixture(),runner=new SeatRunner(f.state,f.store,f.gateway,f.provider);
  try{
    await runner.poll(0);f.snapshot.chatCursor=1;
    f.snapshot.chat=[{id:'unrelated-chat',from:1,to:0,text:'讨论另一条边界',tick:101,sentAt:0}];
    await runner.poll(6000);await runner.poll(22000);
    assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.effort,'low');
    assert.equal(f.store.latest<{coalescedArrivals:unknown[]}>('arrival-test',0,'wake-state')!.coalescedArrivals.length,1);
    assert.doesNotMatch(f.requests[0]!.prompt,/预期援军到账合并/);
  }finally{runner.pause();f.store.close();}
});

test('matching troop growth and predicted timing cannot defer a disappearance without an actual delivery event',()=>{
 for(const change of [
  (after:PlayerObservation)=>{after.activity=[];},
  (after:PlayerObservation)=>{after.activity![0]!.kind='launch-cancelled';delete after.activity![0]!.arrival;},
  (after:PlayerObservation)=>{after.activity![0]!.arrival!.outcome='defeated';},
  (after:PlayerObservation)=>{after.activity![0]!.arrival!.drillers=11;},
 ]){
  const f=fixture();change(f.after);const result=f.result();assert.equal(result.delayed.length,0);assert.ok(result.immediate.length);
 }
});

test('loss, uncertain timing, extra troops, gifts and threats still wake immediately',()=>{
  for(const change of [
    (f:ReturnType<typeof fixture>)=>{f.after.view.outposts[1]!.drillers=1;},
    (f:ReturnType<typeof fixture>)=>{f.after.view.outposts[1]!.drillers=14;},
    (f:ReturnType<typeof fixture>)=>{f.estimates.fleets[0]!.arrivalSeconds=60700;},
    (f:ReturnType<typeof fixture>)=>{f.before.view.fleets[0]!.gift=true;},
    (f:ReturnType<typeof fixture>)=>{f.after.view.outposts[1]!.owner=1;},
    (f:ReturnType<typeof fixture>)=>{f.after.view.fleets.push({id:'enemy',owner:1,drillers:10,state:'moving',gift:false,position:{x:1.1,y:0},destination:{kind:'outpost',id:'target'}});},
  ]){
    const f=fixture();change(f);assert.ok(f.result().immediate.length);assert.deepEqual(f.result().delayed,[]);
  }
  const f=fixture();f.before.view.fleets.push({id:'enemy',owner:1,drillers:10,state:'moving',gift:false,position:{x:1.2,y:0},destination:{kind:'outpost',id:'target'}});
  f.after.view.fleets=structuredClone(f.before.view.fleets.filter(s=>s.id==='enemy'));
  assert.equal(f.result().delayed.length,0,'existing unchanged threats also prevent delay');
});
