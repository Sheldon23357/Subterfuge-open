import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {Agreement,DiplomacyMessage,HybridState,IntentEdits,StrategicAssessment} from './contracts.js';
import {applyIntentEdits} from './intents.js';
import {effectiveAgreement} from './agreement-active.js';
import {ceasefirePlan} from './ceasefire.js';
/** Resolve an omitted ceasefire deadline once, before staging or publishing it. */
export function defaultNonAggressionDeadline(next:StrategicAssessment['agreement'],current:Agreement|undefined,now:number):StrategicAssessment['agreement']{
 if(next.expiresWorldDay!==null||!['proposed','negotiating','confirmed'].includes(next.status)||!next.forbidAttack&&!next.forbiddenTargets.length)return next;
 const targets=(ids:string[])=>JSON.stringify([...new Set(ids)].sort());
 const continuing=current&&effectiveAgreement(current,now)&&current.forbidAttack===next.forbidAttack&&targets(current.forbiddenTargets)===targets(next.forbiddenTargets);
 return {...next,expiresWorldDay:continuing&&current.expiresWorldDay!==null?current.expiresWorldDay:now+100};
}
/** A published, still-effective confirmation is evidence for unchanged terms, even after raw chat is compacted. */
export function isConfirmedContinuation(current:Agreement|undefined,next:Pick<Agreement,'forbidAttack'|'forbiddenTargets'|'expiresWorldDay'|'jointAttack'>,now:number){
 const targets=(ids:string[])=>JSON.stringify([...new Set(ids)].sort());
 return !!current&&current.status==='confirmed'&&effectiveAgreement(current,now)&&current.forbidAttack===next.forbidAttack&&targets(current.forbiddenTargets)===targets(next.forbiddenTargets)&&current.expiresWorldDay===next.expiresWorldDay&&(current.jointAttack?.enemy??null)===(next.jointAttack?.enemy??null)&&(current.jointAttack?.until??null)===(next.jointAttack?.until??null);
}
export function updatedAgreement(current:Agreement|undefined,next:Agreement,now:number){
 if(current?.status==='confirmed'&&effectiveAgreement(current,now)&&(['none','proposed','negotiating'].includes(next.status)||next.fulfillment==='message'&&next.status==='confirmed'))return current;
 return next;
}
/** Chat receipts and intent activation share one durable state publication. No prose interpretation. */
export function settleDiplomacyMessage(state:HybridState,id:string,status:DiplomacyMessage['status'],o:PlayerObservation){
 const m=state.messages.find(m=>m.id===id),d=state.directive;if(!m||!d)return;
 if(m.status==='accepted'&&m.fulfillment&&m.fulfillment.state!=='staged')return;
 m.status=status;
 if(o.diplomacy){m.fulfillment={state:'none',taskIds:[],reason:'发言回执不产生服务器协议或军事履约事实'};return;}
 if(status==='unknown'||status==='pending')return;
 if(status==='failed'){
  const current=d.agreements.find(a=>a.conversation===m.conversation);
  if(current?.status==='proposed'&&current.tick===m.agreement.tick&&current.summary===m.agreement.summary)d.agreements=d.agreements.filter(a=>a.conversation!==m.conversation).concat(m.previousAgreement?[m.previousAgreement]:[]);
  m.fulfillment={state:'none',taskIds:[],reason:'消息未发送成功，未启用履约任务'};d.version++;return;
 }
 const current=d.agreements.find(a=>a.conversation===m.conversation);
 if(current&&current.tick>m.agreement.tick){m.fulfillment={state:'none',taskIds:[],reason:'较早发言已查明；当前协议已更新，保留当前执行要求'};return;}
 const now=o.view.tick+o.secondsSinceLastTick/600;
 d.agreements=d.agreements.filter(a=>a.conversation!==m.conversation).concat(updatedAgreement(current,m.agreement,now));
 d.objectives=d.objectives.filter(g=>!g.id.startsWith('diplomacy:'+m.conversation+':'));
 const edits=structuredClone(m.intentEdits??{upsert:[],cancel:[]}) as IntentEdits;
 if(m.agreement.fulfillment==='tasks'&&m.agreement.status!=='confirmed'){
  m.fulfillment={state:'staged',taskIds:[],reason:'提案已发送，军事任务等待双方确认'};d.version++;return;
 }
 if(edits.upsert.length||edits.cancel.length){
  if(m.basis.commanderVersion!==state.commanderVersion)m.fulfillment={state:'blocked',taskIds:[],reason:'确认指令已更新，需按当前要求重新安排履约'};
  else if(!effectiveAgreement(m.agreement,now)&&m.agreement.status!=='none')m.fulfillment={state:'none',taskIds:[],reason:'发送回执返回时协议已失效，未启用过期任务'};
  else{
   for(const edit of edits.upsert){edit.task.until=Math.min(edit.task.until,m.agreement.expiresWorldDay??Infinity);}
   const prior=new Map((state.intents??[]).map(t=>[t.id,t.version]));
   try{
    applyIntentEdits(state,edits,'model',state.commanderVersion,o,m.agreement.fulfillment!=='deception'?{kind:'diplomacy',conversation:m.conversation}:undefined);
    m.fulfillment={state:'active',taskIds:(state.intents??[]).filter(t=>prior.get(t.id)!==t.version||t.origin?.conversation===m.conversation&&!['completed','cancelled','expired'].includes(t.status)).map(t=>t.id),reason:'消息已确认发送，任务已进入统一执行队列'};
    for(const previous of state.messages)if(previous.id!==m.id&&previous.conversation===m.conversation&&previous.fulfillment?.state==='staged')previous.fulfillment={state:'none',taskIds:[],reason:'任务已由后续确认消息承接'};
   }catch(error){m.fulfillment={state:'blocked',taskIds:[],reason:error instanceof Error?error.message:'履约任务校验未通过'};}
  }
 }else if(m.agreement.fulfillment==='tasks'){
  const ids=(state.intents??[]).filter(t=>t.origin?.conversation===m.conversation&&!['completed','cancelled','expired'].includes(t.status)).map(t=>t.id);
  m.fulfillment={state:ids.length?'active':'blocked',taskIds:ids,reason:ids.length?'沿用当前会话已启用的履约任务':'发送确认后未找到有效的同会话履约任务，需要修复'};
 }else m.fulfillment={state:m.agreement.fulfillment==='rules'?'active':'none',taskIds:[],reason:m.agreement.fulfillment==='deception'?'假意接受；程序只执行显式真实指令':m.agreement.fulfillment==='message'?'仅外交发言，无额外军事任务':m.agreement.jointAttack?'联合进攻由程序按有效协议展开目标':'实际执行约束按结构化协议处理'};
 d.version++;
}

