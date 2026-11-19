import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {shieldRecoveryBounds,shieldRechargeStep,shieldChargePeriod,RULES} from '../packages/rules/src/index.js';
import {reconcileCampaigns,campaignReservations,type Campaign} from '../packages/ai/src/controller/storage/campaign-state.js';
import {basicRouteTicks} from '../packages/prediction/src/index.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import type {AttackRoutes,PlayerObservation} from '../packages/contracts/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {routeEstimate} from '../packages/server/src/inspection.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {screenAttacks,screeningDrafts,screeningClass} from '../packages/ai/src/controller/analysis/attack-screening.js';
import {attackScreeningConfig,loadAttackScreeningConfig,screeningConfigId} from '../packages/ai/src/controller/analysis/attack-screening-config.js';
import {AiStore,SeatRunner,initialState,PlayerGateway,executeTool,type AiSnapshot,type AgentRequest} from '../packages/ai/src/index.js';

function fixture(){
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};
  const room={state:createFleetScenario(cfg),scheduled:[]};
  const obs:PlayerObservation=observation(room,0,'room');
  return {room,obs};
}
function simple(){
  const {obs}=fixture();obs.view.outposts=[
    {id:'home',owner:0,position:{x:0,y:0},visibility:2,type:'factory',drillers:100,shield:0},
    {id:'weak',owner:1,position:{x:1,y:0},visibility:2,type:'factory',drillers:5,shield:0},
    {id:'strong',owner:1,position:{x:2,y:0},visibility:2,type:'factory',drillers:40,shield:20},
  ];obs.view.fleets=[];
  obs.outpostNames=Object.fromEntries(obs.view.outposts.map(p=>[p.id,p.id]));
  const routes:AttackRoutes={roomId:obs.roomId,revision:obs.revision,observedTick:obs.view.tick,maxTicks:144,basis:'ordinary-speed-public-geometry',postTicks:{home:{weak:10,strong:10},weak:{home:null,strong:144},strong:{home:null,weak:144}},fleetTicks:{}};
  return {obs,routes};
}

test('a high-value force deficit cannot outrank an ordinary force advantage; existing actions keep value',()=>{
 const {obs,routes}=simple();obs.view.outposts[2]!.drillers=500;
 obs.view.outposts[2]!.type='generator';
 const report=screenAttacks(obs,routes,attackScreeningConfig({value:{generator:1000,factory:0},weights:{value:100,attackBalance:0,holdBalance:0,speed:0,confidence:0,lowExposure:0}}));
 const weak=report.ranked.find(p=>p.target==='weak')!,strong=report.ranked.find(p=>p.target==='strong')!;
 assert.equal(screeningClass(weak),'action');assert.equal(screeningClass(strong),'conditional');
 assert.ok(strong.score>weak.score);assert.equal(report.ranked[0]!.target,'weak');
 assert.equal(screeningClass({...weak,holdMargin:0}),'conditional');
 assert.equal(screeningClass({...weak,existingOperation:true}),'review');
});

