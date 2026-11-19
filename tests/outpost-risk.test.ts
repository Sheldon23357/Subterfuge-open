import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import type {AttackRoutes} from '../packages/contracts/src/index.js';
import {createKnownForceRouteEstimator,attackRoutes} from '../packages/prediction/src/index.js';
import {createOutpostRiskAnalysis} from '../packages/ai/src/controller/analysis/outpost-risk.js';
import {DEFAULT_OUTPOST_RISK,outpostRiskConfig,loadOutpostRiskConfig} from '../packages/ai/src/controller/analysis/outpost-risk-config.js';
import {botGarrisonPolicy,botCommitmentCost} from '../packages/ai/src/controller/analysis/tactical-force-policy.js';
import {evaluateBotFrame} from '../packages/ai/src/controller/analysis/tactical-evaluation.js';
import {mineHoldingAssessment} from '../packages/ai/src/controller/analysis/mine-strategy.js';
import {internalTroopCandidates} from '../packages/ai/src/controller/analysis/internal-transfers.js';

function fixture(){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 c.size={width:80,height:80};c.match={mode:'mining',neptuniumGoal:200};
 const template=c.economy.outposts[0]!;
 const entries=[['home',0,20,0],['support1',0,100,0.5],['support2',0,50,1.5],['enemy1',1,40,0.25],['enemy2',1,60,1],['enemy3',1,100,2.5]] as const;
 c.positions=Object.fromEntries(entries.map(([id,_owner,_drillers,x])=>[id,{x,y:0}]));
 c.economy.outposts=entries.map(([id,owner,drillers])=>({...template,id,owner,drillers,type:'generator',shield:id==='home'?10:0,shieldMax:id==='home'?10:0}));
 const o=observation({state:createFleetScenario(c),scheduled:[]},0,'risk-fixture');
 const routes:AttackRoutes={roomId:o.roomId,revision:o.revision,observedTick:o.view.tick,maxTicks:144,basis:'ordinary-speed-public-geometry',
  postTicks:Object.fromEntries(entries.map(([id])=>[id,Object.fromEntries(entries.filter(([other])=>other!==id).map(([other])=>[other,null]))])),fleetTicks:{}};
 for(const [id,ticks] of [['support1',10],['support2',20],['enemy1',5],['enemy2',15],['enemy3',30]] as const){routes.postTicks[id]!.home=ticks;routes.postTicks.home![id]=ticks;}
 return {o,routes};
}

test('risk sums inner and discounted outer forces against two discounted support points',()=>{
 const {o,routes}=fixture(),before=structuredClone(o),risks=createOutpostRiskAnalysis(o,undefined,routes),r=risks.get('home');
 assert.equal(r.defense,90);assert.equal(r.enemy,70);assert.equal(r.pressureRatio,70/90);
 assert.deepEqual(r.support.map(s=>[s.id,s.weighted]),[['support1',50],['support2',10]]);
 assert.equal(r.shortfall,0);assert.deepEqual(o,before);
 const tuned=createOutpostRiskAnalysis(o,outpostRiskConfig({firstSupportWeight:0,secondSupportWeight:0,outerEnemyWeight:1}),routes).get('home');
 assert.equal(tuned.defense,30);assert.equal(tuned.enemy,100);assert.equal(tuned.shortfall,70);
 o.view.outposts[0]!.type='mine';const mine=createOutpostRiskAnalysis(o,undefined,routes).get('home');
 assert.equal(mine.defense,r.defense);assert.equal(mine.enemy,r.enemy);assert.equal(mine.priority,r.priority*1.5);
});

test('unreachable support does not mark every local pressure estimate as incomplete',()=>{
 const {o,routes}=fixture();
 o.scheduled.push({id:'mine-later',player:0,status:'pending',issueTick:o.view.tick+10,action:{kind:'toggle-mine',outpostId:'support1'}});
 routes.postTicks.support1!.home=null;
 const distant=createOutpostRiskAnalysis(o,undefined,routes).get('home');
 assert.ok(!distant.unknowns.includes('commitment:support1'));
 routes.postTicks.support1!.home=10;
 const nearby=createOutpostRiskAnalysis(o,undefined,routes).get('home');
 assert.ok(nearby.unknowns.includes('commitment:support1'));
 assert.ok(!nearby.support.some(s=>s.id==='support1'),'unknown reservation costs remain excluded from available support');
});