/** Deadlines and participant elimination are facts, not another model review. */
export function reconcileDiplomacy(state:HybridState,o:PlayerObservation){
 if(o.diplomacy){
  const before=JSON.stringify(state);
  if(state.directive)state.directive.agreements=[];
  for(const t of state.intents??[]){
    if(!t.origin?.agreementId||['completed','cancelled','expired'].includes(t.status))continue;
    const source=o.diplomacy.agreements.find(a=>a.id===t.origin!.agreementId);
    if(!source||source.status!=='active'||source.deadline<=o.view.tick+o.secondsSinceLastTick/600||(source.terms.kind==='joint-attack'&&source.fulfilled[source.players.indexOf(o.view.player)])){
      t.status='cancelled';t.updatedAt=o.view.tick+o.secondsSinceLastTick/600;t.reason='来源服务器协议义务已结束，停止新增履约；在途命令继续追踪';
    }
  }
  if(state.betrayAgreements)state.betrayAgreements=state.betrayAgreements.filter(id=>o.diplomacy!.agreements.some(a=>a.id===id&&a.status==='active'));
  const now=o.view.tick+o.secondsSinceLastTick/600;
  state.ceasefireRisks=[];
  for(const a of o.diplomacy.agreements.filter(a=>a.status==='active'&&a.terms.kind==='ceasefire'&&a.deadline>now&&a.players.includes(o.view.player)&&!state.betrayAgreements?.includes(a.id))){
   const peer=a.players.find(p=>p!==o.view.player)!;
   const plan=ceasefirePlan(o,peer,a.terms.kind==='ceasefire'?a.terms.outposts:[],state);
   for(const f of plan.withdrawals){
    const blockers=plan.blockers.filter(b=>b.fleetId===f.fleetId);
    if(blockers.length){state.ceasefireRisks.push({agreementId:a.id,fleetId:f.fleetId,reason:blockers.map(b=>b.reason).join('；')});continue;}
    if(state.intents?.some(t=>t.origin?.agreementId===a.id&&t.spec.kind==='return-fleet'&&t.spec.fleetId===f.fleetId))continue;
    try{applyIntentEdits(state,{upsert:[{id:null,task:{kind:'return-fleet',fleetId:f.fleetId,until:a.deadline,reason:`停战生效，撤回攻击覆盖据点的舰队；当前返航损失${f.lostDrillers}兵`}}],cancel:[]},'model',state.commanderVersion,o,{kind:'diplomacy',conversation:String(peer),agreementId:a.id});}
    catch(error){state.ceasefireRisks.push({agreementId:a.id,fleetId:f.fleetId,reason:error instanceof Error?error.message:'停战撤军受阻'});}
   }
  }
  return before!==JSON.stringify(state);
 }
 const d=state.directive;if(!d)return false;const before=JSON.stringify(state),now=o.view.tick+o.secondsSinceLastTick/600;
 for(const a of d.agreements){
  if(['proposed','negotiating','confirmed'].includes(a.status)&&!effectiveAgreement(a,now))a.status='expired';
  if(['proposed','negotiating','confirmed'].includes(a.status)&&a.players.length&&a.players.every(p=>o.intel.find(i=>i.player===p)?.active===false))a.status='terminated';
  if(a.jointAttack&&(a.jointAttack.until<=now||o.intel.find(i=>i.player===a.jointAttack!.enemy)?.active===false))a.jointAttack=null;
  if(!effectiveAgreement(a,now)){
   a.forbidAttack=false;a.forbiddenTargets=[];a.jointAttack=null;
   d.objectives=d.objectives.filter(g=>!g.id.startsWith('diplomacy:'+a.conversation+':'));
  }
 }
 for(const t of state.intents??[])if(t.origin&&!['completed','cancelled','expired'].includes(t.status)){
  const a=d.agreements.find(a=>a.conversation===t.origin!.conversation);
  if(!a||!effectiveAgreement(a,now)){t.status='cancelled';t.updatedAt=now;t.reason='来源协议已结束，停止新增履约操作；在途行动继续按真实结算追踪';}
 }
 for(const m of state.messages)if(m.fulfillment?.state==='blocked'&&!d.agreements.some(a=>a.conversation===m.conversation&&effectiveAgreement(a,now)))m.fulfillment={state:'none',taskIds:[],reason:'来源协议已结束，退出履约修复队列'};
 for(const m of state.messages)if(m.status==='accepted'&&m.fulfillment?.state==='staged'&&!effectiveAgreement(m.agreement,now))m.fulfillment={state:'none',taskIds:[],reason:'提案未在有效窗口内确认，释放暂存任务'};
 for(const m of state.messages)if(m.status==='pending'&&m.agreement.expiresWorldDay!==null&&m.agreement.expiresWorldDay<=now){m.status='failed';m.fulfillment={state:'none',taskIds:[],reason:'协议发送前已到期'};}
 if(before===JSON.stringify(state))return false;d.version++;return true;
}