test('mine investment value reaches ranking and readable reasons while factory values stay unchanged',()=>{
  const {obs,routes}=simple();obs.view.outposts[1]!.type='mine';
  const disabled=attackScreeningConfig({mineValue:{replacementPerBaseCost:0,incomePerNeptunium:0,denialPerNeptunium:0}});
  const before=screenAttacks(obs,routes,disabled),after=screenAttacks(obs,routes);
  const mine=after.ranked.find(p=>p.target==='weak')!,factory=after.ranked.find(p=>p.target==='strong')!;
  assert.ok(mine.components.value!>before.ranked.find(p=>p.target==='weak')!.components.value!);
  assert.ok(mine.valueBreakdown.mineInvestment!.total>0);
  assert.ok(mine.reasons.some(r=>r.includes('节省自建')&&r.includes('非保证收益')));
  assert.deepEqual(factory.components,before.ranked.find(p=>p.target==='strong')!.components);
  assert.equal(factory.valueBreakdown.mineInvestment,null);
  assert.equal(mine.attackMargin,before.ranked.find(p=>p.target==='weak')!.attackMargin);
  assert.equal(mine.holdMargin,before.ranked.find(p=>p.target==='weak')!.holdMargin);
});
test('ranking responds to troops, shield, route time and same-owner reinforcement; third parties remain separate',()=>{
  const {obs,routes}=simple();
  const initial=screenAttacks(obs,routes);assert.equal(initial.ranked[0]!.target,'weak');
  const score=initial.ranked.find(p=>p.target==='weak')!.score;
  obs.view.outposts[1]!.shield=80;
  assert.ok(screenAttacks(obs,routes).ranked.find(p=>p.target==='weak')!.score<score);
  obs.view.outposts[1]!.shield=0;routes.postTicks.home!.weak=80;
  assert.ok(screenAttacks(obs,routes).ranked.find(p=>p.target==='weak')!.score<score);
  routes.postTicks.home!.weak=10;routes.postTicks.strong!.weak=5;
  const reinforced=screenAttacks(obs,routes).ranked.find(p=>p.target==='weak')!;
  assert.ok(reinforced.defense.enemyBefore>0);assert.ok(reinforced.score<score);
  obs.view.outposts[2]!.owner=2;
  const third=screenAttacks(obs,routes).ranked.find(p=>p.target==='weak')!;
  assert.equal(third.defense.enemyBefore,0);assert.equal(third.support.length,0);assert.equal(third.thirdParties.length,1);
});
test('unknown garrisons are estimated, not zero; reserves and scheduled commitments prevent fictional spare armies',()=>{
  const {obs,routes}=simple();delete obs.view.outposts[1]!.drillers;delete obs.view.outposts[1]!.shield;
  const unknown=screenAttacks(obs,routes).ranked.find(p=>p.target==='weak')!;
  assert.equal(unknown.defense.observedDrillers,null);assert.ok(unknown.defense.estimatedWithProductionAndShield>0);assert.ok(unknown.confidence<1);
  assert.ok(unknown.tags.includes('reconnaissance'));
  assert.equal(unknown.sources[0]!.available,100); // No visible threat can reach home inside the defense horizon.
  obs.scheduled.push({id:'committed',player:0,issueTick:101,status:'pending',action:{kind:'launch',source:'home',destination:'weak',drillers:90}});
  const committed=screenAttacks(obs,routes);assert.equal(committed.sourceReserves[0]!.available,10);assert.equal(committed.sourceReserves[0]!.pendingReserved,90);assert.ok(committed.ranked.every(p=>p.sources.every(s=>s.available<=10)));
});
test('candidate selection retains a high-value unknown outside top N and never mutates observation',()=>{
  const {obs,routes}=simple();delete obs.view.outposts[2]!.drillers;delete obs.view.outposts[2]!.shield;
  const before=JSON.stringify(obs),config=attackScreeningConfig({limits:{candidates:1}});
  const report=screenAttacks(obs,routes,config);
  assert.equal(report.candidates[0]!.target,'weak');assert.ok(report.candidates.some(p=>p.tags.includes('reconnaissance')));
  assert.equal(JSON.stringify(obs),before);
  assert.throws(()=>screenAttacks(obs,{...routes,revision:'old'}),/Stale/);
});
test('existing operations retain their score and move to review; neutral shields do not regenerate',()=>{
  const {obs,routes}=simple();const target=obs.view.outposts[1]!;target.owner=null;target.drillers=0;target.shield=0;target.shieldMax=20;
  const before=screenAttacks(obs,routes).ranked.find(p=>p.target==='weak')!;
  assert.equal(before.defense.estimatedWithProductionAndShield,0);
  obs.view.fleets.push({id:'already-sent',owner:0,drillers:20,position:{x:0,y:0},state:'moving',gift:false,destination:{kind:'outpost',id:'weak'}});routes.fleetTicks['already-sent']=2;
  const after=screenAttacks(obs,routes).ranked.find(p=>p.target==='weak')!;
  assert.equal(after.existingOperation,true);assert.ok(after.score>=before.score);
  obs.view.fleets[0]!.owner=1;
  const contested=screenAttacks(obs,routes).ranked.find(p=>p.target==='weak')!;
  assert.equal(contested.contested,true);assert.equal(contested.assessment,'ownership-may-change-before-arrival');
});
test('configuration is isolated, strictly validated, reloadable and changes priorities',()=>{
  const {obs,routes}=simple();obs.view.outposts[1]!.type='generator';obs.view.outposts[2]!.drillers=5;obs.view.outposts[2]!.shield=0;
  const a=attackScreeningConfig(),b=attackScreeningConfig({value:{generator:100,factory:0}});
  assert.equal(screenAttacks(obs,routes,a).ranked[0]!.target,'strong');assert.equal(screenAttacks(obs,routes,b).ranked[0]!.target,'weak');
  assert.notEqual(screeningConfigId(a),screeningConfigId(b));assert.equal(a.value.factory,28);
  assert.deepEqual(loadAttackScreeningConfig('config/ai-attack-screening.example.json'),a);
  const scaled=attackScreeningConfig({weights:Object.fromEntries(Object.entries(a.weights).map(([k,v])=>[k,v/10000]))});
  assert.deepEqual(screenAttacks(obs,routes,scaled).ranked.map(p=>p.score),screenAttacks(obs,routes,a).ranked.map(p=>p.score));
  for(const invalid of [{weights:{typo:1}},{force:{enemyMobilization:2}},{limits:{attackTicks:145}},{force:{unknownDrillers:0}},{weights:{value:0,attackBalance:0,holdBalance:0,speed:0,confidence:0,lowExposure:0}}])assert.throws(()=>attackScreeningConfig(invalid));
  const dir=mkdtempSync(join(tmpdir(),'attack-config-')),file=join(dir,'config.json');
  try{writeFileSync(file,'{"value":{"factory":50}}');assert.equal(loadAttackScreeningConfig(file).value.factory,50);writeFileSync(file,'{"value":{"factory":60}}');assert.equal(loadAttackScreeningConfig(file).value.factory,60);}finally{rmSync(dir,{recursive:true});}
});
test('route matrix reuses ordinary engine timing, wraps the map and ignores hidden state',()=>{
  const {room,obs}=fixture(),routes=attackRoutes(obs);
  const from=obs.view.outposts[0]!,to=obs.view.outposts[1]!;
  assert.equal(routes.postTicks[from.id]![to.id],routeEstimate(room.state,{source:from.id,point:to.position,issueTick:obs.view.tick}).arrivalTick!-obs.view.tick);
  const wrapped=structuredClone(obs);wrapped.view.outposts[1]!.position.x+=wrapped.view.size.width;
  assert.equal(attackRoutes(wrapped).postTicks[from.id]![to.id],routes.postTicks[from.id]![to.id]);
  const changed=structuredClone(obs);changed.view.outposts[1]!.drillers=99999;
  assert.deepEqual(attackRoutes(changed),routes);
});


