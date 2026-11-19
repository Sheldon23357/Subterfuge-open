import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,projectPlayerActivity,projectPlayerActivityPage,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {ActivityFacts} from '../packages/ai/src/controller/observation/activity-facts.js';
import {createKnownPrediction} from '../packages/prediction/src/index.js';
import {observationChanges} from '../packages/ai/src/controller/observation/changes.js';
import {classifyChanges} from '../packages/ai/src/controller/runtime/decision.js';import {AiStore,initialState,type GameGateway,type AiSnapshot} from '../packages/ai/src/index.js';
import {ProviderError} from '../packages/ai/src/controller/contracts/provider-error.js';
import type {ManualCommandReceipt} from '../packages/contracts/src/index.js';

function setup(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.match={mode:'mining',neptuniumGoal:200};

 return cfg;
}

test('authorized timers preserve mid-tick mining and shield orders in shared-engine predictions',()=>{
 for(const phase of [0,120.9,599.9]){
  let state=createFleetScenario(setup());const home=state.economy.outposts[0]!.id;
  const commandPhase=Math.trunc(phase);state.secondsSinceLastTick=commandPhase;
  state=submitFleetOrder(state,{id:'mine',player:0,action:{kind:'toggle-mine',outpostId:home}},commandPhase).state;
  state=submitFleetOrder(state,{id:'shield',player:0,action:{kind:'set-shields',outpostId:home,enabled:false}},commandPhase).state;
  const current=observation({state,scheduled:[]},0,'timers',phase+0.05),post=current.view.outposts.find(o=>o.id===home)!;
  assert.equal(post.minePending,true);assert.equal(post.shieldDisablePending,true);
  assert.equal(post.mineRemainingSeconds,(state.economy.outposts[0]!.mineSeconds??600)-Math.trunc(phase+0.05));
  assert.equal(post.shieldDisableRemainingSeconds,(state.economy.outposts[0]!.shieldDisableSeconds??600)-Math.trunc(phase+0.05));
  const local=createKnownPrediction(current);
  for(const tick of [current.view.tick+1,current.view.tick+2]){
   const predicted=local.predict(tick);assert.equal(predicted.status,'conditional');if(predicted.status!=='conditional')throw Error('Expected conditional result');
   const actual=observation({state:advanceFleetScenario(state,tick),scheduled:[]},0,'timers').view.outposts.find(o=>o.id===home)!;
   const shown=predicted.result.outposts.find(o=>o.id===home)!;
   assert.equal(shown.type,actual.type,`mine at ${phase}/${tick}`);assert.equal(shown.shieldsEnabled,actual.shieldsEnabled,`shield at ${phase}/${tick}`);
  }
  const malformed=structuredClone(current);delete malformed.view.outposts.find(o=>o.id===home)!.mineRemainingSeconds;
  assert.throws(()=>createKnownPrediction(malformed),/mine countdown/);
 }
});

test('countdown drift does not churn observation revisions or changes, while window transitions do',()=>{
 let state=createFleetScenario(setup());const home=state.economy.outposts[0]!.id;
 state=submitFleetOrder(state,{id:'shield',player:0,action:{kind:'set-shields',outpostId:home,enabled:false}},120).state;
 const before=observation({state,scheduled:[]},0,'revision',130),after=observation({state,scheduled:[]},0,'revision',140);
 assert.equal(before.revision,after.revision);
 assert.deepEqual(observationChanges(before,after).changes,[]);
 const crossed=structuredClone(after);crossed.view.outposts.find(o=>o.id===home)!.shieldDisableRemainingSeconds=0;
 assert.ok(JSON.stringify(observationChanges(after,crossed)).includes('shieldDisableRemainingSeconds'));
});

test('activity facts beyond the ten-entry tail survive storage restore, pagination and unacknowledged retries',async()=>{
 const cfg=setup();cfg.economy.outposts[1]!.owner=0;
 let state=createFleetScenario(cfg);const home=state.economy.outposts[0]!.id,target=state.economy.outposts[1]!.id;
 state=submitFleetOrder(state,{id:'delivered',player:0,action:{kind:'launch',source:home,destination:target,drillers:5}}).state;
 const fleetId=state.fleets.find(f=>f.used)!.id;
 state=advanceFleetScenario(state,state.economy.tick+40);
 for(let i=0;i<225;i++)state=submitFleetOrder(state,{id:`noise-${i}`,player:0,action:{kind:'set-shields',outpostId:home,enabled:i%2===1}}).state;
 assert.equal(projectPlayerActivity(state,0).length,10);
 assert.equal(projectPlayerActivity(state,0).some(e=>e.arrival),false);
 state=restoreFleetSnapshot(saveFleetSnapshot(state));
 const current=observation({state,scheduled:[]},0,'facts'),facts=new ActivityFacts();
 const baseline={roomId:current.roomId,player:current.view.player,activityCursor:0,manualVersion:current.manualCommands?.version};facts.baseline=()=>baseline;
 let pages=0;
 const read=async(after:number,through:number)=>{pages++;return projectPlayerActivityPage(state,0,after,through,100);};
 const first=await facts.hydrate(current,read);
 assert.ok(first.activity!.some(e=>e.subject===fleetId&&e.arrival?.outcome==='delivered'));assert.ok(pages>=3);
 const restarted=new ActivityFacts();restarted.baseline=()=>baseline;
 assert.deepEqual(await restarted.hydrate(current,read),first,'no model acknowledgement means facts must be supplied again');
 facts.baseline=()=>({roomId:first.roomId,player:first.view.player,activityCursor:first.activityCursor,manualVersion:first.manualCommands?.version});pages=0;
 assert.deepEqual((await facts.hydrate(current,read)).activity,current.activity);assert.equal(pages,0);
 assert.deepEqual(projectPlayerActivityPage(state,0,0,1,1).events.map(e=>e.id),[0]);
 assert.throws(()=>projectPlayerActivityPage(state,0,0,current.activityCursor!+1,100),/cursor/);
 const invalid=new ActivityFacts();invalid.baseline=()=>baseline;
 await assert.rejects(invalid.hydrate(current,async()=>({events:[],nextCursor:0,through:current.activityCursor,hasMore:true})),/Incomplete/);
 assert.deepEqual(await new ActivityFacts().hydrate(current,async()=>{throw Error('Unconfigured transport must not load all match history');}),current);
});

