
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import type {AttackRoutes,PlayerObservation} from '../packages/contracts/src/index.js';
import {screenAttacks,screeningSummary,type AttackScreeningReport} from '../packages/ai/src/controller/analysis/attack-screening.js';
import {attackScreeningConfig} from '../packages/ai/src/controller/analysis/attack-screening-config.js';
import {attackDiscoveryContext,attackTargetContext} from '../packages/ai/src/controller/analysis/attack-target-context.js';
import {attackScreeningPresentation} from '../packages/ai/src/controller/analysis/attack-screening-presentation.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';

// Same seven-target geometry as attack-target-context.test.ts. Additional facts
// below exercise discovery outside the five individually described targets.
function fixture(){
 const o:PlayerObservation=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'discovery-context');
 o.view.size={width:20,height:20};o.view.playerCount=3;o.view.fleets=[];o.intel=[];o.outpostNames={home:'本营',t0:'测试目标'};
 o.view.outposts=[{id:'home',owner:0,type:'factory',position:{x:-1,y:0},visibility:2,drillers:100,shield:10},
  ...Array.from({length:7},(_,i)=>({id:`t${i}`,owner:1,type:i===0?'mine':'factory',position:{x:i,y:0},visibility:2,drillers:5+i*3,shield:0}))];
 o.outpostNames=Object.fromEntries(o.view.outposts.map(p=>[p.id,o.outpostNames?.[p.id]??p.id]));
 const postTicks=Object.fromEntries(o.view.outposts.map(a=>[a.id,Object.fromEntries(o.view.outposts.filter(b=>a!==b).map(b=>[b.id,a.id==='home'?10:null]))]));
 const routes:AttackRoutes={roomId:o.roomId,revision:o.revision,observedTick:o.view.tick,maxTicks:144,basis:'ordinary-speed-public-geometry',postTicks,fleetTicks:{}};
 return {o,routes};
}
function snap(o:PlayerObservation):AiSnapshot{o.outpostNames={...o.outpostNames,...Object.fromEntries(o.view.outposts.filter(p=>!o.outpostNames?.[p.id]).map(p=>[p.id,p.id]))};return {observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3};}
function freeze<T>(value:T):T {
 if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}
 return value;
}
function leaderFixture(){
 const f=fixture();
 f.o.view.outposts[7]!.drillers=10000;f.o.view.outposts[7]!.owner=2;
 f.o.intel=[{player:2,active:true,neptunium:190,npPerDay:1,outposts:{mine:0,generator:0,factory:1},numOutposts:1,drillers:10000,output:6,drillerRate:1}];

 return f;
}
function safetyFixture(){
 const f=fixture();
 for(const [id,drillers] of [['blocked',0],['empty',0],['remote',7]] as const){
  f.o.view.outposts.push({id,owner:0,type:'factory',position:{x:-2,y:0},visibility:2,drillers,shield:0});
  f.routes.postTicks[id]=Object.fromEntries(f.o.view.outposts.filter(p=>p.id!==id).map(p=>[p.id,null]));
  for(const enemy of f.o.view.outposts.filter(p=>p.owner!==0))f.routes.postTicks[enemy.id]![id]=null;
 }
 f.o.view.fleets.push({id:'actual-attack',owner:1,state:'moving',source:'t0',drillers:7,gift:false,position:{x:-2,y:0},destination:{kind:'outpost',id:'blocked'}});
 f.routes.fleetTicks['actual-attack']=0;
 delete f.o.view.outposts[2]!.drillers;delete f.o.view.outposts[2]!.shield;
 f.routes.postTicks.t1!.blocked=2;
 return f;
}
function cooperationFixture(){
 const f=fixture();
 f.o.view.outposts[0]!.drillers=0;
 f.o.view.outposts[2]!.owner=2;
 f.routes.postTicks.t1!.t0=20;
 f.o.view.fleets.push({id:'hostile-approach',owner:1,state:'moving',source:'t0',drillers:8,gift:false,position:{x:-2,y:0},destination:{kind:'outpost',id:'home'}});
 f.routes.fleetTicks['hostile-approach']=4;
 return f;
}
function expectedSafety(report:AttackScreeningReport){
 return report.sourceReserves.map(s=>({source:s.id,available:s.available,retain:s.reserve,shortfall:s.defense.shortfall,uncertain:s.defense.uncertain,
  status:s.defense.status,forecastRequired:s.defense.forecastRequired,forecastReasons:s.defense.forecastReasons,
  ...(s.defense.threats.some(t=>!t.estimated)?{incoming:s.defense.threats.filter(t=>!t.estimated).map(t=>({id:t.id,ticks:t.ticks,force:t.force,estimated:t.estimated,unknown:t.unknown}))}:{}),
  ...(s.defense.threats.some(t=>t.estimated)?{potentialSorties:s.defense.threats.filter(t=>t.estimated).map(t=>({id:t.id,ticks:t.ticks,force:t.force,estimated:t.estimated,unknown:t.unknown}))}:{})}));
}
function expectedCooperation(report:AttackScreeningReport){
 return {opponents:report.cooperation.opportunities.map(p=>({opponent:p.opponent,partners:p.partners.map(q=>q.player),incoming:p.incoming.length,purposes:p.purposes})),details:'attackCandidates {all:true}'};
}