test('bounded frontier routes equal full engine routes inside requested windows and omit remote support pairs',()=>{
  const {obs}=simple();obs.view.tick=100;obs.view.size={width:20,height:20};
  obs.view.outposts[1]!.position={x:0.1,y:0};obs.view.outposts[2]!.position={x:8,y:8};
  const windows={attackTicks:18,localTicks:12,holdTicks:6},r=attackRoutes(obs,windows);
  assert.equal(r.postTicks.home!.strong,null);assert.equal(r.postTicks.weak!.strong,undefined);
  for(const from of obs.view.outposts)for(const to of obs.view.outposts){
    const actual=r.postTicks[from.id]?.[to.id];if(actual===undefined)continue;
    const limit=from.owner===0?18:to.owner===0?12:24;
    assert.equal(actual,basicRouteTicks(from.position,to.position,obs.view.size,100,limit));
  }
  const {routes}=simple();routes.postTicks.home!.weak=70;routes.postTicks.home!.strong=90;
  const ranked=screenAttacks(obs,routes).ranked;
  assert.equal(ranked.find(p=>p.target==='weak')!.range,'near');assert.equal(ranked.find(p=>p.target==='strong')!.range,'preparation');
});

const plan=(obs:PlayerObservation):Campaign=>({id:'take-weak',target:'weak',objective:'夺厂形成胜势',holdPlan:'占领后增援',cancelWhen:'敌方增援超过预算',stage:'assembling',createdTick:obs.view.tick,reviewAtTick:obs.view.tick+12,allocations:[{source:'home',drillers:30}],accountedFleets:[],issues:[]});

test('shared proposals never double-spend and only accepted schedules reduce the candidate budget',()=>{
  const {obs,routes}=simple(),report=screenAttacks(obs,routes);
  const used=report.budget.proposals.flatMap(p=>p.allocations).reduce((n,a)=>n+a.drillers,0);
  assert.ok(used<=report.sourceReserves[0]!.available);
  const reserved=screenAttacks(obs,routes,undefined,[plan(obs)]);
  assert.equal(reserved.sourceReserves[0]!.available,report.sourceReserves[0]!.available,'unbooked plans reserve nothing');
  obs.scheduled.push({id:'actual-booking',player:0,status:'pending',issueTick:101,action:{kind:'launch',source:'home',destination:'weak',drillers:30}});
  assert.equal(screenAttacks(obs,routes).sourceReserves[0]!.available,report.sourceReserves[0]!.available-30);
  for(const candidate of reserved.ranked)assert.equal(candidate.sources[0]!.available,reserved.sourceReserves[0]!.available);
});