test('an entire fleet journey between observations still produces an authoritative arrival wake',()=>{
 const cfg=setup();cfg.economy.outposts[1]!.owner=0;
 let state=createFleetScenario(cfg);const before=observation({state,scheduled:[]},0,'between');
 const home=state.economy.outposts[0]!.id,target=state.economy.outposts[1]!.id;
 state=submitFleetOrder(state,{id:'whole-journey',player:0,action:{kind:'launch',source:home,destination:target,drillers:5}}).state;
 const fleetId=state.fleets.find(f=>f.used)!.id;
 state=advanceFleetScenario(state,state.economy.tick+40);
 const after=observation({state,scheduled:[]},0,'between');
 const wakes=classifyChanges(before,after).important.filter(s=>s.key===`arrival:${fleetId}`);
 assert.equal(wakes.length,1);assert.match(wakes[0]!.reason,/实际交付5兵力/);
 assert.equal(classifyChanges(after,after).important.some(s=>s.key===`arrival:${fleetId}`),false);
});

test('hidden outposts do not expose construction or shield clocks',()=>{
 const cfg=setup();cfg.size={width:80,height:80};cfg.positions[cfg.economy.outposts[1]!.id]={x:35,y:35};
 const current=observation({state:createFleetScenario(cfg),scheduled:[]},0,'visibility');
 const hidden=current.view.outposts.filter(o=>o.visibility!==2);assert.ok(hidden.length);
 for(const post of hidden)for(const key of ['mineRemainingSeconds','shieldDisablePending','shieldDisableRemainingSeconds'])assert.equal(Object.hasOwn(post,key),false);
});

test('first-call fact origins survive failed dispatch and both activity and manual tails rolling over',async()=>{
 let world=createFleetScenario(setup()),noise=0;const home=world.economy.outposts[0]!.id;
 const manualFacts:ManualCommandReceipt[]=[];
 const append=(count:number)=>{for(let i=0;i<count;i++,noise++){
  const action={kind:'set-shields' as const,outpostId:home,enabled:noise%2===1};
  world=submitFleetOrder(world,{id:`origin-${noise}`,player:0,action}).state;
  manualFacts.push({id:`manual:0:${noise+1}`,version:noise+1,player:0,tick:world.economy.tick,seconds:0,kind:'order',outcome:'applied',action,affectedFleetIds:[],cancelledScheduleIds:[]});
 }};
 append(20);
 const store=new AiStore(':memory:'),state=initialState('origin',0,{model:'synthetic',personality:'sentinel'});
 let delivered:AiSnapshot|undefined;
 const gateway=():GameGateway=>{
  const facts=new ActivityFacts();
  return {factBaseline:read=>{facts.baseline=read;},snapshot:async()=>{
   const current=observation({state:world,scheduled:[]},0,'origin');
   const receipts=manualFacts.slice(-10);
   current.manualCommands={version:manualFacts.length,receipts,protections:[],receiptsFromVersion:receipts[0]?.version??0,hasEarlierReceipts:receipts.length<manualFacts.length};
   delivered={observation:await facts.hydrate(current,async(after,through)=>projectPlayerActivityPage(world,0,after,through),async(after,limit)=>{
    const rows=manualFacts.slice(after,after+limit);return {version:manualFacts.length,receipts:rows,nextCursor:after+rows.length,hasMore:after+rows.length<manualFacts.length};
   }),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
   return delivered;
  },request:async()=>{throw Error('No game operations');}};
 };
 try{
  const runner=new SeatRunner(state,store,gateway(),{step:async()=>{throw new ProviderError('timeout','provider-call',{stage:'test-before-send',outcome:'not-sent'});}});
  await runner.poll(0,true);
  const origin=store.latest<{cursor:number;manualVersion:number}>('origin',0,'activity-facts-origin')!;
  assert.equal(origin.cursor,10);assert.equal(delivered!.observation.activity![0]!.id,10);
  assert.equal(origin.manualVersion,10);
  assert.equal(store.latest('origin',0,'decision-observation'),null);
  runner.pause();append(225);state.enabled=true;state.status='waiting';store.save(state,'resumed');
  let calls=0;
  const restarted=new SeatRunner(state,store,gateway(),{step:async()=>{calls++;return {tokens:0,reply:{tool:'finish',arguments:{},summary:'Facts received'}};}});
  await restarted.poll(60000,true);
  assert.equal(calls,1);assert.equal(delivered!.observation.activity![0]!.id,10);
  assert.equal(delivered!.observation.activity!.length,235);
  assert.equal(delivered!.observation.manualCommands!.receipts.length,235);
  assert.equal(delivered!.observation.manualCommands!.receipts[0]!.version,11);
  assert.equal(store.latest<{activityCursor:number}>('origin',0,'decision-observation')!.activityCursor,245);
 }finally{store.close();}
});
