import type {DiplomacyNeed} from './contracts.js';
const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
/** Planning diagnostics stay in the audit. Negotiation receives the actual cause and bounded summary, not duplicated search traces. */
export function pressureBrief(needs:readonly DiplomacyNeed[]){
 return needs.map(n=>{
  const e=object(n.evidence),search=object(e.search),target=object(e.target);
  const evidence=n.kind==='defense-pressure'?{actualIncoming:e.actualIncoming,arrivalShortfall:e.arrivalShortfall,estimatedShortfall:e.estimatedShortfall,pressureRatio:e.pressureRatio,earliestDeficitWorldDays:e.earliestDeficitTicks,selected:e.selected,selectedConditional:e.selectedConditional}
   :n.kind==='opening-contest'?{target:target.id,zone:target.zone,rivalPlayer:target.rivalPlayer,claimForce:target.claimForce,competitionForce:target.competitionForce,friendlyIncoming:target.friendlyIncoming,hostileIncoming:target.hostileIncoming}
   :{selected:e.selected,targetOwner:e.targetOwner,evaluated:e.evaluated,searchComplete:search.complete,stopReason:search.stopReason,alternatives:Array.isArray(e.attempts)?e.attempts.map((a:Record<string,unknown>)=>({objective:a.objective,status:a.status})):[]};
  return {kind:n.kind,targets:n.targets,opponents:n.opponents,evidence,limits:n.limits};
 });
}