test('campaign reconciliation consumes departures once, tracks capture, losses and due review',()=>{
  const {obs}=simple(),p=plan(obs);
  obs.view.fleets.push({id:'departed',owner:0,source:'home',destination:{kind:'outpost',id:'weak'},drillers:20,gift:false,state:'moving',position:{x:0,y:0}} as any);
  let plans=reconcileCampaigns([p],obs);assert.equal(campaignReservations(plans).home,10);
  plans=reconcileCampaigns(plans,obs);assert.equal(campaignReservations(plans).home,10);
  obs.view.outposts[1]!.owner=0;assert.equal(reconcileCampaigns(plans,obs)[0]!.stage,'holding');
  obs.view.outposts[0]!.owner=1;assert.equal(reconcileCampaigns(plans,obs)[0]!.stage,'review');
  obs.view.outposts[0]!.owner=0;obs.view.tick=p.reviewAtTick;assert.equal(reconcileCampaigns(plans,obs)[0]!.stage,'review');
  assert.equal(p.allocations[0]!.drillers,30);
});


test('arrival shield follows discrete recharge instead of replacing current charge with capacity',()=>{
  const {obs,routes}=simple();obs.view.tick=96;routes.observedTick=96;routes.postTicks.home!.weak=83;
  Object.assign(obs.view.outposts[1]!,{shield:1,shieldMax:20,drillers:12,metrics:{active:true,paused:false,output:6,cycleMinutes:480,nextMinutes:100}});
  const target=screenAttacks(obs,routes).ranked.find(p=>p.target==='weak')!;
  assert.equal(shieldChargePeriod(20),14);
  assert.deepEqual(target.defense.shieldAtArrival,{minimum:6,maximum:7,basis:'shared-rule-unknown-progress'});
  assert.equal(target.defense.productionUpperBound,12);assert.equal(target.defense.estimatedWithProductionAndShield,31);
  assert.equal(shieldRecoveryBounds(1,20,96,1).maximum,2);
  assert.deepEqual(shieldRecoveryBounds(20,20,96,83),{minimum:20,maximum:20});
  assert.deepEqual(shieldRecoveryBounds(0,0,96,83),{minimum:0,maximum:0});
  obs.view.outposts[1]!.shieldsEnabled=false;
  assert.equal(screenAttacks(obs,routes).ranked.find(p=>p.target==='weak')!.defense.shieldUsed,1);
  obs.view.outposts[1]!.shieldsEnabled=true;obs.view.outposts[1]!.owner=null;
  assert.equal(screenAttacks(obs,routes).ranked.find(p=>p.target==='weak')!.defense.shieldUsed,1);
});

test('shield bounds enclose discrete timer phases, speedup transition and changed-capacity timers',()=>{
  for(const maximum of [0,10,20,40,400])for(const tick of [0,70,71,72,96])for(const duration of [0,1,2,13,14,83]){
    const bounds=shieldRecoveryBounds(0,maximum,tick,duration),period=shieldChargePeriod(maximum)??0;
    for(let progress=0;progress<=Math.max(2*period,1);progress++){
      let state={charge:0,progress};
      for(let i=1;i<=duration;i++)state=shieldRechargeStep(state.charge,state.progress,maximum,tick+i>RULES.GameParams.GameStartSpeedupTicks?1:RULES.GameParams.GameStartSpeedupFactor);
      assert.ok(state.charge>=bounds.minimum&&state.charge<=bounds.maximum,JSON.stringify({maximum,tick,duration,progress,bounds,state}));
    }
  }
});