test('reservations and in-flight reinforcements consume distinct physical inventories',()=>{
 const {o,routes}=fixture();o.view.outposts[1]!.drillers=80;
 o.view.fleets.push({id:'delivery',owner:0,drillers:20,position:{x:0.1,y:0},state:'moving',gift:false,destination:{kind:'outpost',id:'home'}});
 routes.fleetTicks.delivery=5;
 o.scheduled.push({id:'booked',player:0,status:'pending',issueTick:o.view.tick+2,action:{kind:'launch',source:'support1',destination:'enemy1',drillers:30}});
 const r=createOutpostRiskAnalysis(o,undefined,routes).get('home');
 assert.equal(r.friendlyIncoming,20);assert.equal(r.support[0]!.available,50);assert.equal(r.defense,85);
 assert.equal(o.view.outposts[1]!.drillers,80);
 o.view.outposts.find(p=>p.id==='enemy1')!.drillers=25;
 o.view.fleets.push({id:'enemy-fleet',owner:1,drillers:15,position:{x:0.1,y:0},state:'moving',gift:false,destination:{kind:'outpost',id:'home'}});routes.fleetTicks['enemy-fleet']=5;
 assert.equal(createOutpostRiskAnalysis(o,undefined,routes).get('home').enemy,70,'the launched force is counted once as a fleet and its source is already debited');
});

test('a large late reinforcement cannot hide the earlier observed attack deficit',()=>{
 const {o,routes}=fixture();
 o.view.fleets=[{id:'attack',owner:1,drillers:60,position:{x:0.1,y:0},state:'moving',gift:false,destination:{kind:'outpost',id:'home'}},
  {id:'late',owner:0,drillers:200,position:{x:0.5,y:0},state:'moving',gift:false,destination:{kind:'outpost',id:'home'}}];
 routes.fleetTicks={attack:2,late:8};
 const risks=createOutpostRiskAnalysis(o,undefined,routes),r=risks.get('home');
 assert.ok(r.defense>r.enemy);assert.equal(r.earliestDeficitTicks,2);assert.equal(r.arrivalShortfall,31);
 assert.equal(botGarrisonPolicy(o,'home',risks).desired,51);
 routes.fleetTicks.late=1;assert.equal(createOutpostRiskAnalysis(o,undefined,routes).get('home').arrivalShortfall,0);
});

test('default pressure window includes visible forces through day 144',()=>{
 const {o,routes}=fixture();o.view.outposts=o.view.outposts.filter(p=>!p.id.startsWith('support'));
 routes.postTicks.enemy1!.home=58;routes.postTicks.enemy2!.home=92;routes.postTicks.enemy3!.home=144;
 const short=createOutpostRiskAnalysis(o,outpostRiskConfig({horizonTicks:48}),routes).get('home');
 assert.equal(short.enemy,0);
 const risks=createOutpostRiskAnalysis(o,undefined,routes),expanded=risks.get('home');
 assert.equal(risks.config.horizonTicks,144);assert.equal(expanded.enemy,200);assert.ok(expanded.pressureRatio>0);
 routes.postTicks.enemy3!.home=145;
 assert.equal(createOutpostRiskAnalysis(o,undefined,routes).get('home').enemy,100);
});

test('missing support uses a bounded horizon and unknown forces stay explicit',()=>{
 const {o,routes}=fixture();o.view.outposts=o.view.outposts.filter(p=>!p.id.startsWith('support'));
 const r=createOutpostRiskAnalysis(o,undefined,routes).get('home');
 assert.equal(r.support.length,0);assert.equal(r.enemy,200);assert.equal(r.requiredGarrison,190);
 delete o.view.outposts.find(p=>p.id==='enemy2')!.drillers;
 const unknown=createOutpostRiskAnalysis(o,undefined,routes).get('home');
 assert.ok(unknown.unknowns.includes('garrison:enemy2'));assert.equal(unknown.enemy,140);
});

test('mine holding, garrisons and exposure share the same risk calculation',()=>{
 const {o,routes}=fixture();o.view.outposts[0]!.type='mine';o.view.outposts[0]!.drillers=0;
 const r=createOutpostRiskAnalysis(o,undefined,routes),home=r.get('home');
 assert.equal(botGarrisonPolicy(o,'home',r).desired,home.requiredGarrison);
 const holding=mineHoldingAssessment(o,o.view,r)!;
 assert.equal(holding.mines[0]!.shortfall,home.shortfall);
 const score=evaluateBotFrame(o,o.view);assert.ok(Number.isFinite(score.components.exposure));
 const drafts=[{id:'move',issueTick:o.view.tick,action:{kind:'launch',source:'support1',destination:'enemy1',drillers:100}}];
 assert.ok(botCommitmentCost(o,drafts,null,r).shortfall>0,'removing a donor exposes its neighbours too');
});





test('risk configuration validates fractions and reloads explicit tuning',()=>{
 for(const patch of [{firstSupportWeight:2},{secondSupportWeight:0.8},{outerEnemyWeight:-1},{mineMultiplier:0.5},{horizonTicks:145},{targetLimit:0},{bad:1}])assert.throws(()=>outpostRiskConfig(patch));
 const dir=mkdtempSync(join(tmpdir(),'outpost-risk-')),file=join(dir,'risk.json');
 try{writeFileSync(file,'{"firstSupportWeight":0.6}');assert.equal(loadOutpostRiskConfig(file).firstSupportWeight,0.6);
  writeFileSync(file,'{"outerEnemyWeight":0.3}');assert.equal(loadOutpostRiskConfig(file).outerEnemyWeight,0.3);
 }finally{rmSync(dir,{recursive:true});}
 assert.equal(DEFAULT_OUTPOST_RISK.firstSupportWeight,0.5);
 assert.deepEqual(loadOutpostRiskConfig('config/ai-outpost-risk.example.json'),DEFAULT_OUTPOST_RISK);
});

