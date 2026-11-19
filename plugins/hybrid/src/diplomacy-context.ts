import type {SituationBrief} from './contracts.js';

const rows=(value:any):any[]=>Array.isArray(value)?value:value?.columns&&value?.rows?value.rows.map((row:any[])=>Object.fromEntries(value.columns.map((key:string,i:number)=>[key,row[i]]))):[];
const known=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);

/** Deterministic facts from the already authorized, named model projection.
 * Also usable for historical prompt replay; never consults the authoritative map. */
export function diplomacyContext(input:SituationBrief,handled:ReadonlySet<string>=new Set()):SituationBrief{
 if(input.kind!=='diplomacy')return input;
 const brief=structuredClone(input),g=brief.global as any,h=brief.guidance as any,f=brief.facts as any,e=brief.evidence as any;
 const self=brief.basis.player,selfChat=rows(g.roster).find((p:any)=>p.gamePlayer===self)?.chatPlayer??self;
 const peers=(h.fixedConversation?.identities??[]).map((p:any)=>p.gamePlayer).filter(known);
 const messages=e.messages??[],incoming=messages.filter((m:any)=>m.from!==selfChat&&!handled.has(m.id));
 const own=messages.filter((m:any)=>m.from===selfChat).at(-1),peer=messages.filter((m:any)=>m.from!==selfChat).at(-1);
 const identities=rows(g.identities).map((p:any)=>Array.isArray(p)?{name:p[0],owner:p[1],visibility:p[2]}:p);
 const owned=(player:number)=>identities.filter((p:any)=>p.owner===player).map((p:any)=>p.name).filter(Boolean);
 const contracts=rows(h.serverAgreements),tasks=rows(h.intentTasks),posts=rows(f.outposts),candidates=rows(g.planning?.candidates);
 const editableIds=h.editPolicy?.contracts?new Set(h.editPolicy.contracts.flatMap((c:any)=>c.editableTaskIds)):null;
 const editableTasks=editableIds?tasks.filter(t=>editableIds.has(t.id)):tasks;
 if(editableIds){
  const columns=h.intentTasks.columns;
  const readonlyColumns=columns.filter((key:string)=>key!=='id');
  h.readOnlyIntentTasks={columns:readonlyColumns,rows:tasks.filter(t=>!editableIds.has(t.id)).map(t=>readonlyColumns.map((key:string)=>t[key])),meaning:'独立战略、指挥官及其他会话或合同任务仅作当前背景，不提供可编辑任务身份；不得在本外交轮修改、取消或复制为履约任务'};
  h.intentTasks={columns,rows:editableTasks.map(t=>columns.map((key:string)=>t[key]))};
  h.reusableTaskIds=(h.reusableTaskIds??[]).filter((id:string)=>editableIds.has(id));
 }
 const current=contracts.filter((a:any)=>peers.includes(a.peer));
 const identityOwner=(name:string)=>identities.find((p:any)=>p.name===name)?.owner;
 h.communicationFacts={self,selfChat,peers,ownOutposts:owned(self),peerOutposts:peers.map((player:number)=>({player,outposts:owned(player)})),
  contactStage:!own&&!peer?'first-contact':'existing-conversation',
  eligibleCeasefireOutposts:identities.filter((p:any)=>p.owner===self||peers.includes(p.owner)).map((p:any)=>p.name),
  newIncomingIds:incoming.map((m:any)=>m.id),lastOwnMessageId:own?.id??null,lastPeerMessageId:peer?.id??null,
  scopeContracts:current.map((a:any)=>({id:a.id,status:a.status,kind:a.kind,allowedActions:a.allowedActions,deadline:a.deadline,ownCapturesRemaining:a.ownCapturesRemaining,peerCapturesRemaining:a.peerCapturesRemaining})),
  interpretation:'归属、签署和进度是程序事实；己方任务不表示已执行。只有当前会话双方共享的合同可作为双方已知合同；其他会话用于内部预算，不自动对外披露。没有新来信不等于禁止思考，也不要求再次发言。'};
 h.contractFeasibility=current.filter((a:any)=>a.status==='active'&&a.kind==='joint-attack').map((a:any)=>({agreementId:a.id,enemy:a.enemy,
  ownCapturesRemaining:a.ownCapturesRemaining,peerCapturesRemaining:a.peerCapturesRemaining,ownFulfilled:a.ownFulfilled,mayAddOwnFulfillmentAttack:a.ownFulfilled===false&&a.ownCapturesRemaining>0,deadline:a.deadline,ticksLeft:a.ticksLeft,
  existingEnemyCaptureTasks:editableTasks.filter((t:any)=>t.kind==='capture'&&(!editableIds||t.originAgreementId===a.id)&&!['completed','cancelled','expired'].includes(t.status)&&identityOwner(t.target)===a.enemy).map((t:any)=>t.id),
  observedEnemyTargets:posts.filter((p:any)=>p.owner===a.enemy).map((p:any)=>({target:p.name??p.id,
   currentStaticMinimum:known(p.drillers)&&known(p.shield)?p.drillers+p.shield+1:null,
   additionalForceEstimate:candidates.find((c:any)=>c.target===(p.name??p.id))?.additionalForceEstimate??null})),
  interpretation:'仅实际占领该enemy的据点才履约；其他敌人的占领不能补缺口。自动履约目标独立存在，extra任务有无不等于自动目标或真实行动有无。'}));
 h.fulfillmentFeasibility=editableTasks.filter((t:any)=>t.kind==='capture'&&!['completed','cancelled','expired'].includes(t.status)).map((t:any)=>{
  const post=posts.find((p:any)=>p.name===t.target||p.id===t.target),candidate=candidates.find((c:any)=>c.target===t.target);
  const agreement=contracts.find((a:any)=>a.id===t.originAgreementId);
  const currentStaticMinimum=known(post?.drillers)&&known(post?.shield)?post.drillers+post.shield+1:null;
  const sourceEstimates=rows(candidate?.launchSources).map((s:any)=>s.availableEstimate).filter(known);
  const screenedNewForce=candidate?.newForceForScreenedAttackEstimate??(known(candidate?.additionalForceEstimate)&&candidate.additionalForceEstimate>0&&sourceEstimates.length?Math.ceil(candidate.additionalForceEstimate+sourceEstimates.reduce((n:number,v:number)=>n+v,0)):null);
  const travel=rows(candidate?.launchSources).map((s:any)=>s.travelWorldDays).filter(known);
  const earliestSourceTravel=travel.length?Math.min(...travel):null;
  return {taskId:t.id,target:t.target,status:t.status,executionReason:t.reason??null,agreementId:t.originAgreementId??null,
   ownCapturesRemaining:agreement?.ownCapturesRemaining??null,goalMeaning:'实际占领共同敌人任意一个据点；兵损不计，目标数量不是兵力上限',
   maxDrillersPerPlan:t.maxDrillersPerPlan??null,currentStaticMinimum,
   capBelowCurrentStaticMinimum:known(t.maxDrillersPerPlan)&&currentStaticMinimum!==null?t.maxDrillersPerPlan<currentStaticMinimum:null,
   screenedNewForceEstimate:screenedNewForce,capBelowScreenedEstimate:known(t.maxDrillersPerPlan)&&screenedNewForce!==null?t.maxDrillersPerPlan<screenedNewForce:null,
   additionalForceEstimate:candidate?.additionalForceEstimate??null,earliestSourceTravel,
   deadline:agreement?.deadline??t.until,
   freshLaunchCannotArriveByDeadline:earliestSourceTravel!==null?g.time.worldDay+earliestSourceTravel>=(agreement?.deadline??t.until):null,
   targetMatchesContractEnemy:agreement?.kind==='joint-attack'&&known(post?.owner)?post.owner===agreement.enemy:null};
 });
 h.fulfillmentInterpretation='静态最低突破兵力只按当前驻军+护盾+1计算，不含航行期间生产、在途兵和未来命令；不是已完成战斗模拟。上限不足、任务pending/blocked或没有新出发时，不能写成已在推进或等抵达；比较提高可承担上限、换同敌目标、集结与止损，不将一个占领目标误作一兵投入上限。先核对目标属于合同敌人；本方已达标不再为该合同新增进攻。';
 if(h.relationAdvice?.agreementCapacity)h.relationAdvice.agreementCapacity=h.relationAdvice.agreementCapacity.map((p:any)=>p.complete?p:{player:p.player,complete:false,
  visibleCeasefiresLowerBound:p.ceasefires??p.visibleCeasefiresLowerBound,visibleJointAttacksLowerBound:p.jointAttacks??p.visibleJointAttacksLowerBound,
  actualCeasefires:null,actualJointAttacks:null,remainingCeasefires:null,remainingJointAttacks:null,meaning:'对方完整合同和实际剩余名额未知，零可见数量不代表零占用；签署由服务器复核'});
 return brief;
}