test('source discovery includes every own source, including unavailable and unused sources, without mutating the report',()=>{
 const {o,routes}=safetyFixture(),report=screenAttacks(o,routes),before=JSON.stringify(report);
 assert.equal(report.ranked.length,7);
 assert.ok(report.ranked.every(p=>p.sources.every(s=>s.id==='home')));
 freeze(report);freeze(o);
 const projected=attackTargetContext(report,o);
 assert.equal(projected.targets.length,5);
 assert.deepEqual(projected.sourceSafety,expectedSafety(report));
 assert.deepEqual(projected.sourceSafety!.map(s=>s.source),['home','blocked','empty','remote']);
 assert.deepEqual(projected.sourceSafety!.find(s=>s.source==='empty'),{source:'empty',available:0,retain:0,shortfall:0,uncertain:false,status:'provisional',forecastRequired:false,forecastReasons:[]});
 assert.deepEqual(projected.sourceSafety!.find(s=>s.source==='remote'),{source:'remote',available:7,retain:0,shortfall:0,uncertain:false,status:'provisional',forecastRequired:false,forecastReasons:[]});
 assert.equal(JSON.stringify(report),before);
 assert.equal('sourceReserves'in projected,false);
});

test('source discovery preserves exact zero arrival, force, retention and shortfall while excluding estimated sorties from incoming',()=>{
 const {o,routes}=safetyFixture(),report=screenAttacks(o,routes),source=report.sourceReserves.find(s=>s.id==='blocked')!;
 assert.deepEqual(source.defense.threats.map(t=>[t.id,t.estimated]),[['actual-attack',false],['t1',true]]);
 assert.equal(source.reserve,8);assert.equal(source.defense.shortfall,8);
 assert.ok(source.defense.risk.unknowns.includes('garrison:t1'),'unseen garrison stays unknown rather than adding invented reserve troops');
 const projected=attackDiscoveryContext(report).sourceSafety!.find(s=>s.source==='blocked')!;
 assert.deepEqual(projected,expectedSafety(report).find(s=>s.source==='blocked'));
 assert.deepEqual(projected.incoming,[{id:'actual-attack',ticks:0,force:7,estimated:false,unknown:false}]);
 assert.equal(projected.potentialSorties?.[0]?.id,'t1');
 assert.ok(!JSON.stringify(projected.incoming).includes('t1'));
 // Removing the actual fleet leaves an explicit unknown threat, without
 // inventing either its troop count or an incoming fleet.
 o.view.fleets=[];
 const estimatesOnly=attackDiscoveryContext(screenAttacks(o,routes)).sourceSafety!.find(s=>s.source==='blocked')!;
 assert.equal(estimatesOnly.retain,0);assert.equal(estimatesOnly.uncertain,true);
 assert.equal(estimatesOnly.forecastRequired,true);
 assert.equal(estimatesOnly.potentialSorties?.[0]?.id,'t1');
 assert.equal('incoming'in estimatesOnly,false);
});

test('rank-seven leading opponent gets one compact special-target hint without displacing or duplicating the ranked top five',()=>{
 const {o,routes}=leaderFixture(),report=screenAttacks(o,routes),before=JSON.stringify(report);
 assert.equal(report.ranked[6]!.target,'t6');
 assert.equal(report.candidates.find(p=>p.target==='t6')!.selection,'leading-opponent');
 freeze(report);
 const projected=attackTargetContext(report,o),leader=report.ranked[6]!;
 assert.equal(projected.targets.length,5);
 projected.targets.forEach((text,index)=>assert.ok(text.startsWith(`${index+1}. ${report.ranked[index]!.name}`)));
 assert.deepEqual(projected.specialTargets,[{target:'t6',rank:7,reason:'leading-opponent',tags:['leading-opponent'],score:leader.score,observedDrillers:10000,observedShield:0,details:'attackCandidates {target:"t6"}'}]);
 assert.equal(projected.targets.some(text=>text.startsWith('6. ')),false);

 assert.equal(JSON.stringify(report),before);
 const summary=screeningSummary(report,o);
 assert.equal(summary.modelRanking.length,5);
 assert.deepEqual(summary.modelSummary.specialTargets,projected.specialTargets);
});





