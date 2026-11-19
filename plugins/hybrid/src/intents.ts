import type {PlayerObservation,AttackRoutes} from '@subterfuge/bot-sdk/contracts';
import {botGarrisonPolicy} from '@subterfuge/bot-sdk/analysis/tactical-force-policy';
import {botDispatchPlanAllowed} from '@subterfuge/bot-sdk/analysis/tactical-dispatch-policy';
import type {BotCandidate} from '@subterfuge/bot-sdk/analysis/tactical-candidates';
import type {HybridState,IntentEdits,IntentTask,OperationState,Objective} from './contracts.js';
import {manualProtectionEntities} from '@subterfuge/bot-sdk/execution/manual-coordination';
import {effectiveAgreement} from './agreement-active.js';
import {commanderTransportUnsafe} from './commander-commitments.js';
const active=(t:IntentTask)=>!['completed','expired','cancelled'].includes(t.status);
const entity=(spec:IntentTask['spec'])=>'fleetId' in spec?spec.fleetId:spec.kind==='transfer'?spec.source+'->'+spec.target:spec.target;
export function fleetIntentCompleted(o:PlayerObservation,spec:IntentTask['spec'],operations:OperationState[]=[]){
 if(!('fleetId' in spec))return false;
 const f=o.view.fleets.find(f=>f.id===spec.fleetId);
 if(spec.kind==='return-fleet')return f?.owner===o.view.player&&f.returned===true||(o.activity??[]).some(e=>e.subject===spec.fleetId&&e.kind==='fleet-recalled'&&e.actor===o.view.player)||operations.some(p=>p.phase==='fleet-intent'&&['accepted','completed'].includes(p.status)&&p.receiptIds?.length&&p.drafts.some(d=>d.action.kind==='return-fleet'&&d.action.fleetId===spec.fleetId));
 return false;
}
/** Shared draft eligibility. The foreground dispatches commander instructions;
 * autonomous model intents instead enter weighted candidate selection. */
