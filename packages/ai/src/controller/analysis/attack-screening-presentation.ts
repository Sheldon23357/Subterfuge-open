import type {AiSnapshot} from '../contracts/types.js';
import type {PlayerObservation} from '../../../../contracts/src/index.js';
import {screeningClass,type AttackScreeningReport} from './attack-screening.js';
import {capacityPressure} from './capacity-pressure.js';
export function relatedAttackTargets(o:PlayerObservation|undefined,entities:string[]=[]){
 const related=new Set(entities);
 for(const fleet of o?.view.fleets??[])if(related.has(fleet.id)&&fleet.destination?.kind==='outpost')related.add(fleet.destination.id);
 return related;
}
/** Compact permanent screening; query a named target for full estimates.
 * Original calculations and all candidates remain in the private audit. */
export function attackScreeningPresentation(snapshot:AiSnapshot,options:{targets?:AttackScreeningReport['ranked']}={}){
 const report=snapshot.attackScreening;
 if(!report)return {available:false as const,reason:'程序尚未提供初筛结果，可追加查询'};
 const selected=[...(options.targets??report.modelRanking)];
 if(!options.targets)for(const p of report.relatedRanking??[])if(!selected.some(q=>q.target===p.target))selected.push(p);
 const targets=selected.map(p=>{
  const newForce=p.sources.reduce((n,s)=>n+s.available,0);
  const uncertainty=[...(p.defense.observedDrillers===null?['target-unknown']:[]),...(p.support.some(s=>!s.known)?['support-unknown']:[]),...(p.confidence<1?['unknown-estimate']:[]),...(p.sources.some(s=>s.defense.uncertain||s.pendingUnknown)?['source-risk']:[]),...(p.contested?['contested']:[]),...(p.timing.attackTicks>72?['long-route']:[])];
  return {
   target:p.target,group:screeningClass(p),score:p.score,value:p.valueBreakdown.total,
   newForce,committedForce:p.sourceForce-newForce,followupForce:p.followupForce,
   attackMargin:p.attackMargin,holdMargin:p.holdMargin,
   localPressure:{basis:p.risk.basis,defense:p.risk.defense,enemy:p.risk.enemy,ratio:p.risk.pressureRatio,unknowns:p.risk.unknowns},
   additionalForceEstimate:p.additionalForceEstimate,
   arriveAtWorldDay:p.timing.arrivalTick,holdUntilWorldDay:report.observedTick+p.timing.holdTicks,
   sources:p.sources.map(s=>[s.id,s.available,s.ticks]),uncertainty,
   ...(p.plan.kind==='gather'?{gather:{hub:p.plan.hub,worldDays:p.plan.gatherTicks}}:{}),
   ...(options.targets?{
    selection:'requested-target',tags:p.tags,assessment:p.assessment,pressureBonus:p.pressureBonus,
    defenseEstimate:{total:p.defense.estimatedWithProductionAndShield,productionUpperBound:p.defense.productionUpperBound,shieldAtArrival:p.defense.shieldAtArrival,recallableWaiting:p.defense.recallableWaitingDrillers,reinforcementBefore:p.defense.enemyBefore,reinforcementThroughHold:p.defense.enemyThroughHold},
    valueBreakdown:p.valueBreakdown,
    possibleDefenderSupport:p.support.map(s=>[s.id,s.estimatedForce,s.ticks,s.known]),
    thirdParties:p.thirdParties.map(s=>[s.id,s.estimatedForce,s.ticks,s.known]),
    incoming:p.incoming.map(f=>[f.id,f.owner,f.drillers,f.ticks]),
   }:{}),
  };
 });
 return {
  available:true as const,basisRevision:report.basisRevision,observedWorldDay:report.observedTick,
  ...(()=>{const {strength,...pressure}=capacityPressure(snapshot.observation);return pressure.state==='none'?{}:{capacityPressure:pressure};})(),
  scanned:report.scanned,excludedCount:report.excludedCount,targets,
  sourceSafety:report.sourceReserves.map(s=>({
   source:s.id,available:s.available,retain:s.reserve,shortfall:s.defense.shortfall,
   pressure:{ratio:s.defense.risk.pressureRatio,priority:s.defense.risk.priority,earliestDeficitTicks:s.defense.risk.earliestDeficitTicks,arrivalShortfall:s.defense.risk.arrivalShortfall},
   flags:[...s.defense.forecastReasons,...(s.defense.uncertain?['uncertain']:[]),...(s.pendingUnknown?['reservation-unknown']:[])],
   ...(s.pendingCommitment||s.pendingUnknown?{reservation:{force:s.pendingReserved,schedules:s.pendingSchedules,unknown:s.pendingUnknown}}:{}),
   risks:s.defense.threats.map(t=>[t.id,t.ticks,t.force,t.estimated,t.unknown]),
  })),
 };
}