test('cooperation discovery survives zero solo candidates and exposes only actual opportunity identities, counts and purposes',()=>{
 const {o,routes}=cooperationFixture(),report=screenAttacks(o,routes),before=JSON.stringify(report);
 assert.equal(report.ranked.length,0);assert.equal(report.candidates.length,0);
 assert.ok(report.excluded.length>0);assert.equal(report.cooperation.opportunities.length,1);
 freeze(report);
 const projected=attackTargetContext(report,o);
 assert.deepEqual(projected.targets,[]);
 assert.deepEqual(projected.cooperationAlert,{opponents:[{opponent:1,partners:[2],incoming:1,purposes:['seek-defense-or-counterattack','joint-attack-or-diversion']}],details:'attackCandidates {all:true}'});
 assert.deepEqual(projected.cooperationAlert,expectedCooperation(report));
 assert.equal('available'in projected.cooperationAlert!.opponents[0]!,false);
 assert.equal('committed'in projected.cooperationAlert!.opponents[0]!,false);
 assert.deepEqual(projected.sourceSafety,expectedSafety(report));
 assert.equal(JSON.stringify(report),before);
});

test('all categories carry current screening safety and leading-opponent discovery outside the top five',()=>{
 const {o,routes}=leaderFixture(),report=screenAttacks(o,routes),snapshot=snap(o);snapshot.attackScreening=screeningSummary(report,o);
 snapshot.attackScreening.sourceReserves[0]!.available=17;const before=structuredClone(snapshot);
 const state=initialState(o.roomId,0,{model:'',personality:'raider'});
 for(const category of ['military','diplomacy','plan'] as const){
  const current={...snapshot,task:{category,weight:'medium' as const,scope:'local' as const,reasons:[],entities:['t0'],deferred:[]}};
  const model=attackScreeningPresentation(current);assert.equal(model.available,true);
  if(model.available){assert.equal(model.sourceSafety[0]!.available,17);assert.equal(model.targets.length,5);}
  const prompt=JSON.stringify(model);
  assert.match(prompt,/sourceSafety/);assert.ok(prompt.includes("t6"));
  assert.doesNotMatch(prompt,/"modelSummary":|"configVersion":/);
 }
 assert.deepEqual(snapshot,before);
});

test('special-target hints preserve fog as null and known zero, never substitute screening force estimates',()=>{
 const {o,routes}=fixture();
 delete o.view.outposts[7]!.drillers;delete o.view.outposts[7]!.shield;
 let report=screenAttacks(o,routes),target=report.ranked.find(p=>p.target==='t6')!;
 assert.ok(target.defense.estimatedWithProductionAndShield>0);
 let hint=attackDiscoveryContext(report).specialTargets!.find(p=>p.target==='t6')!;
 assert.equal(hint.reason,'reconnaissance');assert.equal(hint.rank,7);
 assert.equal(hint.observedDrillers,null);assert.equal(hint.observedShield,null);
 assert.equal('estimatedWithProductionAndShield'in hint,false);
 assert.equal('owner'in hint,false);
 o.view.outposts[7]!.drillers=0;o.view.outposts[7]!.shield=10000;
 o.view.outposts[7]!.owner=2;o.intel=leaderFixture().o.intel;

 report=screenAttacks(o,routes);
 hint=attackDiscoveryContext(report).specialTargets!.find(p=>p.target==='t6')!;
 assert.equal(hint.observedDrillers,0);assert.equal(hint.observedShield,10000);assert.equal(hint.rank,7);
});

test('diversity candidates already in the detailed five are not repeated; absent legacy facts and rank stay unknown',()=>{
 const {o,routes}=fixture();
 // Keep all candidates in the same conditional class for this legacy projection test.
 for(const p of o.view.outposts.filter(p=>p.owner===1))p.drillers=200;
 o.view.outposts[5]!.owner=2;o.intel=leaderFixture().o.intel;

 const report=screenAttacks(o,routes,attackScreeningConfig({limits:{candidates:1}}));
 assert.ok(report.candidates.some(p=>p.target==='t4'&&p.tags.includes('leading-opponent')));
 assert.ok(report.ranked.slice(0,5).some(p=>p.target==='t4'));
 assert.equal(attackTargetContext(report,o).targets.length,5);
 assert.equal(attackDiscoveryContext(report).specialTargets,undefined);
 assert.deepEqual(attackDiscoveryContext({ranked:[]}),{});
 const {o:leaderO,routes:leaderRoutes}=leaderFixture(),leaderReport=screenAttacks(leaderO,leaderRoutes);
 const partial=attackDiscoveryContext({...leaderReport,ranked:leaderReport.ranked.slice(0,5)});
 assert.equal(partial.specialTargets![0]!.rank,null);
 assert.equal(partial.specialTargets![0]!.target,'t6');
 const missingSelection={...leaderReport,candidates:leaderReport.candidates.map(({selection,...p})=>p)} as unknown as AttackScreeningReport;
 assert.equal(attackDiscoveryContext(missingSelection).specialTargets,undefined);
});
