
import {SeatRunner} from './helpers/scripted-controller.js';
import type {PlayerObservation} from '../packages/contracts/src/index.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analysisEfficiency,analysisKey,reportInput,routeInput,prepareAttackRoutes,StaleAnalysisResultError,DEFAULT_ANALYSIS_EFFICIENCY as config} from '../packages/ai/src/controller/analysis/analysis-efficiency.js';
import {screenAttacks} from '../packages/ai/src/controller/analysis/attack-screening.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {AiStore,initialState,type AiSnapshot} from '../packages/ai/src/index.js';

function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o:PlayerObservation=observation({state:createFleetScenario(setup),scheduled:[]},0,'efficiency');
 o.view.tick=0;o.view.size={width:40,height:40};o.view.fleets=[];
 o.view.outposts=[{id:'home',owner:0,position:{x:0,y:0},visibility:2,drillers:100,shield:0},
 {id:'enemy',owner:1,position:{x:19,y:0},visibility:2,drillers:100,shield:10},
 ...[1,2,3].map(i=>({id:`safe${i}`,owner:null,position:{x:i*.1,y:0},visibility:2,drillers:0,shield:0}))];
 o.outpostNames=Object.fromEntries(o.view.outposts.map(p=>[p.id,p.id]));return o;
}
test('efficiency config rejects unknown, invalid bounds and non-booleans',()=>{
 assert.deepEqual(analysisEfficiency(JSON.parse(readFileSync('config/ai-analysis-efficiency.example.json','utf8'))),config);
 for(const value of [{bad:1},{cacheReports:1},{maxSafeTargets:9},{historyEntries:0},{maxSafeDrillers:NaN}])assert.throws(()=>analysisEfficiency(value));
});
test('runner reuses unchanged reports across rounds, rescans enemy changes and honors prelaunch reminders',async()=>{
 const o=fixture(),store=new AiStore(':memory:'),state=initialState(o.roomId,0,{model:'',personality:'raider'});let routes=0,calls=0;
 // Count committed journal rows, not one save implementation: report events
 // may share an atomic saveEvents transaction with derived observer state.
 const events=()=>{const kinds:string[]=[];let before:number|undefined;for(;;){const page=store.historyPage(o.roomId,0,before);kinds.push(...page.entries.map(e=>e.kind));if(page.nextCursor===null)return kinds;before=page.nextCursor;}};
 const snapshot=():AiSnapshot=>({observation:structuredClone(o),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2});
 const runner=new SeatRunner(state,store,{snapshot:async()=>snapshot(),request:async()=>null,attackRoutes:async obs=>{routes++;return attackRoutes(obs);}},{step:async()=>{calls++;return {tokens:1,reply:{tool:'finish',arguments:calls===1?JSON.stringify({reminders:{set:[{id:'launch-check',atWorldDay:1,note:'出航前重新检查敌方守军',category:'military',entities:['enemy']}]}}):store.reminders(o.roomId,0).some(r=>r.id==='launch-check'&&r.atSeconds<=o.view.tick*600+o.secondsSinceLastTick)?'{'+'"reminders":{"complete":["launch-check"]}}':'{}',summary:'完成'}};}});
 try{
  await runner.pollAndFlush(0);await runner.pollAndFlush(6000,true);assert.equal(routes,1);assert.equal(calls,2);
  assert.equal(events().filter(k=>k==='opening-report').length,0);
  o.view.outposts[1]!.drillers=200;o.revision='enemy-reinforced';await runner.pollAndFlush(12000,true);assert.equal(routes,1);
  assert.equal(events().filter(k=>k==='attack-screening').length,2);
  o.view.tick=1;o.secondsSinceLastTick=0;await runner.pollAndFlush(18000);await runner.pollAndFlush(19000);assert.equal(calls,4);
  assert.equal(events().filter(k=>k==='attack-screening').length,3,'changed world time invalidates the complete round screening');
  assert.equal(store.reminders(o.roomId,0).length,0);
 }finally{store.close();}
});

