import type {PlayerObservation,AttackRoutes} from '../../../../contracts/src/index.js';
import {scheduledCommitments} from './scheduled-commitments.js';
import {botDistance} from './tactical-evaluation.js';
import {botGarrisonPolicy} from './tactical-force-policy.js';
import {botDispatchPlanAllowed} from './tactical-dispatch-policy.js';
import {createOutpostRiskAnalysis,type OutpostRiskAnalysis} from './outpost-risk.js';
import type {BotCandidate} from './tactical-candidates.js';
import type {TacticalGuidance} from './tactical-planner.js';
type Post=PlayerObservation['view']['outposts'][number];
/** Shared friendly infantry housekeeping. Every candidate remains hypothetical
 * until the common resource, ownership-path and survival checks succeed. */
export function internalTroopCandidates(o:PlayerObservation,routes:AttackRoutes,horizon=144,risks:OutpostRiskAnalysis=createOutpostRiskAnalysis(o,undefined,routes),guidance?:TacticalGuidance):BotCandidate[]{
 const v=o.view,own=v.outposts.filter(p=>p.owner===v.player&&!p.destroyed&&p.visibility===2);
 const commitments=new Map(scheduledCommitments(o).map(c=>[c.source,c]));
 const enemies=v.outposts.filter(p=>p.owner!=null&&p.owner!==v.player&&!p.destroyed&&p.visibility===2);
 const front=(p:Post)=>Math.min(Infinity,...enemies.map(e=>botDistance(p.position,e.position,v.size)));
 const transfers:BotCandidate[]=[];
 const remainingNeed=new Map(own.map(p=>[p.id,risks.get(p.id).shortfall]));
 let allocation=o,allocationRisks=risks;
 for(const source of [...own].sort((a,b)=>risks.get(a.id).priority-risks.get(b.id).priority||a.id.localeCompare(b.id))){
  if(transfers.length>=3)break;
  if(guidance?.protectedSources.includes(source.id))continue;
  const budget=botGarrisonPolicy(allocation,source.id,allocationRisks);
  const reserve=Math.max(0,...(guidance?.reserves.filter(r=>r.source===source.id).map(r=>r.drillers)??[]));
  const spare=Math.min(budget.spare,Math.max(0,risks.available(source)-reserve));
  if(spare<=0||commitments.get(source.id)?.unknownSchedules.length||v.fleets.some(f=>f.owner!==v.player&&!f.gift&&f.destination?.id===source.id))continue;
  const targets=own.filter(p=>p.id!==source.id&&!v.fleets.some(f=>f.owner===v.player&&f.state==='waiting'&&f.source===source.id&&f.destination?.id===p.id))
   .map(target=>({target,need:remainingNeed.get(target.id)??0,eta:routes.postTicks[source.id]?.[target.id]??null,risk:risks.get(target.id)}))
   .filter(x=>x.eta!==null&&x.eta+1<=Math.min(72,horizon)&&(x.need>0||front(x.target)<3&&front(source)>front(x.target)+2))
   .sort((a,b)=>Number(b.risk.earliestDeficitTicks!==null)-Number(a.risk.earliestDeficitTicks!==null)||b.risk.priority-a.risk.priority||b.need-a.need||a.eta!-b.eta!||a.target.id.localeCompare(b.target.id));
  const target=targets[0];if(!target)continue;
  const drillers=Math.min(spare,target.need>0?Math.ceil(target.need):Math.floor(spare/2));
  if(drillers<=0||target.need<=0&&drillers<5)continue;
  const id=`internal-troops:${source.id}:${target.target.id}`;
  const candidate:BotCandidate={id,kind:target.need>0?'defense':'logistics',objective:`reinforce:${target.target.id}`,targets:[target.target.id],priority:target.need>0?100:25,
   drafts:[{id:`${id}:launch`,issueTick:v.tick,action:{kind:'launch',source:source.id,destination:target.target.id,drillers}}],
   reasons:[target.need>0?'内部补防：按可见守备缺口和来源富余调兵，实际赶上时序仍须核验':'内部前送：安静后方的部分富余兵力送至已知前线，保留来源机动兵力']};
  if(botDispatchPlanAllowed(o,candidate.drafts)){
   // This is only a hypothetical completed allocation. Transit and early
   // losses must still pass the common path forecast before execution.
   const next:PlayerObservation={...allocation,view:{...allocation.view,outposts:allocation.view.outposts.map(p=>p.id===source.id?{...p,drillers:(p.drillers??0)-drillers}:p.id===target.target.id?{...p,drillers:(p.drillers??0)+drillers}:p)}};
   const nextRisks=createOutpostRiskAnalysis(next,risks.config,routes);
   const beforePenalty=allocationRisks.own().reduce((n,r)=>n+r.penalty,0),afterPenalty=nextRisks.own().reduce((n,r)=>n+r.penalty,0);
   if(afterPenalty>beforePenalty+1e-6)continue;
   transfers.push(candidate);remainingNeed.set(target.target.id,Math.max(0,target.need-drillers));
   allocation=next;allocationRisks=nextRisks;
  }
 }
 transfers.sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id));
 return transfers;
}
export function internalTransferPrelude(o:PlayerObservation,routes:AttackRoutes,horizon=144,risks?:OutpostRiskAnalysis,guidance?:TacticalGuidance):BotCandidate[]{
 const candidates=internalTroopCandidates(o,routes,horizon,risks,guidance);
 if(candidates.length<2)return candidates;
 const joint:BotCandidate={id:'internal-group:'+candidates.map(c=>c.id).join('|'),kind:'combined',objective:'internal-relocation',
  targets:[...new Set(candidates.flatMap(c=>c.targets))],drafts:candidates.flatMap(c=>c.drafts),priority:100,reasons:candidates.flatMap(c=>c.reasons)};
 return botDispatchPlanAllowed(o,joint.drafts)?[joint,...candidates]:candidates;
}