export function fleetIntentDraft(o:PlayerObservation,state:HybridState,operations:OperationState[],excluded:ReadonlySet<string>=new Set(),authority?:'commander'|'model'){
 for(const t of state.intents??[]){
  if(authority!==undefined&&t.authority!==authority||excluded.has(t.id)||!active(t)||!('fleetId' in t.spec)||t.spec.kind!=='return-fleet'||t.spec.until<=o.view.tick+o.secondsSinceLastTick/600)continue;
  const linked=operations.filter(p=>p.intentBindings?.some(b=>b.id===t.id&&b.version===t.version));
  if(linked.some(p=>['proposed','accepted','underway','completed','ended','failed'].includes(p.status)||p.status==='review'))continue;
  const spec=t.spec;
  const f=o.view.fleets.find(f=>f.id===spec.fleetId);
  if(!f||f.owner!==o.view.player)continue;
  if((o.manualCommands?.protections??[]).some(p=>manualProtectionEntities(p).includes(f.id))){t.status='blocked';t.reason='人工保护中的舰队，禁止修改';continue;}
  if(t.spec.kind==='return-fleet'&&f.canReturn!==true){t.status='blocked';t.reason='舰队已返航或无返航资格';continue;}
  return {task:t,draft:{id:`${t.id}:v${t.version}`,issueTick:o.view.tick,action:{kind:'return-fleet',fleetId:f.id}}};
 }
 return null;
}
const canonical=(v:any):string=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
// Wording is audited in spec.reason, but cannot invalidate execution links or
// reactivate one-shot work. All structured parameters still change the version.
const executionSpec=(spec:IntentTask['spec'])=>{const {reason,until,...parameters}=spec;return canonical({...parameters,...(spec.kind==='capture'?{maxDrillersPerPlan:spec.maxDrillersPerPlan??null}:{})});};
export function applyIntentEdits(state:HybridState,edits:IntentEdits,authority:IntentTask['authority'],version:number,o:PlayerObservation,origin?:IntentTask['origin']){
 const tasks=structuredClone(state.intents??[]),now=o.view.tick+o.secondsSinceLastTick/600;let serial=state.intentSerial??0;
 const editable=(id:string)=>{const t=tasks.find(t=>t.id===id);if(!t)throw Error('Unknown intent ID');if(t.authority==='commander'&&authority!=='commander')throw Error('Confirmed commander task cannot be edited by strategy');return t;};
 for(const id of edits.cancel){const t=editable(id);t.status='cancelled';t.reason='意图已取消；已接受的运输仍按真实回执追踪';t.updatedAt=now;}
 for(const edit of structuredClone(edits.upsert)){
  const spec=edit.task;
  if(spec.kind==='focus'&&authority!=='commander')throw Error('Focus requires commander authority');
  if(spec.kind==='transfer'&&(!o.view.outposts.some(p=>p.id===spec.source&&p.owner===o.view.player&&!p.destroyed)||!o.view.outposts.some(p=>p.id===spec.target&&p.owner===o.view.player&&!p.destroyed)||spec.source===spec.target))throw Error('Transfer requires different current friendly source and target');
  if(spec.kind==='focus'&&!o.view.outposts.some(p=>p.id===spec.rally&&p.owner===o.view.player&&!p.destroyed))throw Error('Focus requires current friendly rally');
  if(edit.task.until<=now)throw Error('Invalid intent deadline: must be in the future');
  if(spec.kind==='configure'&&!o.view.outposts.some(p=>p.id===spec.target&&p.owner===o.view.player&&!p.destroyed))throw Error('Configuration target must be a current friendly post');
  if('fleetId' in spec&&!o.view.fleets.some(f=>f.id===spec.fleetId&&f.owner===o.view.player))throw Error('Fleet intent requires a current own fleet');
  if('fleetId'in spec&&authority!=='commander'&&(state.intents??[]).some(t=>{
   const route=t.spec;
   return t.authority==='commander'&&t.commanderVersion===state.commanderVersion&&route.kind==='transfer'&&!['cancelled','expired'].includes(t.status)&&route.until>now&&o.view.fleets.some(f=>f.id===spec.fleetId&&f.source===route.source&&f.destination?.id===route.target)&&!commanderTransportUnsafe(o,route.target);
  }))throw Error('Commander transfer cannot be recalled by autonomous strategy; request commander change or report safety exit');
  const existing=edit.id!==null?editable(edit.id):tasks.find(t=>t.authority===authority&&t.origin?.conversation===origin?.conversation&&t.origin?.agreementId===origin?.agreementId&&((active(t)||authority==='commander'&&t.commanderVersion===version&&t.spec.kind==='transfer'&&t.status==='completed')&&t.spec.kind===edit.task.kind&&entity(t.spec)===entity(edit.task)||executionSpec(t.spec)===executionSpec(edit.task)&&t.spec.until===spec.until));
  if(spec.kind==='capture'&&existing?.spec.kind==='capture'&&existing.spec.target===spec.target&&!Object.hasOwn(spec,'maxDrillersPerPlan')&&existing.spec.maxDrillersPerPlan!==undefined)spec.maxDrillersPerPlan=existing.spec.maxDrillersPerPlan;
  // Explicit commander adoption of a model task changes its authority, even
  // when its parameters are unchanged. Keep the version and execution links
  // for identical work so adoption cannot cause the same transport to resend.
  if(existing&&authority==='commander'&&existing.authority==='model'){
   existing.authority='commander';existing.commanderVersion=version;existing.updatedAt=now;
  }
  if(existing?.authority==='commander'&&existing.commanderVersion===version&&existing.status==='completed'&&existing.spec.kind==='transfer'&&spec.kind==='transfer'&&entity(existing.spec)===entity(spec))continue;
  if(existing&&spec.until>=existing.spec.until&&(active(existing)||existing.spec.until===spec.until)&&executionSpec(existing.spec)===executionSpec(edit.task)&&(!origin||existing.origin?.conversation===origin.conversation&&existing.origin?.agreementId===origin.agreementId)&&!(authority==='commander'&&existing.commanderVersion!==version)){
   if(existing.spec.reason!==spec.reason||existing.spec.until!==spec.until){existing.spec.reason=spec.reason;existing.spec.until=spec.until;existing.updatedAt=now;}
   continue;
  }
  const sameGoal=existing&&existing.spec.kind===edit.task.kind&&entity(existing.spec)===entity(edit.task);
  if(existing){existing.spec=structuredClone(edit.task);existing.version++;existing.status='pending';existing.reason='目标已更新，待核验';existing.commanderVersion=version;existing.updatedAt=now;if(origin)existing.origin=origin;else if(!sameGoal)delete existing.origin;}
  else tasks.push({id:'intent-'+(++serial),version:1,spec:structuredClone(edit.task),authority,commanderVersion:version,status:'pending',reason:'待程序评估',createdAt:now,updatedAt:now,...(origin?{origin}:{})});
 }
 if(tasks.filter(active).length>64)throw Error('Active intent capacity exceeded');
 state.intents=tasks;state.intentSerial=serial;
}
export function reconcileIntents(o:PlayerObservation,state:HybridState,operations:OperationState[]){
 const now=o.view.tick+o.secondsSinceLastTick/600;
 for(const t of state.intents??[]){
  if(!active(t))continue;
  const spec=t.spec;
  const update=(status:IntentTask['status'],reason:string)=>{if(t.status!==status||t.reason!==reason){t.status=status;t.reason=reason;t.updatedAt=now;}};
  if(t.authority==='commander'&&t.commanderVersion!==state.commanderVersion){update('cancelled','已确认指挥官版本改变，等待新版本转译');continue;}
  if(spec.until<=now){update('expired','已到期；不自动撤销已接受命令');continue;}
  if('fleetId' in spec){
   const linked=operations.filter(p=>p.intentBindings?.some(b=>b.id===t.id&&b.version===t.version)),f=o.view.fleets.find(f=>f.id===spec.fleetId);
   if(fleetIntentCompleted(o,spec,linked)){update('completed','已确认返航生效，兵力减半（向下取整）');continue;}
   if(linked.some(p=>p.status==='failed')){update('blocked','操作被明确拒绝，需修改或取消该任务；不重复提交');continue;}
   if(linked.some(p=>p.status==='review')){update('blocked','操作结果未确认或被拒绝，先查账或更新任务，不重复切换');continue;}
   if(linked.some(p=>['proposed','accepted','underway'].includes(p.status))){update('running','已有舰队操作，等待实际生效，不重复提交');continue;}
   if(!f||f.owner!==o.view.player){update('blocked','无法确认当前己方舰队；不凭消失判断完成');continue;}
   if(spec.kind==='return-fleet'&&f.canReturn!==true){update('blocked','舰队已返航或无返航资格');continue;}
   update('pending','等待执行一次性舰队操作');continue;
  }
  const p=o.view.outposts.find(p=>p.id===spec.target);
  if(!p||p.destroyed){update('cancelled','目标已不存在或已摧毁，结束该任务');continue;}
  if(spec.kind==='avoid'){update('running','禁止向目标新增派兵；在途舰队不自动撤回');continue;}
  if(spec.kind==='focus'){update('running','限定单线进攻；等待集结交付及其他禁攻、安全检查');continue;}
  if(spec.kind==='transfer'){
   const linked=operations.filter(p=>p.intentBindings?.some(b=>b.id===t.id&&b.version===t.version));
   if(linked.some(p=>p.commands?.length&&p.commands.length===p.drafts.length&&p.drafts.every(d=>d.action.kind==='launch'&&d.action.source===spec.source&&d.action.destination===spec.target)&&p.commands.every(c=>c.state==='completed'&&c.evidenceId!==undefined&&c.reason==='实际抵达结算确认交付'))){update('completed','实际抵达结算确认指定运输交付');continue;}
   if(linked.some(p=>['ended','failed','cancelled','review'].includes(p.status))){update('blocked','运输中断、失败或结果未确认；不重复出兵，等待更新任务');continue;}
   if(!o.view.outposts.some(p=>p.id===spec.target&&p.owner===o.view.player&&!p.destroyed)){update('blocked','指定接收点已失守，停止新增运输并允许安全复查');continue;}
   if(linked.length&&commanderTransportUnsafe(o,spec.target)){update('blocked','既有运输接收点出现实际来袭缺口，允许安全复查；不重复派兵');continue;}
   if(linked.some(p=>['proposed','accepted','underway','completed'].includes(p.status))){update('running','指定运输已提交，等待实际交付证据；离港不算完成');continue;}
   if(t.status!=='blocked')update('pending','等待指定来源至指定目的地的安全运输');continue;
  }
  if(spec.kind==='capture'&&p.owner===o.view.player){update('completed','授权观察确认目标已由己方控制');continue;}
  if(spec.kind==='capture'){
   const d=state.directive,agreements=d?.agreements.filter(a=>effectiveAgreement(a,now))??[];
   const forbidden=(state.intents??[]).some(other=>active(other)&&other.spec.kind==='avoid'&&'target' in other.spec&&other.spec.target===p.id&&other.spec.until>now)
    ||agreements.some(a=>a.forbiddenTargets.includes(p.id)||a.forbidAttack&&p.owner!=null&&a.players.includes(p.owner))
    ||p.owner!=null&&[...(d?.forbiddenPlayers??[]),...(d?.commanderConstraints.forbiddenPlayers??[])].includes(p.owner);
   if(forbidden){update('blocked','当前禁攻或已确认指挥官约束阻止该夺取目标');continue;}
  }
  if(spec.kind==='configure'){
   if(p.owner!==o.view.player||p.visibility!==2){update('blocked','无法确认己方目标库存');continue;}
   const met=((spec.minDrillers===null&&spec.maxDrillers===null)||p.drillers!==undefined)&&(spec.minDrillers===null||(p.drillers??0)>=spec.minDrillers)&&(spec.maxDrillers===null||(p.drillers??0)<=spec.maxDrillers);
   const outgoing=operations.filter(op=>op.intentBindings?.some(b=>b.id===t.id&&b.version===t.version)&&op.drafts.some(d=>d.action.kind==='launch'&&d.action.source===spec.target));
   if(outgoing.some(op=>['proposed','accepted','underway','review'].includes(op.status))){update('running','减兵运输尚未确认交付，离港不算完成');continue;}
   if(outgoing.some(op=>['ended','failed','cancelled'].includes(op.status))){update('blocked','减兵运输中断，不能以来源库存降低判定成功');continue;}
   if(met){update(spec.maintain?'running':'completed',spec.maintain?'目标已满足，持续保持':'授权观察确认配置已达到，关闭一次性任务');continue;}
  }
  const linked=operations.filter(p=>p.intentBindings?.some(b=>b.id===t.id&&b.version===t.version));
  if(linked.some(p=>['proposed','accepted','underway'].includes(p.status))){update('running','已有对应操作，等待实际交付与结算');continue;}
  if(linked.some(p=>p.status==='review'&&p.issues.some(s=>s.includes('没有足够实际结算证据')||s.includes('未确认'))))update('blocked','相关操作结果未确认；先查账，不重复提交');
  else if(spec.kind!=='configure'||!['pending','blocked'].includes(t.status))update('pending','等待可执行方案');
 }
}
export function intentGuidance(o:PlayerObservation,state:HybridState){
 const tasks=(state.intents??[]).filter(active).filter(t=>t.spec.until>o.view.tick+o.secondsSinceLastTick/600);
 return {targetDrillerLimits:tasks.flatMap(t=>t.spec.kind==='capture'&&t.spec.maxDrillersPerPlan!=null?[{target:t.spec.target,drillers:t.spec.maxDrillersPerPlan}]:[]),forbiddenTargets:tasks.flatMap(t=>t.spec.kind==='avoid'?[t.spec.target]:[]),objectives:tasks.flatMap((t):Objective[]=>t.spec.kind==='capture'?[{id:t.id,kind:'capture',targets:[t.spec.target],priority:t.spec.priority,reason:t.spec.reason}]:[]),reserves:tasks.flatMap(t=>t.spec.kind==='configure'&&t.spec.maintain&&t.spec.minDrillers!==null?[{source:t.spec.target,drillers:t.spec.minDrillers}]:[])};
}
/** Build bounded friendly allocations; real paths, resources and survival still
 * pass the same independent delivery forecast as ordinary internal transfers. */
