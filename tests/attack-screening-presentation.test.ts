
import {presentOutpostNames} from '../packages/ai/src/controller/presentation/outpost-references.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {screenAttacks,screeningSummary,screeningClass} from '../packages/ai/src/controller/analysis/attack-screening.js';
import {attackScreeningPresentation,relatedAttackTargets} from '../packages/ai/src/controller/analysis/attack-screening-presentation.js';
import {type AiSnapshot,type DecisionTask} from '../packages/ai/src/controller/contracts/types.js';
function fixture(){
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'screening-display');
 o.view.fleets=[];o.view.size={width:80,height:80};
 o.view.outposts=[{id:'home',owner:0,position:{x:0,y:0},visibility:2,drillers:1000,shield:0},...Array.from({length:8},(_,i)=>({id:`target-${i}`,owner:1,position:{x:(i+1)/4,y:0},visibility:2 as const,drillers:1,shield:0}))];
 o.outpostNames=Object.fromEntries(o.view.outposts.map((p,i)=>[p.id,`REEF ${i}`]));
 const report=screenAttacks(o,attackRoutes(o));assert.ok(report.ranked.length>5);
 const task:DecisionTask={category:'military',weight:'heavy',reasons:['来袭变化'],entities:[report.ranked.at(-1)!.target],deferred:[]};
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,task};
 snapshot.attackScreening=screeningSummary(report,o,snapshot);
 return {o,report,snapshot};
}
test('screening presents top five plus directly related target once, without duplicate prose or budgets',()=>{
 const f=fixture(),before=JSON.stringify(f.report),shown=attackScreeningPresentation(f.snapshot);
 assert.ok(shown.available);assert.equal(shown.targets.length,6);
 assert.deepEqual(shown.targets.slice(0,5).map(p=>p.target),f.report.ranked.slice(0,5).map(p=>p.target));
 assert.equal(shown.targets.at(-1)!.target,f.report.ranked.at(-1)!.target);
 assert.equal(new Set(shown.targets.map(p=>p.target)).size,6);
 assert.ok(!('modelSummary' in shown));assert.ok(!('modelRanking' in shown));assert.ok(!('budget' in shown));assert.ok(!('candidates' in shown));
 assert.equal(JSON.stringify(f.report),before);
 const selected=f.report.ranked.at(-1)!,last=shown.targets.at(-1)!;
 assert.equal(last.attackMargin,selected.attackMargin);
 const detail=attackScreeningPresentation(f.snapshot,{targets:[selected]});assert.ok(detail.available);
 assert.equal(detail.targets[0]!.defenseEstimate!.total,selected.defense.estimatedWithProductionAndShield);
 assert.deepEqual(detail.targets[0]!.possibleDefenderSupport,selected.support.map(s=>[s.id,s.estimatedForce,s.ticks,s.known]));
 assert.ok(!('confidence' in last));assert.ok(!('defenseEstimate' in last));
 assert.equal(last.newForce+last.committedForce,selected.sourceForce);
 for(const [index,s] of shown.sourceSafety.entries())assert.deepEqual(s.risks,f.report.sourceReserves[index]!.defense.threats.map(t=>[t.id,t.ticks,t.force,t.estimated,t.unknown]));
 assert.ok(!('note' in shown));assert.ok(!('fields' in shown));
});
test('screening follows explicit fleet associations and renders only authorized names',()=>{
 const f=fixture(),target=f.report.ranked.at(-1)!.target;
 f.o.view.fleets=[{id:'trigger-fleet',owner:1,state:'moving',drillers:1,gift:false,position:{x:1,y:0},source:'target-0',destination:{kind:'outpost',id:target}}];

 for(const entity of ['trigger-fleet']){
  assert.ok(relatedAttackTargets(f.o,[entity]).has(target));
  f.snapshot.task!.entities=[entity];f.snapshot.attackScreening=screeningSummary(f.report,f.o,f.snapshot);
  const shown=attackScreeningPresentation(f.snapshot);assert.ok(shown.available);
  assert.ok(shown.targets.some(p=>p.target===target));
 }
 const screening=JSON.stringify(presentOutpostNames(attackScreeningPresentation(f.snapshot),f.o.outpostNames!));
 assert.ok(screening.includes('REEF '));assert.ok(!screening.includes('target-'));assert.ok(!screening.includes('modelSummary'));
});

test('feasible, conditional and existing actions each survive selection; reservations and incoming remain explicit',()=>{
 const f=fixture(),review=f.report.ranked.at(-1)!,conditional=f.report.ranked.at(-2)!;
 review.existingOperation=true;review.sourceForce+=25;conditional.holdMargin=-20;
 const summary=screeningSummary(f.report,f.o),snapshot={...f.snapshot,attackScreening:summary};
 assert.ok(summary.modelRanking.some(p=>p.target===review.target));assert.ok(summary.modelRanking.some(p=>p.target===conditional.target));
 assert.equal(screeningClass(review),'review');assert.equal(screeningClass(conditional),'conditional');
 const shown=attackScreeningPresentation(snapshot);assert.ok(shown.available);
 assert.equal(shown.targets.find(p=>p.target===review.target)!.committedForce,25);
 assert.equal(new Set(shown.targets.map(p=>p.target)).size,shown.targets.length);
 const risk=summary.sourceReserves[0]!;risk.pendingUnknown=true;risk.pendingCommitment=true;risk.pendingReserved=7;risk.pendingSchedules=['future'];risk.defense.uncertain=true;risk.defense.forecastReasons=['unknown-information'];
 const safety=attackScreeningPresentation(snapshot);assert.ok(safety.available);
 assert.deepEqual(safety.sourceSafety[0]!.reservation,{force:7,schedules:['future'],unknown:true});
 assert.ok(safety.sourceSafety[0]!.flags.includes('reservation-unknown'));
 assert.equal(screeningClass({...conditional,holdMargin:10,attackMargin:10,confidence:1,sources:summary.sourceReserves}),'conditional');
});