test('stale route reads are discarded and retried fresh without model calls or game writes',async()=>{
 const o=fixture(),store=new AiStore(':memory:'),state=initialState(o.roomId,0,{model:'',personality:'raider'});let reads=0,calls=0,writes=0;
 const runner=new SeatRunner(state,store,{
  snapshot:async()=>({observation:structuredClone(o),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2}),
  request:async()=>{writes++;return null;},
  attackRoutes:async obs=>{const routes=attackRoutes(obs);if(++reads<=2)routes.revision='stale';return routes;}
 },{step:async()=>{calls++;return {tokens:1,reply:{tool:'finish',arguments:'{}',summary:'完成'}};}});
 try{
  await runner.pollAndFlush(0,true);
  let failure=store.latest<any>(o.roomId,0,'error');
  assert.equal(failure.code,'analysis-stale');assert.equal(failure.recovery.delayMs,15000);assert.equal(runner.recovering,true);
  assert.equal(store.latest<any>(o.roomId,0,'analysis-cache').discarded,'stale-result');
  await runner.pollAndFlush(Date.parse(failure.recovery.at)-1,true);assert.equal(reads,1);
  o.revision='fresh-state';await runner.pollAndFlush(Date.parse(failure.recovery.at)+1,true);
  failure=store.latest<any>(o.roomId,0,'error');assert.equal(failure.recovery.delayMs,30000);assert.equal(reads,2);assert.equal(calls,0);assert.equal(writes,0);
  await runner.pollAndFlush(Date.parse(failure.recovery.at)+1,true);
  assert.equal(reads,3);assert.equal(calls,1);assert.equal(writes,0);assert.equal(state.status,'waiting');assert.equal(state.error,null);assert.equal(runner.recovering,false);
 }finally{store.close();}
});

test('cross-room route results stay fail-closed; same-room revision and tick mismatches may retry',async()=>{
 const {StaleAnalysisResultError}=await import('../packages/ai/src/controller/analysis/analysis-efficiency.js');
 const {recoveryDelay}=await import('../packages/ai/src/controller/runtime/recovery.js');
 const o=fixture();
 for(const change of [{revision:'old'},{observedTick:o.view.tick+1},{roomId:'another-room'}]){
  const routes={...attackRoutes(o),...change};
  assert.throws(()=>screenAttacks(o,routes),(error:unknown)=>{
   assert.ok(error instanceof StaleAnalysisResultError);
   assert.equal(recoveryDelay(error,1),'roomId' in change?null:15000);return true;
  });
 }
 assert.equal(recoveryDelay(new Error('unknown command outcome'),1),null);
});



test('a continued route race discards once without poisoning cache or retrying a write',async()=>{
 const before=fixture(),routes={...attackRoutes(before),revision:'intermediate'},latest={...before,revision:'latest'};
 const cached=attackRoutes(before),cache={routeKey:'unrelated',routes:cached};let reads=0,refreshes=0;
 await assert.rejects(prepareAttackRoutes(before,{attackTicks:108,localTicks:48,holdTicks:24},cache,async()=>{reads++;return routes;},true,async()=>{refreshes++;return latest;}),StaleAnalysisResultError);
 assert.equal(reads,1);assert.equal(refreshes,1);assert.equal(cache.routeKey,'unrelated');assert.equal(cache.routes,cached);
});

test('cache dependencies retain enemy force, shield, orders and prelaunch time; geometry ignores garrisons',()=>{
 const o=fixture(),key=analysisKey(reportInput(o)),route=analysisKey(routeInput(o));
 o.revision='metadata-only';assert.equal(analysisKey(reportInput(o)),key);
 for(const mutate of [(v:typeof o)=>v.view.outposts[1]!.drillers!++, (v:typeof o)=>v.view.outposts[1]!.shield!++, (v:typeof o)=>v.secondsSinceLastTick++, (v:typeof o)=>v.view.tick++]){
   const changed=structuredClone(o);mutate(changed);assert.notEqual(analysisKey(reportInput(changed)),key);
 }
 o.view.outposts[1]!.drillers=200;assert.equal(analysisKey(routeInput(o)),route);
 o.view.outposts[1]!.owner=0;assert.notEqual(analysisKey(routeInput(o)),route);
});
