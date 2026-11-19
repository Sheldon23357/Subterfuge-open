
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import type {AttackRoutes,PlayerObservation} from '../packages/contracts/src/index.js';
import {screenAttacks,screeningSummary} from '../packages/ai/src/controller/analysis/attack-screening.js';
import {attackScreeningConfig} from '../packages/ai/src/controller/analysis/attack-screening-config.js';
import {attackTargetContext} from '../packages/ai/src/controller/analysis/attack-target-context.js';
import {attackScreeningPresentation} from '../packages/ai/src/controller/analysis/attack-screening-presentation.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';

function fixture(){
 const o:PlayerObservation=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'target-text');
 o.view.size={width:20,height:20};o.view.playerCount=3;o.view.fleets=[];o.intel=[];o.outpostNames={home:'本营',t0:'测试目标'};
 o.view.outposts=[{id:'home',owner:0,type:'factory',position:{x:-1,y:0},visibility:2,drillers:100,shield:10},
  ...Array.from({length:7},(_,i)=>({id:`t${i}`,owner:1,type:i===0?'mine':'factory',position:{x:i,y:0},visibility:2,drillers:5+i*3,shield:0}))];
 o.outpostNames=Object.fromEntries(o.view.outposts.map(p=>[p.id,o.outpostNames?.[p.id]??p.id]));
 const postTicks=Object.fromEntries(o.view.outposts.map(a=>[a.id,Object.fromEntries(o.view.outposts.filter(b=>a!==b).map(b=>[b.id,a.id==='home'?10:144]))]));
 const routes:AttackRoutes={roomId:o.roomId,revision:o.revision,observedTick:o.view.tick,maxTicks:144,basis:'ordinary-speed-public-geometry',postTicks,fleetTicks:{}};
 return {o,routes};
}
function snap(o:PlayerObservation):AiSnapshot{return {observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};}

test('model text uses true ranked top five despite internal configured candidate/diversity selection',()=>{
 const {o,routes}=fixture();delete o.view.outposts[7]!.drillers;delete o.view.outposts[7]!.shield;
 const report=screenAttacks(o,routes,attackScreeningConfig({limits:{candidates:1}})),before=JSON.stringify(report);
 const text=attackTargetContext(report,o);
 assert.equal(text.targets.length,5);assert.ok(report.candidates.length<5);
 text.targets.forEach((t,i)=>{assert.ok(t.startsWith(`${i+1}. `));assert.ok(t.includes(report.ranked[i]!.target));assert.ok(t.includes(`价值评分${report.ranked[i]!.score}`));});
 assert.equal(JSON.stringify(report),before);
 assert.equal(attackTargetContext({...report,ranked:report.ranked.slice(0,2)},o).targets.length,2);
 assert.equal(attackTargetContext({...report,ranked:[]},o).targets.length,0);
});

test('target fields use observed owner, shields, wrapped distance and current source availability',()=>{
 const {o,routes}=fixture();

 const report=screenAttacks(o,routes),p=report.ranked.find(p=>p.target==='t0')!;
 p.sources[0]!.available=17;p.sources[0]!.defense.stationed=100;
 const t=attackTargetContext({...report,ranked:[p]},o).targets[0]!;
 assert.match(t,/测试目标（t0）；矿场，玩家1；价值评分/);
 assert.ok(t.includes(`据点价值分项${p.components.value}`),'basic reasons include a positive actual score component, not only feasibility');
 assert.match(t,/护盾0，驻兵5/);
 assert.match(t,/本营（home）：可调17兵\/驻兵100/);assert.match(t,/距目标1地图单位，普通航速直达10世界天/);
 assert.ok(!t.includes('可调100兵'));assert.ok(t.includes('普通航速直达10世界天'));
 o.view.outposts[1]!.owner=null;assert.match(attackTargetContext({...report,ranked:[p]},o).targets[0]!,/矿场，中立/);
 delete o.view.outposts[1]!.owner;assert.match(attackTargetContext({...report,ranked:[p]},o).targets[0]!,/归属未知/);
});

test('unknown enemy troops never become heuristic force; same-owner support does not include third parties',()=>{
 const {o,routes}=fixture();delete o.view.outposts[2]!.drillers;delete o.view.outposts[2]!.shield;
 routes.postTicks.t1!.t0=5;routes.postTicks.t2!.t0=5;o.view.outposts[3]!.owner=2;
 const report=screenAttacks(o,routes),p=report.ranked.find(p=>p.target==='t0')!;
 assert.ok(p.support.find(s=>s.id==='t1')!.estimatedForce>0);
 const t=attackTargetContext({...report,ranked:[p]},o).targets[0]!;
 assert.match(t,/敌方可能增援节点：t1（t1）：已知驻兵未知，距目标1地图单位/);
 assert.ok(!t.split('第三方节点')[0]!.includes('t2'));assert.match(t,/第三方节点（不自动协防）：t2（t2）（玩家2）/);assert.ok(!t.includes('estimatedForce'));
 delete o.view.outposts[1]!.drillers;delete o.view.outposts[1]!.shield;
 const unknown=screenAttacks(o,routes).ranked.find(p=>p.target==='t0')!;
 assert.match(attackTargetContext({...report,ranked:[unknown]},o).targets[0]!,/护盾未知，驻兵未知/);
});



