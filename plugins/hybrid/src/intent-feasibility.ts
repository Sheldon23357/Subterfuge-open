import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import {basicRouteTicks} from '@subterfuge/bot-sdk/prediction';
import {botGarrisonPolicy} from '@subterfuge/bot-sdk/analysis/tactical-force-policy';
import type {HybridState,IntentTask,OperationState} from './contracts.js';
import type {hybridPlanning} from './planning.js';

const live=(t:IntentTask,now:number)=>!['completed','cancelled','expired'].includes(t.status)&&t.spec.until>now;
const underway=(op:OperationState)=>['proposed','accepted','underway','review'].includes(op.status);
/** Bounded triggers describe a changed execution problem, never choose a strategy. */
export function intentReviewKey(o:PlayerObservation,state:HybridState,operations:OperationState[]){
 const now=o.view.tick+o.secondsSinceLastTick/600;
 return JSON.stringify((state.intents??[]).filter(t=>live(t,now)&&t.authority!=='commander').flatMap(t=>{
  if(operations.some(op=>underway(op)&&op.intentBindings?.some(b=>b.id===t.id)))return [];
  const s=t.spec;if(!['capture','transfer','configure'].includes(s.kind))return [];
  if(s.kind==='configure'&&s.maintain&&t.status==='running')return [];
  if(now-t.createdAt<24&&t.status!=='blocked')return [];
  const {until,reason,...parameters}=s;
  return [[t.id,Object.fromEntries(Object.entries(parameters).sort(([a],[b])=>a.localeCompare(b)))]];
 }).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
}
/** Finishing/removing one issue does not re-open all remaining reviewed tasks. */
export function hasNewIntentIssue(current:string,reviewed:string|undefined){
 const previous=new Set((JSON.parse(reviewed??'[]') as unknown[]).map(v=>JSON.stringify(v)));
 return (JSON.parse(current) as unknown[]).some(v=>!previous.has(JSON.stringify(v)));
}

/** Only authorized observations, retained operation evidence and program estimates.
 * A cap or missing shortlist route is not a proof that no strategy can work. */
export function intentFeasibility(o:PlayerObservation,state:HybridState,planning:ReturnType<typeof hybridPlanning>,operations:OperationState[]=[],editableIds?:ReadonlySet<string>){
 const now=o.view.tick+o.secondsSinceLastTick/600;
 return (state.intents??[]).filter(t=>live(t,now)&&(!editableIds||editableIds.has(t.id))).map(t=>{
  const s=t.spec,linked=operations.filter(op=>op.intentBindings?.some(b=>b.id===t.id));
  const lastAccepted=linked.filter(op=>op.orders.length||op.receiptIds?.length).sort((a,b)=>b.basis.tick-a.basis.tick)[0];
  const post='target'in s?o.view.outposts.find(p=>p.id===s.target):undefined;
  const base={taskId:t.id,kind:s.kind,...('target'in s?{target:s.target}:{}),status:t.status,executionReason:t.reason,
   ageWorldDays:now-t.createdAt,deadline:s.until,remainingWorldDays:s.until-now,
   linkedLiveOperation:linked.some(underway),lastRetainedAcceptedTick:lastAccepted?.basis.tick??null,
   operationEvidence:'仅当前保留的关联操作；null不推断完整历史无行动，出发不表示交付或占领'};
  if(s.kind==='capture'){
   const c=planning.candidates.find(c=>c.target===s.target),staticMinimum=post?.visibility===2&&post.drillers!==undefined&&post.shield!==undefined?post.drillers+post.shield+1:null;
   const cap=s.maxDrillersPerPlan??null,travel=c?.launchSources.length?Math.min(...c.launchSources.map(s=>s.travelWorldDays)):null;
   const screened=c?.newForceForScreenedAttackEstimate??null;
   return {...base,maxDrillersPerPlan:cap,currentStaticMinimum:staticMinimum,screenedNewForceEstimate:screened,
    capBelowCurrentStaticMinimum:cap!==null&&staticMinimum!==null?cap<staticMinimum:null,
    capBelowScreenedEstimate:cap!==null&&screened!==null?cap<screened:null,
    additionalForceEstimate:c?.additionalForceEstimate??null,earliestListedSourceTravel:travel,
    freshLaunchCannotArriveByDeadline:travel===null?null:now+travel>s.until,
    listedSources:c?.launchSources??[],interpretation:'静态成本不含未来生产、在途兵与敌方命令；初筛是估算。低上限、超期或长期无对应行动时比较调整投入、改目标、集结或取消，不能仅续期。'};
  }
  if(s.kind==='transfer'){
   const source=o.view.outposts.find(p=>p.id===s.source&&p.owner===o.view.player&&!p.destroyed),target=post?.owner===o.view.player&&!post.destroyed?post:undefined;
   const reserves=[...(state.directive?.reserves??[]),...(state.directive?.commanderConstraints.reserves??[]),...(state.intents??[]).filter(t=>live(t,now)&&t.spec.kind==='configure'&&t.spec.maintain).flatMap(t=>t.spec.kind==='configure'&&t.spec.target===s.source&&t.spec.minDrillers!==null?[{source:s.source,drillers:t.spec.minDrillers}]:[])];
   const protectedSource=[...(state.directive?.protectedSources??[]),...(state.directive?.commanderConstraints.protectedSources??[])].includes(s.source);
   const reserve=Math.max(0,...reserves.filter(r=>r.source===s.source).map(r=>r.drillers));
   const available=source?.drillers===undefined?null:protectedSource?0:Math.max(0,Math.min(botGarrisonPolicy(o,s.source).spare,source.drillers-reserve));
   const travel=source&&target?basicRouteTicks(source.position,target.position,o.view.size,o.view.tick,144):null;
   return {...base,source:s.source,requestedDrillers:s.drillers,safeAvailableEstimate:available,reserve,protectedSource,
    sourceCurrentlyFriendly:!!source,targetCurrentlyFriendly:!!target,travelWorldDays:travel,
    routeStatus:!source||!target?'authorized-endpoints-unavailable':travel===null?'beyond-144-world-day-window':'estimated',
    requestedExceedsSafeAvailable:s.drillers!==null&&available!==null?s.drillers>available:null,
    routeExceedsExecutionWindow:travel===null?source&&target?true:null:travel+1>Math.min(144,s.until-now),
    interpretation:'来源安全可调和航程是程序初筛；接收点有来袭仍可生成增援候选，联合预测必须确认实际友方交付，不能以离港算成功。'};
  }
  if(s.kind==='configure')return {...base,targetCurrentlyFriendly:post?.owner===o.view.player&&!post.destroyed,currentDrillers:post?.owner===o.view.player?post.drillers??null:null};
  return base;
 });
}
