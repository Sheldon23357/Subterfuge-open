import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {StrategicDirective} from './contracts.js';
import {createOutpostRiskAnalysis} from '@subterfuge/bot-sdk/analysis/outpost-risk';

export const strategyReviewIntervals={periodicTicks:10,periodicMs:300000,changedTicks:12,changedMs:120000,threatTicks:2,threatMs:20000} as const;
export const forceBand=(n:number)=>n>0?Math.floor(Math.log2(n))+1:0;

/** Tactical waits, ordinary production and fleet travel are handled by the foreground. */
export function strategyReviewKeys(o:PlayerObservation,commanderVersion:number,directive:StrategicDirective|null){
 const own=o.view.outposts.filter(p=>p.owner===o.view.player&&!p.destroyed),ids=new Set(own.map(p=>p.id));
 const ordered=(rows:unknown[][])=>rows.sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 const incoming=o.view.fleets.filter(f=>f.owner!==o.view.player&&!f.gift&&f.destination?.kind==='outpost'&&ids.has(f.destination.id));
 const risk=incoming.length?createOutpostRiskAnalysis(o):null;
 const approaches=own.filter(p=>incoming.some(f=>f.destination!.id===p.id)).map(p=>{
  const waves=incoming.filter(f=>f.destination!.id===p.id),r=risk!.get(p.id);
  return [p.id,[...new Set(waves.map(f=>f.owner))].sort(),forceBand(waves.reduce((n,f)=>n+f.drillers,0)),r.arrivalShortfall>0,r.earliestDeficitTicks!==null&&r.earliestDeficitTicks<=12];
 });
 // Structural authority changes invalidate immediately. Fleet churn is merged
 // into threat episodes; individual fleet identities are still in the brief and publication guard.
 const urgent=JSON.stringify([commanderVersion,o.view.self.active,
  ordered(o.diplomacy?.agreements.filter(a=>a.startedAt!==null).map(a=>[a.id,a.status,a.fulfilled])??[]),
  ordered(own.map(p=>[p.id,p.type])),ordered(approaches.filter(row=>row[3]===true&&row[4]===true).map(row=>[row[0]]))]);
 const threat=JSON.stringify(ordered(approaches));
 const goal=o.view.match?.neptuniumGoal;
 const important=JSON.stringify([urgent,threat,
  o.diplomacy?.relations.map(r=>[r.from,r.to,Math.floor(r.trust/20)]),
  ordered((directive?.agreements??[]).map(a=>[a.conversation,a.status,a.forbidAttack,[...a.forbiddenTargets].sort(),a.expiresWorldDay,a.jointAttack??null])),
  ordered(o.intel.map(p=>[p.player,p.active,goal&&goal>0?Math.floor(p.neptunium/goal*5):null,p.npPerDay,p.numOutposts,p.outposts]))]);
 return {urgent,important,threat};
}
