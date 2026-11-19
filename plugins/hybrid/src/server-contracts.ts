import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {BotModeServices,BotReceiptServices} from '@subterfuge/bot-sdk/contracts/bot-mode';
import type {HybridState,StrategicAssessment} from './contracts.js';
import {basisOf,scopeMatches} from './contracts.js';
import {applyIntentEdits} from './intents.js';
import {hybridResult} from './round-result.js';
import {assertDiplomacyEdits,diplomacyEditScope} from './diplomacy-edit-scope.js';
import {ceasefirePlan,type CeasefireReview} from './ceasefire.js';
import type {OperationState} from './contracts.js';

/** Server contracts are facts; these records only describe our intended command. */
export function publishContractIntent(saved:HybridState,o:PlayerObservation,assessment:StrategicAssessment,conversation:string,peers:number[],commanderVersion:number,captured:PlayerObservation=o,operations:OperationState[]=[]){
  const editSource=assertDiplomacyEdits(assessment,diplomacyEditScope(o,saved.intents??[],conversation,peers));
  let action=assessment.diplomacyAction;
  if(action?.kind==='respond-agreement'&&action.response==='accept'){const id=action.agreementId;const signed=o.diplomacy!.agreements.find(a=>a.id===id&&a.status==='active'&&a.players[1]===o.view.player&&peers.length===1&&a.players[0]===peers[0]);if(signed)action=null;}
  const active=o.diplomacy!.agreements.filter(a=>a.status==='active'&&a.players.includes(o.view.player));
  if(assessment.betrayAgreements){
    if(assessment.betrayAgreements.some(id=>!active.some(a=>a.id===id)))throw Error('只能明确放弃本人仍生效的协议守约策略');
    saved.betrayAgreements=[...new Set(assessment.betrayAgreements)];
  }
  if(action){
    if(peers.length!==1)throw Error('正式协议必须在与单一对手的会话中发起或响应');
    if(action.kind==='propose-agreement'){
      if(action.peer!==peers[0]||action.peer===o.view.player)throw Error('协议对象与当前会话不一致');
      if(action.terms.kind==='ceasefire'&&action.terms.outposts.some(id=>!o.view.outposts.some(p=>p.id===id&&p.owner!==null&&p.owner!==undefined&&[o.view.player,action.peer].includes(p.owner))))throw Error('停战范围必须属于签约双方');
      if(action.terms.kind==='joint-attack'&&([o.view.player,action.peer].includes(action.terms.enemy)||!o.intel.some(p=>p.player===(action.terms as {enemy:number}).enemy&&p.active)))throw Error('共同目标必须是存活第三方');
      if(action.subsidy&&![o.view.player,action.peer].includes(action.subsidy.payer))throw Error('补贴支付方必须为签约方');
    }else{
      const proposal=o.diplomacy!.agreements.find(a=>a.id===action.agreementId);
      if(!proposal||proposal.status!=='proposed'||!proposal.players.includes(o.view.player)||!proposal.players.includes(peers[0]!))throw Error('当前会话没有该待签署协议');
      if((action.response==='withdraw'?proposal.players[0]:proposal.players[1])!==o.view.player)throw Error('无权执行该协议响应');
    }
    const terms=action.kind==='propose-agreement'?action.terms:action.response==='accept'?o.diplomacy!.agreements.find(a=>a.id===action.agreementId)!.terms:null;
    let ceasefireReview:CeasefireReview|undefined;
    if(terms?.kind==='ceasefire'){
      const plan=ceasefirePlan(o,peers[0]!,terms.outposts,saved,operations),reviewed=ceasefirePlan(captured,peers[0]!,terms.outposts,saved,operations);
      if(plan.signature!==reviewed.signature)throw Error('停战撤军损失或在途风险已变化，需依据最新事实重新评估');
      if(plan.blockers.length)throw Error('停战范围含无法安全撤回的己方舰队，需缩小范围或等待结算：'+plan.blockers.map(b=>b.reason).join('；'));
      ceasefireReview={...plan,withdrawalStatus:plan.withdrawals.length?'pending':'confirmed'};
    }
    const commander=saved.directive?.commanderConstraints;
    if(terms?.kind==='joint-attack'&&(commander?.forbiddenPlayers.includes(terms.enemy)||(saved.intents??[]).some(t=>t.authority==='commander'&&t.spec.kind==='avoid'&&t.spec.until>o.view.tick&&o.view.outposts.some(p=>p.id===(t.spec as {target:string}).target&&p.owner===terms.enemy))))throw Error('夹击承诺与已确认指挥官禁攻要求冲突，须拒绝或反提');
    if(terms?.kind==='ceasefire'&&(saved.intents??[]).some(t=>t.authority==='commander'&&['capture','focus'].includes(t.spec.kind)&&'target'in t.spec&&terms.outposts.includes(t.spec.target)&&!['completed','cancelled','expired'].includes(t.status)&&t.spec.until>o.view.tick))throw Error('停战承诺与指挥官当前攻占目标冲突，不能暗改指挥官要求');
    const sameAction=(c:NonNullable<HybridState['contractCommands']>[number])=>c.conversation===conversation&&JSON.stringify(c.action)===JSON.stringify(action);
    const acceptanceFailed=(c:NonNullable<HybridState['contractCommands']>[number])=>action.kind==='respond-agreement'&&action.response==='accept'&&o.diplomacy!.receipts.some((r,i)=>r.agreementId===action.agreementId&&r.kind==='agreement-acceptance-failed'&&r.actor===o.view.player&&o.diplomacy!.receiptCount-o.diplomacy!.receipts.length+i>=(c.receiptCursor??Infinity));
    const duplicate=(saved.contractCommands??[]).some(c=>sameAction(c)&&(['pending','unknown'].includes(c.status)||c.status==='accepted'&&action.kind==='respond-agreement'&&!acceptanceFailed(c)))
      ||action.kind==='propose-agreement'&&o.diplomacy!.agreements.some(a=>['proposed','active'].includes(a.status)&&a.players[0]===o.view.player&&a.players[1]===action.peer&&JSON.stringify(a.terms)===JSON.stringify(action.terms)&&JSON.stringify(a.subsidy)===JSON.stringify(action.subsidy));
    if(!duplicate){
      (saved.contractCommands??=[]).push({...(ceasefireReview?{ceasefireReview}:{}),receiptCursor:o.diplomacy!.receiptCount,id:'contract-'+crypto.randomUUID(),conversation,basis:basisOf(o,commanderVersion),action:structuredClone(action),status:'pending'});
    }
  }
  const edits=assessment.intentEdits;
  if(edits&&(edits.upsert.length||edits.cancel.length)){
    const source=editSource!,bounded=structuredClone(edits);
    for(const e of bounded.upsert)e.task.until=Math.min(e.task.until,source.deadline);
    applyIntentEdits(saved,bounded,'model',commanderVersion,o,{kind:'diplomacy',conversation,agreementId:source.agreementId});
  }
  saved.conversations={...saved.conversations,[conversation]:{summary:assessment.agreement.summary,internalIntent:assessment.agreement.internalIntent,archived:saved.conversations?.[conversation]?.archived??0}};
  if(saved.directive)saved.directive.agreements=saved.directive.agreements.filter(a=>a.conversation!==conversation);
}

