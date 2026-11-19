import {DIPLOMACY_RULES} from '@subterfuge/bot-sdk/rules';
import type {SituationBrief} from './contracts.js';
const pick=(o:any,keys:string[])=>o&&typeof o==='object'?Object.fromEntries(keys.filter(k=>Object.hasOwn(o,k)).map(k=>[k,o[k]])):o;
/** Model facts are a projection, not serialized storage, replay or audit records. */
export function projectModelBrief(input:SituationBrief):SituationBrief{
 const b=structuredClone(input),g=b.global as any,f=b.facts as any,h=b.guidance as any,e=b.evidence as any;
 if(h.relationAdvice)delete h.relationAdvice.parameters;
 b.basis=pick(b.basis,['player','tick','commanderVersion']) as any;
 g.self=pick(g.self,['active','drillers','capacity','neptunium','mineCreationCost','outpostCount']);
 g.match=pick(g.match,['mode','neptuniumGoal','ended']);
 if(g.feedback)g.feedback={...pick(g.feedback,['assessedAtWorldDay','selected','selectedPlan','limitations','conditionalAlternatives','unverified','objects','diplomacyNeeds']),coverage:pick(g.feedback.coverage,['generated','evaluated','simulations','complete','stopReason'])};
 f.scheduled=f.scheduled.map((q:any)=>({...pick(q,['id','player','issueTick','status','reason']),action:pick(q.action,['kind','source','destination','outpostId','drillers','fleetId','enabled','target','orderId'])}));
 if(e.messages)e.messages=e.messages.map((m:any)=>pick(m,['id','from','to','tick','text']));
 if(h.serverAgreements){
  const now=g.time.worldDay,self=input.basis.player;
  h.serverAgreements=h.serverAgreements.map((a:any)=>{const i=a.players.indexOf(self),j=1-i,joint=a.terms.kind==='joint-attack';
   return {id:a.id,peer:a.players[j],kind:a.terms.kind,status:a.status,endedAt:a.endedAt,...(a.status==='proposed'?{ownProposalRole:i===0?'发起方':'接收方'}:{}),allowedActions:a.status==='proposed'?(i===1?'accept,reject,counter':'withdraw'):'none',deadline:a.deadline,ticksLeft:Math.max(0,a.deadline-now),
    ...(joint?{enemy:a.terms.enemy,ownCaptureGoal:DIPLOMACY_RULES.jointCaptureGoal,peerCaptureGoal:DIPLOMACY_RULES.jointCaptureGoal,ownProgress:a.progress[i],peerProgress:a.progress[j],ownCapturesRemaining:Math.max(0,DIPLOMACY_RULES.jointCaptureGoal-a.progress[i]),peerCapturesRemaining:Math.max(0,DIPLOMACY_RULES.jointCaptureGoal-a.progress[j]),ownFulfilled:a.fulfilled[i],peerFulfilled:a.fulfilled[j],ownTrustReward:DIPLOMACY_RULES.jointFulfillmentTrust,ownShortfallPenalty:a.fulfilled[i]?0:DIPLOMACY_RULES.jointUnfulfilledPenalty}:{outposts:a.terms.outposts}),
    ...(a.subsidy?{subsidyPayer:a.subsidy.payer,subsidyAmount:a.subsidy.amount,subsidyPaid:a.startedAt!==null}:{}),...(a.reason?{reason:a.reason}:{})};});
  // One row contains terms, responsibility and computed deltas; no duplicate goals.
  const columns=['id','peer','kind','status','ownProposalRole','allowedActions','deadline','ticksLeft','enemy','outposts','ownCaptureGoal','peerCaptureGoal','ownProgress','peerProgress','ownCapturesRemaining','peerCapturesRemaining','ownFulfilled','peerFulfilled','ownTrustReward','ownShortfallPenalty','subsidyPayer','subsidyAmount','subsidyPaid','reason','endedAt'];
  h.serverAgreements={columns,rows:h.serverAgreements.map((a:any)=>columns.map(k=>a[k]??null))};
  delete h.contractGoals;
  h.contractResults={columns:['kind','agreementId','actor','time','result'],rows:h.contractResults.map((r:any)=>[r.kind,r.agreementId,r.actor,r.time,pick(r.details,['reason','status','from','to','before','after','payer','payee','amount','capturedOutposts','total'])])};
 }
 if(g.relations)g.relations.values={columns:['from','to','trust','history','borderPressure','competitionPressure'],rows:g.relations.values.map((r:any)=>[r.from,r.to,r.trust,r.history,r.borderPressure,r.competitionPressure])};
 return b;
}