export function configurationCandidates(o:PlayerObservation,routes:AttackRoutes,state:HybridState,operations:OperationState[]):BotCandidate[]{
 const v=o.view,own=v.outposts.filter(p=>p.owner===v.player&&!p.destroyed&&p.visibility===2),result:BotCandidate[]=[];
 const excluded=new Set<string>();
 for(let i=0;i<8;i++){
  const next=fleetIntentDraft(o,state,operations,excluded,'model');if(!next)break;
  excluded.add(next.task.id);
  result.push({id:`intent-return:${next.task.id}:v${next.task.version}`,kind:'fleet',objective:`return-fleet:${next.task.id}`,
   targets:[next.task.spec.kind==='return-fleet'?next.task.spec.fleetId:''],drafts:[next.draft],priority:100,reasons:['自主返航意图，按统一加权收益核验']});
 }
 const hard=state.directive?.commanderConstraints,protectedSources=new Set([...(hard?.protectedSources??[]),...(state.directive?.protectedSources??[])]);
 const reserve=(id:string)=>Math.max(0,...[...(hard?.reserves??[]),...(state.directive?.reserves??[]),...intentGuidance(o,state).reserves].filter(r=>r.source===id).map(r=>r.drillers));
 const free=(p:typeof own[number])=>protectedSources.has(p.id)?0:Math.max(0,Math.min(botGarrisonPolicy(o,p.id).spare,(p.drillers??0)-reserve(p.id)));
 for(const t of (state.intents??[]).filter(active).filter(t=>t.spec.kind==='transfer').sort((a,b)=>(b.spec as {priority:number}).priority-(a.spec as {priority:number}).priority)){
  if(t.spec.kind!=='transfer'||t.spec.until<=v.tick+o.secondsSinceLastTick/600)continue;
  const spec=t.spec,linked=operations.filter(p=>p.intentBindings?.some(b=>b.id===t.id&&b.version===t.version));
  if(linked.length)continue;
  const source=own.find(p=>p.id===spec.source),target=own.find(p=>p.id===spec.target),eta=routes.postTicks[spec.source]?.[spec.target];
  const amount=source?spec.drillers??free(source):0;
  const issues=[...(!source?['来源当前不属于己方或库存不可见']:[]),...(!target?['接收点当前不属于己方或库存不可见']:[]),...(eta==null?['授权航程未知或超出搜索窗口']:eta+1>Math.min(144,spec.until-v.tick)?[`航程${eta.toFixed(2)}世界日超过剩余执行窗口${Math.max(0,spec.until-v.tick).toFixed(2)}`]:[]),...(!amount?['来源没有安全可调兵力']:source&&amount>free(source)?[`指定${amount}兵，来源安全可调仅${free(source)}兵`]:[])];
  if(issues.length){t.status='blocked';t.reason=issues.join('；');continue;}
  const drafts=[{id:`${t.id}:v${t.version}:0`,issueTick:v.tick,action:{kind:'launch',source:spec.source,destination:spec.target,drillers:amount}}];
  if(!botDispatchPlanAllowed(o,drafts))continue;
  t.status='pending';t.reason='指定来源及目的地运输候选，待完整交付路径与安全核验';
  result.push({id:`intent-transfer:${t.id}:v${t.version}`,kind:'logistics',objective:`transfer:${t.id}`,targets:[spec.target],drafts,priority:spec.priority,reasons:[t.reason],...(t.authority==='commander'?{commanderDirected:true as const}:{})});
 }
 for(const t of (state.intents??[]).filter(active).filter(t=>t.spec.kind==='configure').sort((a,b)=>(b.spec as {priority:number}).priority-(a.spec as {priority:number}).priority)){
  if(t.spec.kind!=='configure'||t.spec.until<=v.tick+o.secondsSinceLastTick/600)continue;
  if(t.status==='running'&&!t.spec.maintain||t.reason.includes('结果未确认'))continue;
  if(operations.some(p=>p.intentBindings?.some(b=>b.id===t.id&&b.version===t.version)&&['proposed','accepted','underway'].includes(p.status)))continue;
  const spec=t.spec,target=own.find(p=>p.id===spec.target);if(!target)continue;
  const drafts:BotCandidate['drafts']=[],used=new Set<string>(),issues:string[]=[];
  const incoming=v.fleets.filter(f=>f.owner===v.player&&!f.gift&&f.destination?.kind==='outpost'&&f.destination.id===target.id);
  const pendingTroops=incoming.reduce((n,f)=>n+f.drillers,0);
  const add=(source:string,destination:string,drillers:number)=>{if(used.has(source)||drafts.length>=3)return false;used.add(source);drafts.push({id:`${t.id}:v${t.version}:${drafts.length}`,issueTick:v.tick,action:{kind:'launch',source,destination,drillers}});return true;};
  let missing=Math.max(0,(spec.minDrillers??0)-(target.drillers??0)-pendingTroops);
  const donors=own.filter(p=>p.id!==target.id&&(routes.postTicks[p.id]?.[target.id]??Infinity)+1<=Math.min(144,spec.until-v.tick)).sort((a,b)=>(routes.postTicks[a.id]?.[target.id]??Infinity)-(routes.postTicks[b.id]?.[target.id]??Infinity));
  for(const p of donors){const n=Math.min(missing,free(p));if(n>0&&add(p.id,target.id,n))missing-=n;if(!missing)break;}
  if(missing)issues.push('安全可调兵力或期限内航程不足');
  const receivers=own.filter(p=>p.id!==target.id&&(routes.postTicks[target.id]?.[p.id]??Infinity)+1<=Math.min(144,spec.until-v.tick)).sort((a,b)=>(routes.postTicks[target.id]?.[a.id]??Infinity)-(routes.postTicks[target.id]?.[b.id]??Infinity));
  if(spec.maxDrillers!==null&&(target.drillers??0)>spec.maxDrillers){const n=Math.min((target.drillers??0)-spec.maxDrillers,free(target));if(n>0&&receivers[0])add(target.id,receivers[0].id,n);else issues.push('减兵会突破来源守备或缺少友方接收点');}
  if(drafts.length&&botDispatchPlanAllowed(o,drafts)){
   t.status='pending';t.reason=issues.length?'部分配置可执行，其余：'+issues.join('；'):'已生成配置候选，待联合路径与安全核验';
   result.push({id:`intent-configure:${t.id}:v${t.version}`,kind:'logistics',objective:`configure:${t.id}`,targets:[...new Set(drafts.map(d=>String(d.action.destination)))],drafts,priority:spec.priority,reasons:['AI一次性/持续配置意图；接受命令不表示完成',...issues],...(t.authority==='commander'?{commanderDirected:true as const}:{})});
  }else{t.status=incoming.length?'running':'blocked';t.reason=incoming.length?'已有友方投入，等待实际到账后复查':issues.join('；')||'没有符合守备、期限与来源约束的调动';}
 }
 return result;
}
export function intentBindings(state:HybridState,candidate:BotCandidate){
 return (state.intents??[]).filter(t=>{
  const spec=t.spec;
  return active(t)&&(candidate.objective===`configure:${t.id}`||candidate.objective===`transfer:${t.id}`
   ||spec.kind==='return-fleet'&&candidate.drafts.some(d=>d.action.kind==='return-fleet'&&d.action.fleetId===spec.fleetId)
   ||spec.kind==='capture'&&candidate.captureTargets?.includes(spec.target));
 }).map(t=>({id:t.id,version:t.version}));
}