/** Reuse the durable attempt identity; unknown outcomes never authorize resubmission. */
export function reconcileContractReceipts(saved:HybridState,lookup:BotModeServices['attemptReceipt'],requestIds?:readonly string[]):boolean{
  if(!lookup)return false;
  const before=JSON.stringify(saved.contractCommands),ids=requestIds?new Set(requestIds):undefined;
  const receipt=(kind:string,id:string)=>{const attempt=lookup(kind,id);return attempt&&(!ids||ids.has(attempt.requestId))?attempt.receipt as {result?:{status?:string;reason?:string;commandReceipt?:{status:string};protocolReceipt?:{effectCommitted?:boolean};results?:{status?:string;protocolReceipt?:{effectCommitted?:boolean}}[]}}|undefined:undefined;};
  for(const command of saved.contractCommands??[]){
    if(command.status==='unknown'){
      const row=receipt('contract-attempt',command.id);
      if(row?.result?.commandReceipt?.status==='accepted'||row?.result?.protocolReceipt?.effectCommitted||['accepted','committed'].includes(row?.result?.status??'')){command.status='accepted';command.reason='实际执行回执确认命令已提交，协议状态以服务器观察为准';}
      else if(['rejected','not-executed'].includes(row?.result?.status??'')){command.status=row?.result?.status==='not-executed'?'pending':'failed';command.reason=row?.result?.reason??row?.result?.status??'协议命令未接受';}
    }
    const review=command.ceasefireReview;
    if(command.status!=='pending'||review?.withdrawalStatus!=='unknown')continue;
    const raw=receipt('contract-withdrawal-attempt',command.id)?.result;
    if(raw?.status==='not-executed')review.withdrawalStatus='pending';
    else if(raw?.results?.length===review.withdrawals.length&&raw.results.every(r=>r.status==='accepted'||r.status==='committed'||r.protocolReceipt?.effectCommitted))review.withdrawalStatus='confirmed';
    else if(raw?.status==='rejected'||raw?.results?.some(r=>r.status==='rejected'||r.status==='not-executed')){command.status='failed';review.withdrawalStatus='failed';command.reason='撤军未全部成功，保留已发生的真实损失，未签约';}
  }
  return JSON.stringify(saved.contractCommands)!==before;
}

