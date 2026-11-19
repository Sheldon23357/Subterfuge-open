import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {forecastKnownObservation,type KnownDepartureEvidence} from '../packages/prediction/src/index.js';
import {confirmDepartures,type DepartureReview} from '../packages/ai/src/controller/observation/departure-confirmation.js';
import {classifyChanges} from '../packages/ai/src/controller/runtime/decision.js';import {AiStore,initialState,executeTool,type AiSnapshot,type AgentRequest} from '../packages/ai/src/index.js';
import type {PlayerObservation} from '../packages/contracts/src/index.js';

function fixture(){
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};

  const world=submitFleetOrder(createFleetScenario(cfg),{id:'pending',player:1,action:{kind:'launch',delaySeconds:600,source:'红方矿场',destination:'蓝方工厂',drillers:10,}}).state;
  const before:PlayerObservation=observation({state:world,scheduled:[]},0,'confirmation');
  const at=(tick:number):PlayerObservation=>observation({state:advanceFleetScenario(world,tick),scheduled:[]},0,'confirmation');
  let evidence:KnownDepartureEvidence|undefined;
  const result=forecastKnownObservation(before,112,[],undefined,e=>{evidence=e;});
  assert.ok(evidence);
  const {departures,...basis}=evidence;
  const reviews:DepartureReview[]=departures.map(departure=>({...basis,departure,sequence:1,resultRef:'forecast',validatedRevision:before.revision}));
  const snapshot:AiSnapshot={observation:before,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
  return {before,at,world,reviews,result,snapshot};
}
const finished={tokens:1,reply:{tool:'finish',arguments:{},summary:'完成待发进攻对策'}};

test('continuation evidence comes from the existing successful baseline and covers known arrival',()=>{
  const f=fixture(),events:KnownDepartureEvidence[]=[];
  assert.deepEqual(f.result,forecastKnownObservation(f.before,112));
  assert.equal(f.reviews[0]!.departure.frames.length,4);
  assert.equal(f.reviews[0]!.departure.departureSeconds,101*600);
  for(const [targetTick,drafts,waiting] of [[101,[],undefined],[112,[],'defend'],[112,[{id:'hypothesis',issueTick:100,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}],undefined]] as const)
    forecastKnownObservation(f.before,targetTick,drafts,waiting,e=>events.push(e));
  assert.equal(events.length,0);
  const unknown=structuredClone(f.before);delete unknown.view.outposts[0]!.drillers;unknown.view.outposts[0]!.visibility=1;
  forecastKnownObservation(unknown,112,[],undefined,e=>events.push(e));assert.deepEqual(events,[]);
});

test('a matching visible departure is deferred once and ordinary polling preserves its evidence',()=>{
  const f=fixture(),waiting=f.at(101),moving=f.at(102);
  const partial=confirmDepartures(f.before,waiting,f.reviews);
  assert.equal(partial.reviews.length,1);assert.equal(partial.confirmed.size,0);
  const result=confirmDepartures(waiting,moving,partial.reviews);
  assert.deepEqual([...result.confirmed],['pending']);assert.equal(result.reviews.length,0);assert.equal(result.minor.length,1);
  assert.equal(classifyChanges(waiting,moving).important.filter(s=>s.key==='threat:pending').length,1);
  assert.equal(classifyChanges(waiting,moving,{confirmedDepartures:result.confirmed}).important.length,0);
  const wrapped=structuredClone(moving);wrapped.view.fleets[0]!.position.x+=moving.view.size.width;
  assert.equal(confirmDepartures(f.before,wrapped,f.reviews).confirmed.size,1);
});

test('military changes, stale scope, altered timing and missing contacts never confirm a departure',()=>{
  const f=fixture();
  const cases:[string,(o:typeof f.before)=>void][]=[
    ['troops',o=>{o.view.fleets[0]!.drillers++;}],
    ['owner',o=>{o.view.fleets[0]!.owner=0;}],
    ['gift',o=>{o.view.fleets[0]!.gift=true;}],
    ['route',o=>{o.view.fleets[0]!.destination={kind:'outpost',id:'红方后方'};}],
    ['late motion',o=>{o.view.fleets[0]!.position.x+=0.03;}],
    ['fractional observation',o=>{o.secondsSinceLastTick=1;}],
    ['other contact',o=>{o.view.fleets.push({...o.view.fleets[0]!,id:'new-attack'});}],
    ['defender growth',o=>{o.view.outposts[0]!.drillers=o.view.outposts[0]!.drillers!+1;}],
    ['shield loss',o=>{o.view.outposts[1]!.shield=o.view.outposts[1]!.shield!-1;}],
    ['ownership',o=>{o.view.outposts[1]!.owner=0;}],
    ['lost vision',o=>{o.view.outposts[1]!.visibility=1;delete o.view.outposts[1]!.drillers;}],
    ['own orders',o=>{o.scheduled.push({id:'new',player:0,issueTick:105,status:'pending',action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}});}],
  ];
  for(const [name,mutate] of cases){const next=f.at(102);mutate(next);assert.equal(confirmDepartures(f.before,next,f.reviews).confirmed.size,0,name);}
  for(const patch of [{roomId:'other'},{player:1},{validatedRevision:'stale'},{targetTick:101}])
    assert.equal(confirmDepartures(f.before,f.at(102),[{...f.reviews[0]!,...patch}]).confirmed.size,0);
  assert.equal(confirmDepartures(null,f.at(102),f.reviews).confirmed.size,0);
  for(const mutate of [(o:typeof f.before)=>{o.view.fleets=[];},(o:typeof f.before)=>{o.view.fleets[0]!.state='waiting';}]){
    const next=f.at(102);mutate(next);const r=confirmDepartures(f.before,next,f.reviews);
    assert.equal(r.confirmed.size,0);assert.equal(r.important.length,1);assert.equal(r.reviews.length,0);
  }
});