test('simultaneous departures expose a neighbouring point even when the donors themselves remain safe',()=>{
 const {o,routes}=fixture();o.view.outposts[0]!.drillers=0;o.view.outposts[0]!.shield=0;
 o.view.outposts[1]!.shield=500;o.view.outposts[2]!.shield=500;
 const risks=createOutpostRiskAnalysis(o,undefined,routes),drafts=['support1','support2'].map((source,i)=>({id:`d${i}`,issueTick:o.view.tick,action:{kind:'launch',source,destination:'enemy1',drillers:o.view.outposts.find(p=>p.id===source)!.drillers!}}));
 assert.equal(risks.get('support1').shortfall,0);assert.equal(risks.get('support2').shortfall,0);
 assert.ok(botCommitmentCost(o,drafts,null,risks).shortfall>0);
});

test('internal transfers replenish deficits without assigning multiple donors to the same full gap',()=>{
 const {o}=fixture();o.view.outposts[0]!.drillers=0;o.view.outposts[0]!.shield=0;
 o.view.outposts[1]!.shield=500;o.view.outposts[2]!.shield=500;
 o.view.fleets=[{id:'attack',owner:1,drillers:80,position:{x:0.25,y:0},state:'moving',gift:false,destination:{kind:'outpost',id:'home'}}];
 const routes=attackRoutes(o,{attackTicks:144,localTicks:144,holdTicks:24}),risks=createOutpostRiskAnalysis(o,undefined,routes);
 const review=({candidates:internalTroopCandidates(o,routes,144,risks)});
 const transfers=review.candidates.filter(c=>c.id.startsWith('internal-troops:')&&c.targets.includes('home'));
 const total=transfers.reduce((n,c)=>n+Number(c.drafts[0]!.action.drillers),0);
 assert.ok(total>0);assert.ok(total<=risks.get('home').shortfall);
 for(const c of review.candidates.filter(c=>c.id.startsWith('internal-troops:'))){
  const a=c.drafts[0]!.action;
  assert.ok(Number(a.drillers)<=risks.available(o.view.outposts.find(p=>p.id===a.source)!),'hypothetical deliveries cannot fund another immediate departure');
 }
});

test('a rear quiet within an explicitly configured short window sends surplus towards a known frontline',()=>{
 const {o}=fixture();
 o.view.outposts[0]!.drillers=0;o.view.outposts[0]!.shield=20;
 o.view.outposts[1]!.position={x:3.2,y:0};o.view.outposts[2]!.position={x:4,y:0};o.view.outposts[2]!.drillers=0;
 o.view.outposts[3]!.drillers=10;o.view.outposts[3]!.position={x:0.5,y:0};
 o.view.outposts[4]!.position={x:30,y:30};o.view.outposts[5]!.position={x:-30,y:30};
 const routes=attackRoutes(o,{attackTicks:144,localTicks:144,holdTicks:24}),risks=createOutpostRiskAnalysis(o,outpostRiskConfig({horizonTicks:48}),routes);
 assert.equal(risks.get('home').shortfall,0);
 const review=({candidates:internalTroopCandidates(o,routes,144,risks)}),transfer=review.candidates.find(c=>c.id==='internal-troops:support1:home');
 assert.ok(transfer,'surplus behind the front should move forward');
 assert.ok(Number(transfer.drafts[0]!.action.drillers)>0&&Number(transfer.drafts[0]!.action.drillers)<100);
});

test('target bounds retain mines, existing operations and explicitly requested targets',()=>{
 const {o,routes}=fixture();
 const seed=o.view.outposts[3]!;
 for(let i=0;i<16;i++){
  const id=`target-${i.toString().padStart(2,'0')}`;o.view.outposts.push({...seed,id,type:i===13?'mine':'generator',position:{x:3+i,y:0}});routes.postTicks.home![id]=i+1;
 }

 // Strategic exceptions survive independently of the ordinary nearest ten.
 const selected=createOutpostRiskAnalysis(o,undefined,routes).targets(['target-15']);
 assert.ok(selected.has('target-13'));assert.ok(selected.has('target-15'));
 assert.ok(selected.size<=13);
});

test('static routes use wrapped geometry at ordinary fleet speed',()=>{
 const {o}=fixture();const ordinary=createKnownForceRouteEstimator(o).post('support2','home');

 const fast=createKnownForceRouteEstimator(o).post('support2','home');assert.ok(fast!==null&&ordinary!==null&&fast===ordinary);
 o.view.outposts[0]!.position.x=-39;o.view.outposts[2]!.position.x=39;
 const wrapped=createKnownForceRouteEstimator(o).post('support2','home');
 o.view.outposts[0]!.position.x=0;o.view.outposts[2]!.position.x=-2;
 assert.equal(createKnownForceRouteEstimator(o).post('support2','home'),wrapped);
});