/** Projection is synchronous after the source receipt is durable, without a tactical round. */
export function settleHybridContractReceipts(services:BotReceiptServices){
  const stored=services.latest<HybridState>('state');if(!stored)return;
  const saved=structuredClone(stored);
  if(!reconcileContractReceipts(saved,services.attemptReceipt,services.requestIds))return;
  services.record('state',saved as unknown as Record<string,unknown>);
  if(saved.contractCommands?.some(c=>c.status==='pending'))services.wake();
}

/** Invalid queued intentions retire locally; at most one remote action is dispatched. */
export function contractCommandStep(saved:HybridState,o:PlayerObservation,services:BotModeServices,commanderVersion:number){
  if(!o.diplomacy)return null;
  reconcileContractReceipts(saved,services.attemptReceipt);
  services.record('state',saved as unknown as Record<string,unknown>);
  while(saved.contractCommands?.some(c=>['pending','unknown'].includes(c.status))){
    const result=dispatchContractCommand(saved,o,services,commanderVersion);
    if(result)return result;
  }
  return null;
}

function dispatchContractCommand(saved:HybridState,o:PlayerObservation,services:BotModeServices,commanderVersion:number){
  if(!o.diplomacy)return null;
  const command=saved.contractCommands?.find(c=>['pending','unknown'].includes(c.status));
  if(!command)return null;
  if(command.status==='unknown')return hybridResult('finish',{},'协议命令结果未知，按原命令身份查账，不重发。');
  if(!scopeMatches(command.basis,o)||command.basis.commanderVersion!==commanderVersion){command.status='failed';command.reason='协议意图房间或指挥官版本已改变，未提交';services.record('state',saved as unknown as Record<string,unknown>);return null;}
  const proposal=command.action.kind==='respond-agreement'?o.diplomacy.agreements.find(a=>a.id===(command.action as {agreementId:string}).agreementId):undefined;
  if(command.action.kind==='respond-agreement'&&(!proposal||proposal.status!=='proposed'||proposal.deadline<=o.view.tick+o.secondsSinceLastTick/600)){command.status='failed';command.reason='待响应提案已失效，未签约';services.record('state',saved as unknown as Record<string,unknown>);return null;}
  const review=command.ceasefireReview;
  const terms=command.action.kind==='propose-agreement'?command.action.terms:command.action.response==='accept'?proposal?.terms:null;
  if(terms?.kind==='ceasefire'){
    const fail=(reason:string)=>{command.status='failed';command.reason=reason;if(review)review.withdrawalStatus='failed';services.record('state',saved as unknown as Record<string,unknown>);return null;};
    if(!review)return fail('缺少停战撤军成本评估，未签约');
    if(review.withdrawalStatus==='unknown')return hybridResult('finish',{},'撤军结果待原批次回执确认，不重发、不签约。');
    const current=ceasefirePlan(o,review.peer,terms.outposts,saved,services.latest<{operations:OperationState[]}>('operations')?.operations??[]);
    if(review.withdrawalStatus==='pending'){
      if(current.signature!==review.signature||current.blockers.length)return fail('停战撤军损失或可行性已变化，需要重新协商，未签约');
      review.withdrawalStatus='unknown';services.record('state',saved as unknown as Record<string,unknown>);
      services.record('contract-withdrawal-attempt',{id:command.id,fleetIds:review.withdrawals.map(f=>f.fleetId)});
      return hybridResult('batch',{actions:review.withdrawals.map(f=>({tool:'order',arguments:{action:{kind:'return-fleet',fleetId:f.fleetId}}}))},'执行已评估的停战撤军；确认全部回执后才提交协议');
    }
    if(current.withdrawals.length||current.externalSignature!==review.externalSignature)return fail('撤军后停战范围或对方在途风险已变化，未盲目签约');
  }
  command.status='unknown';
  services.record('state',saved as unknown as Record<string,unknown>);
  services.record('contract-attempt',{id:command.id,action:command.action});
  return hybridResult('order',{action:command.action},'提交正式外交协议操作，以服务器签署和结算回执为准');
}
