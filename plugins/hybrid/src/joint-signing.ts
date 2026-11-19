import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import {DIPLOMACY_RULES} from '@subterfuge/bot-sdk/rules';
import type {hybridPlanning} from './planning.js';
import {BOT_RELATION_POLICY} from './relation-policy.js';

/** Reuse the existing bounded screening, without assuming allied action or
 * counting shared sources once per target. This is advice, not server admission. */
export function jointSigningAssessment(o:PlayerObservation,planning:ReturnType<typeof hybridPlanning>,peers:number[],hard:{forbiddenPlayers?:number[];forbiddenTargets?:string[];protectedSources?:string[];reserves?:{source:string;drillers:number}[]}){
 const self=o.view.player,now=o.view.tick+o.secondsSinceLastTick/600;
 const protectedPosts=new Set(o.diplomacy?.agreements.filter(a=>a.status==='active'&&a.deadline>now&&a.terms.kind==='ceasefire').flatMap(a=>a.terms.kind==='ceasefire'?a.terms.outposts:[])??[]);
 return o.intel.filter(p=>p.active&&p.player!==self&&!peers.includes(p.player)).map(player=>{
  const enemy=player.player;
  const candidates=planning.candidates.filter(c=>c.owner===enemy).map(c=>{
   const post=o.view.outposts.find(p=>p.id===c.target),known=post?.visibility===2&&Number.isSafeInteger(post.drillers)&&Number.isSafeInteger(post.shield);
   const permitted=!hard.forbiddenPlayers?.includes(enemy)&&!hard.forbiddenTargets?.includes(c.target)&&!protectedPosts.has(c.target);
   const inWindow=c.attackWorldDays!==null&&c.attackWorldDays<DIPLOMACY_RULES.jointAttackTicks;
   const sources=c.launchSources.map(s=>{
    const post=o.view.outposts.find(p=>p.id===s.source&&p.owner===self&&!p.destroyed);
    if(!post||!Number.isFinite(post.drillers)||!Number.isFinite(s.availableEstimate))return null;
    const reserve=Math.max(0,...(hard.reserves??[]).filter(r=>r.source===s.source).map(r=>r.drillers));
    return hard.protectedSources?.includes(s.source)?0:Math.max(0,Math.min(s.availableEstimate,post.drillers!-reserve));
   });
   const sourceBudget=sources.length&&sources.every(s=>s!==null)?sources.reduce<number>((sum,s)=>sum+s!,0):null;
   const supported=known&&permitted&&inWindow&&sourceBudget!==null&&sourceBudget>=c.newForceForScreenedAttackEstimate&&c.classification==='action'&&c.additionalForceEstimate===0;
   return {target:c.target,screening:c.classification,permitted,arrivalWorldDays:c.attackWorldDays,withinContractWindow:inWindow,
    newForceEstimate:c.newForceForScreenedAttackEstimate,availableAfterKnownConstraintsEstimate:sourceBudget,additionalForceEstimate:c.additionalForceEstimate,
    supportedByCurrentScreening:supported,concerns:c.assessment.reasons};
  });
  const supported=candidates.filter(c=>c.supportedByCurrentScreening);
  const prohibited=hard.forbiddenPlayers?.includes(enemy)===true;
  const proposals=o.diplomacy?.agreements.filter(a=>a.status==='proposed'&&a.terms.kind==='joint-attack'&&a.terms.enemy===enemy&&a.players.includes(self)&&a.players.some(p=>peers.includes(p)))??[];
  return {enemy,contractWindowWorldDays:DIPLOMACY_RULES.jointAttackTicks,captureGoal:DIPLOMACY_RULES.jointCaptureGoal,prohibited,
   assessment:supported.length?'conditional-support':candidates.length?'conditions-unmet':'not-assessed',candidates,
   proposals:proposals.map(a=>({id:a.id})),
   peerExecution:'unknown',coverage:planning.coverage,
   meaning:'双方各自占领共同敌人任意一个据点，无战损额度。初筛仅帮助选目标、集结和安排兵力；未评估或条件不足不自动禁止接触、提案或接受，也不保证能履约。不得假定盟友已出兵；来源保护、禁攻、期限和实际名额继续有效。'};
 });
}