test('current round always carries compact screening and preserves its original diagnostics',()=>{
 const {o,routes}=fixture(),report=screenAttacks(o,routes),snapshot={...snap(o),attackScreening:screeningSummary(report,o)};
 const original=structuredClone(snapshot),state=initialState(o.roomId,0,{model:'',personality:'raider'});
 for(const category of ['military','diplomacy','plan'] as const){
  const current={...snapshot,task:{category,weight:'medium' as const,scope:'local' as const,reasons:[],entities:['t0'],deferred:[]}};
  const model=attackScreeningPresentation(current);assert.equal(model.available,true);
  if(model.available)assert.equal(model.targets.length,5);
  const prompt=JSON.stringify(model);
  assert.match(prompt,/sourceSafety/);assert.doesNotMatch(prompt,/"sourceReserves":|"configVersion":/);
 }
 assert.deepEqual(snapshot,original);
});


test('rich five shows precomputed estimates, incoming orders, source reservations and shared-source conflicts',()=>{
 const {o,routes}=fixture();
 o.view.fleets.push({id:'own-incoming',owner:0,state:'moving',source:'home',drillers:9,gift:false,position:{x:-1,y:0},destination:{kind:'outpost',id:'t0'}});routes.fleetTicks['own-incoming']=3;
 const report=screenAttacks(o,routes),p=report.ranked.find(p=>p.target==='t0')!;
 const targets=[p,...report.ranked.filter(x=>x!==p)],before=JSON.stringify(report);
 const text=attackTargetContext({...report,ranked:targets},o).targets[0]!;
 assert.ok(text.includes(`防守留兵${p.sources[0]!.reserve}、战役预留${p.sources[0]!.campaignReserved}`));
 assert.ok(text.includes('与候选2/3/4/5共用此来源'));
 assert.ok(text.includes(`进攻差额${p.attackMargin}、守备差额${p.holdMargin}，补兵估值${p.additionalForceEstimate}`));
 assert.ok(text.includes(`抵达护盾估计${p.defense.shieldAtArrival.minimum}–${p.defense.shieldAtArrival.maximum}`));
 assert.match(text,/own-incoming（己方\/玩家0）：9兵，moving，本营（home）→测试目标（t0），现航线预计3世界天抵达/);
 assert.equal(JSON.stringify(report),before);
 o.scheduled.push({id:'future-launch',player:0,status:'pending',issueTick:110,action:{kind:'launch',source:'home',destination:'t0',drillers:4}});
 assert.match(attackTargetContext({...report,ranked:targets},o).targets[0]!,/己方待执行预约：future-launch：本营（home）→测试目标（t0） 4兵，执行tick110/);
});

test('current agreement bodies remain in notes while unbooked legacy plans do not reserve resources',()=>{
 const {o,routes}=fixture(),report=screenAttacks(o,routes),snapshot=snap(o);snapshot.attackScreening=screeningSummary(report,o);
 snapshot.campaigns=[{id:'existing',target:'t0',stage:'assembling',reviewAtTick:150,allocations:[{source:'home',drillers:99}],objective:'hold',holdPlan:'hold',cancelWhen:'change',createdTick:100,accountedFleets:[],issues:[]}];
 snapshot.notebook=[{id:'agreement-exact',kind:'agreement',text:'完整条款仍在笔记',updatedAt:0,expiresAt:null}];
 const model=attackScreeningPresentation(snapshot);assert.equal(model.available,true);
 if(model.available)assert.equal(model.sourceSafety.find(s=>s.source==='home')!.reservation?.force??0,0);
 assert.equal(snapshot.notebook[0]!.text,'完整条款仍在笔记');assert.doesNotMatch(JSON.stringify(model),/existing（assembling/);
});
test('reinforcement detail is bounded but indicates omissions and keeps unknown observed troops separate from estimates',()=>{
 const {o,routes}=fixture();for(let i=1;i<7;i++)routes.postTicks[`t${i}`]!.t0=i;
 delete o.view.outposts[2]!.drillers;const report=screenAttacks(o,routes),p=report.ranked.find(p=>p.target==='t0')!;
 const text=attackTargetContext({...report,ranked:[p]},o).targets[0]!;
 assert.match(text,/t1（t1）：已知驻兵未知/);assert.match(text,/初筛动员估值/);assert.match(text,/另2项见完整详情/);
});

test('gather and waiting forces are labelled without claiming current forward troops or arrival time',()=>{
 const {o,routes}=fixture();o.view.fleets.push({id:'waiting',owner:1,state:'waiting',drillers:8,gift:false,position:{x:0,y:0},destination:null});

 const report=screenAttacks(o,routes),p=report.ranked.find(p=>p.target==='t0')!;
 p.plan={kind:'gather',hub:'home',gatherTicks:3};p.sources[0]!.ticks=13;p.sources[0]!.transferTicks=2;
 const t=attackTargetContext({...report,ranked:[p]},o).targets[0]!;
 assert.match(t,/待发可撤兵8/);assert.match(t,/先向本营（home）集结3世界天/);
 assert.ok(t.includes('运至集结点2世界天，按集结方案抵达目标13世界天'));assert.match(t,/距目标1地图单位/);
 delete (p as any).plan;assert.match(attackTargetContext({...report,ranked:[p]},o).targets[0]!,/方案类型未知/);
});
