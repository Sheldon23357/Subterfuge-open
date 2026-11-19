import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import {DIPLOMACY_RULES} from '@subterfuge/bot-sdk/rules';

/** Bot advice, never server admission rules or a prediction of allied action. */
export const BOT_RELATION_POLICY={
 highTrust:20,lowTrust:-20,selfTrustWeight:.2,peerTrustWeight:.1,maxPeerBonus:12,
 maxOpenJointContracts:DIPLOMACY_RULES.maxActiveJointAttacks,maxEnemyFronts:2,
 subsidyStockFraction:.1,maxSubsidy:5,jointTargets:4,jointTargetsPerEnemy:2,
} as const;

export function cooperationBonus(o:PlayerObservation,peer:number){
 const relations=o.diplomacy?.relations;
 const outgoing=relations?.find(r=>r.from===o.view.player&&r.to===peer)?.trust;
 const incoming=relations?.find(r=>r.from===peer&&r.to===o.view.player)?.trust;
 return Math.max(-BOT_RELATION_POLICY.maxPeerBonus,Math.min(BOT_RELATION_POLICY.maxPeerBonus,
  (outgoing??0)*BOT_RELATION_POLICY.selfTrustWeight+(incoming??0)*BOT_RELATION_POLICY.peerTrustWeight));
}

export function relationAdvice(o:PlayerObservation){
 const self=o.view.player,now=o.view.tick+o.secondsSinceLastTick/600,p=BOT_RELATION_POLICY;
 const contracts=(o.diplomacy?.agreements??[]).filter(a=>a.terms.kind==='joint-attack'&&a.players.includes(self)&&a.deadline>now&&
  (a.status==='active'&&!a.fulfilled[a.players.indexOf(self)]||a.status==='proposed'&&a.players[0]===self));
 const obligations=contracts.map(a=>({agreementId:a.id,enemy:a.terms.kind==='joint-attack'?a.terms.enemy:-1,
  remaining:DIPLOMACY_RULES.jointCaptureGoal-a.progress[a.players.indexOf(self)]!,
  ticksLeft:Math.max(0,a.deadline-now),status:a.status}));
 const fronts=[...new Set(obligations.map(a=>a.enemy))].map(enemy=>({enemy,remaining:1}));
 const agreementCapacity=o.intel.filter(i=>i.active).map(i=>{const active=(o.diplomacy?.agreements??[]).filter(a=>a.status==='active'&&a.players.includes(i.player));
  // Only self has a complete authorized list; peer counts are known lower bounds.
  const ceasefires=active.filter(a=>a.terms.kind==='ceasefire').length,jointAttacks=active.filter(a=>a.terms.kind==='joint-attack').length;
  return {player:i.player,complete:i.player===self,ceasefires,jointAttacks,
   ...(i.player===self?{remainingCeasefires:Math.max(0,DIPLOMACY_RULES.maxActiveCeasefires-ceasefires),remainingJointAttacks:Math.max(0,DIPLOMACY_RULES.maxActiveJointAttacks-jointAttacks)}:{})};});

 return {parameters:p,serverLimits:{ceasefires:DIPLOMACY_RULES.maxActiveCeasefires,jointAttacks:DIPLOMACY_RULES.maxActiveJointAttacks},agreementCapacity,obligations,fronts,captureGoal:DIPLOMACY_RULES.jointCaptureGoal,
  suggestedSubsidyCeiling:Math.min(p.maxSubsidy,Math.floor(Math.max(0,o.view.self.neptunium)*p.subsidyStockFraction)),
  interpretation:'双方各自占领共同敌人任意一个据点。这里只整理当前责任和名额，不将兵力折算为额度，不增加提案或签约频率门槛；来源安全、进攻期限和指挥官要求仍须评估。'};
}