test('enemy waiting troops defend their source without also reinforcing their planned destination',()=>{
 const {obs,routes}=simple();
 obs.view.fleets.push({id:'enemy-waiting',owner:1,drillers:34,position:{...obs.view.outposts[1]!.position},state:'waiting',gift:false,destination:{kind:'outpost',id:'strong'}});
 routes.fleetTicks['enemy-waiting']=1;
 const before=JSON.stringify(obs),report=screenAttacks(obs,routes);
 const source=report.ranked.find(p=>p.target==='weak')!,destination=report.ranked.find(p=>p.target==='strong')!;
 assert.equal(source.defense.observedDrillers,5);
 assert.equal(source.defense.recallableWaitingDrillers,34);
 assert.equal(source.defense.estimatedWithProductionAndShield,39);
 assert.equal(destination.incoming.some(f=>f.id==='enemy-waiting'),false);
 assert.equal(JSON.stringify(obs),before);
 obs.view.fleets[0]!.state='moving';
 const departed=screenAttacks(obs,routes);
 assert.equal(departed.ranked.find(p=>p.target==='weak')!.defense.recallableWaitingDrillers,0);
 assert.equal(departed.ranked.find(p=>p.target==='strong')!.incoming[0]!.drillers,34);
});


test('source defense follows visible attack waves and shields, never a fraction of own garrison',()=>{
  const {obs,routes}=simple();
  assert.equal(screenAttacks(obs,routes).sourceReserves[0]!.available,100);
  routes.postTicks.strong!.home=12;obs.view.outposts[0]!.shield=10;
  let home=screenAttacks(obs,routes).sourceReserves[0]!;
  assert.equal(home.reserve,30);assert.equal(home.available,70);
  obs.view.outposts[0]!.drillers=200;
  assert.equal(screenAttacks(obs,routes).sourceReserves[0]!.reserve,30);
  obs.view.outposts[0]!.shield=50;
  assert.equal(screenAttacks(obs,routes).sourceReserves[0]!.reserve,0);
  obs.view.outposts[0]!.shield=0;obs.view.outposts[0]!.drillers=20;
  home=screenAttacks(obs,routes).sourceReserves[0]!;
  assert.equal(home.available,0);assert.equal(home.defense.shortfall,20);
  assert.deepEqual(home.defense.threats.map(t=>[t.id,t.ticks,t.force]),[['strong',12,40]]);
});

test('gathering compares two-leg timing, combines current troops once and drafts transfers before attack',()=>{
  const {obs,routes}=simple();obs.view.outposts=obs.view.outposts.slice(0,2);
  obs.view.outposts[1]!.drillers=100;
  obs.view.outposts.push({...obs.view.outposts[0]!,id:'rear'});
  routes.postTicks.home={weak:10,rear:15};routes.postTicks.rear={home:15,weak:65};
  const before=JSON.stringify(obs),report=screenAttacks(obs,routes),target=report.ranked[0]!;
  assert.equal(target.plan.kind,'gather');assert.equal(target.plan.hub,'home');
  assert.equal(target.sourceForce,200);assert.equal(target.plan.gatherTicks,16);
  assert.equal(target.timing.attackTicks,26);
  const drafts=screeningDrafts(target,obs.view.tick);
  assert.deepEqual(drafts.map(d=>[d.action.source,d.action.destination,d.action.drillers,d.issueTick-obs.view.tick]),[['rear','home',100,0],['home','weak',200,16]]);
  const proposal=report.budget.proposals[0]!;
  assert.equal(proposal.plan.kind,'gather');
  assert.equal(JSON.stringify(obs),before);
  // A blocked transfer cannot be counted as a new independent order.
  obs.view.fleets.push({id:'pending-transfer',source:'rear',owner:0,state:'waiting',drillers:1,gift:false,position:{x:0,y:0},destination:{kind:'outpost',id:'home'}});
  const blocked=screenAttacks(obs,routes).ranked[0]!;
  assert.ok(blocked.plan.kind==='direct'||blocked.plan.hub!=='home');
});

test('force-rich sources within the synchronization window beat the nearest small garrisons',()=>{
  const {obs,routes}=simple();obs.view.outposts=obs.view.outposts.slice(0,2);obs.view.outposts[0]!.drillers=2;
  for(let i=0;i<4;i++){
    const id=`rear${i}`;obs.view.outposts.push({...obs.view.outposts[0]!,id,drillers:20+i*10});routes.postTicks[id]={weak:11+i};
  }
  const target=screenAttacks(obs,routes).ranked[0]!;
  assert.equal(target.sourceForce,120);assert.equal(target.sources.length,3);
  const drafts=screeningDrafts(target,obs.view.tick);
  for(const d of drafts)assert.equal(d.issueTick-obs.view.tick+routes.postTicks[d.action.source]!.weak!,target.timing.attackTicks);
});