test('source opportunity signals coalesce with confirmed departure, while extra changes remain important',()=>{
  const f=fixture(),before=structuredClone(f.before),after=f.at(102);
  for(const o of [before,after])o.view.fleets.push({id:'own-attack',owner:0,source:'蓝方工厂',drillers:20,state:'moving',gift:false,position:{x:0,y:0},destination:{kind:'outpost',id:'红方矿场'}});
  const confirmed=confirmDepartures(before,after,f.reviews).confirmed;
  assert.equal(confirmed.size,1);
  assert.ok(classifyChanges(before,after).important.some(s=>s.key==='attack-departure:红方矿场'));

  assert.equal(classifyChanges(before,after,{confirmedDepartures:confirmed}).important.length,0);
  const changed=structuredClone(after);changed.view.outposts[1]!.drillers=changed.view.outposts[1]!.drillers!+5;
  assert.equal(confirmDepartures(before,changed,f.reviews).confirmed.size,0);
  assert.ok(classifyChanges(before,changed).important.some(s=>s.key==='attack-target:红方矿场'));
});

function runnerFixture(mode:'continue'|'defend'|'short'|'none'='continue',reviewTick=104){
  const f=fixture(),store=new AiStore(':memory:'),state=initialState('confirmation',0,{model:'',personality:'sentinel'}),requests:AgentRequest[]=[];
  const gateway={snapshot:async()=>structuredClone(f.snapshot),request:async()=>{throw Error('No live game writes');}};
  let roundStep=0;
  const provider={step:async(request:AgentRequest)=>{
    requests.push(request);roundStep++;
    if(requests.length>12)throw Error('Unexpected repeated test decision: '+request.prompt.slice(-3000));
    if(roundStep===1&&mode!=='none')return {tokens:1,reply:{tool:'forecast',arguments:{targetTick:mode==='short'?101:112,...mode==='defend'?{enemyWaiting:'defend'}:{}},summary:'待发阶段核对现有进攻'}};
    return {...finished,reply:{...finished.reply,arguments:f.snapshot.observation.view.tick===100?{reminders:{set:[{id:'review',atWorldDay:reviewTick,note:'既定后续方案复查',category:'military',entities:[f.snapshot.observation.outpostNames!['蓝方工厂']!]}]}}:{reminders:{complete:store.reminders('confirmation',0).filter(r=>r.atSeconds<=f.snapshot.observation.view.tick*600).map(r=>r.id)}}}};
  }};
  return {...f,store,state,requests,gateway,provider};
}

test('departure while a round is still thinking remains an important event and supersedes the old reply',async()=>{
  const f=fixture(),store=new AiStore(':memory:'),state=initialState('confirmation',0,{model:'',personality:'sentinel'});
  let calls=0,release!:()=>void,waiting!:()=>void;
  const wait=new Promise<void>(resolve=>{waiting=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const gateway={snapshot:async()=>structuredClone(f.snapshot),request:async()=>{throw Error('No HTTP');}};
  const provider={step:async()=>{
    calls++;
    if(calls===1)return {tokens:1,reply:{tool:'forecast',arguments:{targetTick:112},summary:'尚未完成的预测'}};
    if(calls===2){waiting();await gate;}
    return finished;
  }};
  const runner=new SeatRunner(state,store,gateway,provider);
  try{
    const thinking=runner.pollAndFlush(0);await wait;
    f.snapshot.observation=f.at(102);await runner.pollAndFlush(6000);release();await thinking;
    assert.equal(calls,3);assert.ok(store.latest('confirmation',0,'reply-superseded'));
    assert.equal(store.latest<any>('confirmation',0,'wake-state').departureReviews.length,0);
  }finally{release();store.close();}
});
