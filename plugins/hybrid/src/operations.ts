import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {StrategicDirective,OperationState,OperationCommand} from './contracts.js';
import {serverOrderId} from '@subterfuge/bot-sdk/execution/receipt-observation';
import {scopeMatches} from './contracts.js';
import {intentGuidance,fleetIntentCompleted} from './intents.js';
import type {HybridState} from './contracts.js';
import {currentObjectives} from './strategy-freshness.js';
import {effectiveAgreement} from './agreement-active.js';
import {jointAttackGuidance} from './joint-attack.js';
import {ceasefireAvoidTargets} from './ceasefire.js';
import {commanderFocusGuidance} from './commander-commitments.js';
export function constraints(d:StrategicDirective|null,o?:PlayerObservation,state?:HybridState){const intent=o&&state?intentGuidance(o,state):{targetDrillerLimits:[],forbiddenTargets:[],reserves:[]},now=o?o.view.tick+o.secondsSinceLastTick/600:0,agreements=o?.diplomacy?[]:[...(d?.agreements??[]),...(state?.messages.filter(m=>['pending','unknown'].includes(m.status)).map(m=>m.agreement)??[])].filter(a=>effectiveAgreement(a,now));return {contractAvoidTargets:o?ceasefireAvoidTargets(o,state):[],...(o&&state?commanderFocusGuidance(o,state):{}),targetDrillerLimits:intent.targetDrillerLimits,forbiddenTargets:[...intent.forbiddenTargets,...new Set(agreements.flatMap(a=>a.forbiddenTargets))],forbiddenPlayers:[...new Set([...(d?.forbiddenPlayers??[]),...(d?.commanderConstraints.forbiddenPlayers??[]),...(agreements.filter(a=>a.forbidAttack).flatMap(a=>a.players))])],protectedSources:[...new Set([...(d?.protectedSources??[]),...(d?.commanderConstraints.protectedSources??[])])],reserves:[...(d?.reserves??[]),...(d?.commanderConstraints.reserves??[]),...intent.reserves].reduce<{source:string;drillers:number}[]>((all,r)=>{const old=all.find(x=>x.source===r.source);if(old)old.drillers=Math.max(old.drillers,r.drillers);else all.push({...r});return all;},[])};}
export function operationGuidance(o:PlayerObservation,d:StrategicDirective|null,operations:OperationState[],rotation:number,state?:HybridState){
 const hard=constraints(d,o,state);
 const joint=jointAttackGuidance(o,d,state?.betrayAgreements??[]);
 const contracts=o.diplomacy?.agreements.filter(a=>a.status==='active'&&a.deadline>o.view.tick+o.secondsSinceLastTick/600&&a.players.includes(o.view.player)&&!state?.betrayAgreements?.includes(a.id))??[];
 const contractAvoidTargets=[...new Set([...hard.contractAvoidTargets,...contracts.flatMap(a=>a.terms.kind==='ceasefire'?a.terms.outposts.filter(id=>o.view.outposts.some(p=>p.id===id&&p.owner!==o.view.player&&p.owner!==null&&p.owner!==undefined&&a.players.includes(p.owner))):[])])];
 return d||state?.intents?.length||contracts.length?{...hard,contractAvoidTargets,attackDefenseFactors:joint.attackDefenseFactors,objectives:currentObjectives(o,[...(d?.objectives??[]),...(state?intentGuidance(o,state).objectives:[]),...joint.objectives]),rotation}:undefined;
}
const terminal=new Set(['completed','ended','cancelled','failed']);
const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Each child keeps its own authoritative receipt. A failed sibling never inherits acceptance. */
export function acceptOperationReceipt(p:OperationState,raw:unknown,o:PlayerObservation):boolean{
 if(!record(raw)||raw.tool!=='batch'||typeof raw.id!=='string'||!record(raw.result)||!Array.isArray(raw.result.results))return false;
 if(raw.result.results.some((item:unknown)=>!record(item)))return false;
 const items=raw.result.results as Record<string,any>[];
 if(p.phase==='internal'&&items.some((item,i)=>item.index!==i))return false;
 if(items.some(item=>!Number.isInteger(item.index)||item.index<0||item.index>=p.drafts.length)||new Set(items.map(item=>item.index)).size!==items.length)return false;
 const commands=p.commands??=[];
 for(const item of items){
  const draft=p.drafts[item.index]!,receipt=record(item.protocolReceipt)?item.protocolReceipt:undefined,effects=record(receipt?.effects)?receipt!.effects:{};
  const old=commands.find(c=>c.draftId===draft.id);if(old&&terminal.has(old.state))continue;
  const accepted=item.status==='accepted'||item.status==='committed';
  const command:OperationCommand={draftId:draft.id,requestId:String(item.id??raw.id+'-'+item.index),state:accepted?'accepted':item.status==='rejected'||item.status==='not-executed'?'failed':'unknown',...(accepted?{}:{reason:typeof item.code==='string'?item.code:item.status==='not-executed'?'未执行':'命令结果尚未确认'})};
  if(accepted){
   const order=typeof effects.orderId==='string'?effects.orderId:serverOrderId(command.requestId,o.view.player);
   command.orderId=order;if(!p.orders.includes(order))p.orders.push(order);
   if(draft.action.kind==='launch'){command.fleetId=typeof draft.action.fleetId==='string'?draft.action.fleetId:order;if(!p.fleets.includes(command.fleetId))p.fleets.push(command.fleetId);}
  }
  if(old)commands.splice(commands.indexOf(old),1,command);else commands.push(command);
 }
 for(const draft of p.drafts)if(!commands.some(c=>c.draftId===draft.id))commands.push({draftId:draft.id,requestId:raw.id,state:'unknown',reason:'该操作缺少对应回执'});
 p.receiptIds=[...new Set([...(p.receiptIds??[]),raw.id])];
 p.status=commands.length===p.drafts.length&&commands.every(c=>c.state==='accepted')?'accepted':'review';
 return true;
}
export function reconcileOperations(operations:OperationState[],o:PlayerObservation,receipt?:(id:string)=>unknown):OperationState[]{
 const events=new Map<string,NonNullable<PlayerObservation['activity']>>();
 for(const e of o.activity??[]){const list=events.get(e.subject)??[];list.push(e);events.set(e.subject,list);}
 return operations.map(saved=>{
  const p=structuredClone(saved);if(!scopeMatches(p.basis,o))throw Error('Operation scope mismatch');
  if(terminal.has(p.status))return p;
  if(receipt&&(!p.commands?.length||p.commands.some(c=>c.state==='unknown')))for(const id of p.receiptIds??[])acceptOperationReceipt(p,receipt(id),o);
  if(p.commands?.length){
   for(const c of p.commands){
    if(terminal.has(c.state))continue;
    const draft=p.drafts.find(d=>d.id===c.draftId);if(!draft)continue;
    if(c.state==='unknown')continue;
    const fleet=o.view.fleets.find(f=>f.id===c.fleetId),actual=(events.get(c.fleetId??'')??[]).filter(e=>e.tick>=p.basis.tick);
    if(draft.action.kind!=='launch'){c.state='completed';c.reason='实际回执确认操作已生效';continue;}
    const ended=actual.find(e=>e.arrival||e.termination||['fleet-recalled','launch-cancelled'].includes(e.kind));
    if(ended){
     c.evidenceId=ended.id;
     c.state=['fleet-recalled','launch-cancelled'].includes(ended.kind)?'cancelled':ended.arrival?.outcome==='delivered'?'completed':'ended';
     c.settlement=ended.arrival?.outcome??ended.termination?.outcome??(ended.kind==='fleet-recalled'?'recalled':'cancelled');
     c.reason=ended.arrival?.outcome==='delivered'?'实际抵达结算确认交付':ended.kind==='fleet-recalled'?'实际回执确认已返航，原运输结束':ended.kind==='launch-cancelled'?'实际取消出航':'实际结算确认运输结束';continue;
    }
    if(fleet){c.state=fleet.owner!==o.view.player?'failed':fleet.state==='waiting'?'accepted':'underway';c.reason=fleet.owner!==o.view.player?'授权观察确认舰队已失去己方控制':fleet.state==='waiting'?'出航准备中':'舰队在途';}
    else{c.state='accepted';c.reason='运输结算证据待补齐；不凭消失判定完成';}
   }
   const all=p.commands.length===p.drafts.length&&p.commands.every(c=>terminal.has(c.state));
   if(all){p.status=p.commands.some(c=>c.state==='failed')?'failed':p.commands.every(c=>c.state==='completed')?'completed':p.commands.every(c=>c.state==='cancelled')?'cancelled':'ended';p.finishedAt=o.view.tick;p.issues=p.status==='completed'?[]:[...new Set(p.commands.filter(c=>c.state!=='completed').map(c=>c.reason??c.state))];}
   else{p.status=p.commands.some(c=>c.state==='unknown')?'review':p.commands.some(c=>c.state==='underway')?'underway':'accepted';p.issues=[...new Set(p.commands.filter(c=>c.state==='unknown'||c.state==='failed'||c.reason?.includes('证据待补齐')).map(c=>c.reason??'操作结果未确认'))];}
   return p;
  }
  // Original accepted records remain useful evidence even if their old journal receipt is unavailable.
  if(p.phase==='fleet-intent'&&p.drafts.length&&p.drafts.every(({action})=>action.kind==='return-fleet'&&typeof action.fleetId==='string'&&fleetIntentCompleted(o,{kind:'return-fleet',fleetId:action.fleetId,until:Infinity,reason:''},[p]))){p.status='completed';p.issues=[];p.finishedAt=o.view.tick;return p;}
  const linked=o.view.fleets.filter(f=>p.orders.includes(f.id)||p.fleets.includes(f.id)||p.drafts.some(d=>d.action.kind==='launch'&&d.action.fleetId===f.id));for(const f of linked)if(!p.fleets.includes(f.id))p.fleets.push(f.id);
  if(linked.some(f=>f.owner===o.view.player)){p.status=linked.some(f=>f.owner===o.view.player&&f.state!=='waiting')?'underway':'accepted';p.issues=[];return p;}
  const relevant=[...new Set([...p.orders,...p.fleets])].flatMap(id=>events.get(id)??[]);
  if(relevant.some(e=>e.arrival?.outcome==='defeated'||e.termination?.outcome==='removed'||e.kind==='fleet-recalled')){p.status='ended';p.finishedAt=o.view.tick;p.issues=['实际结算确认运输结束，释放内部承诺并复查目标；不代表成功交付'];return p;}
  const moves=p.drafts.filter(d=>d.action.kind==='launch');
  const accepted=p.orders.length>=p.drafts.length&&!!p.receiptIds?.length;
  if(accepted&&!moves.length||moves.length&&p.orders.length>=p.drafts.length&&p.orders.every(id=>relevant.some(e=>e.subject===id&&(e.arrival?.outcome==='delivered'||e.termination?.outcome==='recovered')))){p.status='completed';p.finishedAt=o.view.tick;p.issues=[];}
  else if(p.status==='proposed'&&o.view.tick>p.basis.tick){p.status='review';p.issues=['操作提交结果待核实'];}
  else if(!linked.length)p.issues=['没有足够实际结算证据；不因舰队消失判定完成'];
  return p;
 });
}
/** Background observations can finish commands during foreground awaits. Settled evidence is monotonic. */
export function mergeOperationProgress(incoming:OperationState[],current:OperationState[]){
 const merged=new Map(current.map(p=>[p.id,structuredClone(p)]));
 for(const p of incoming){
  const old=merged.get(p.id);
  if(!old){merged.set(p.id,structuredClone(p));continue;}
  if(terminal.has(old.status))continue;
  if(terminal.has(p.status)){merged.set(p.id,structuredClone(p));continue;}
  const next=structuredClone(p);
  for(const command of old.commands??[]){
   const at=next.commands?.findIndex(c=>c.draftId===command.draftId)??-1;
   if(at<0)(next.commands??=[]).push(structuredClone(command));
   else if(terminal.has(command.state))next.commands![at]=structuredClone(command);
  }
  next.receiptIds=[...new Set([...(old.receiptIds??[]),...(p.receiptIds??[])])];
  next.orders=[...new Set([...old.orders,...p.orders])];next.fleets=[...new Set([...old.fleets,...p.fleets])];
  merged.set(p.id,next);
 }
 return [...merged.values()];
}
/** Replay only missed authorized activity, with a durable cut and bounded pages per pass. */
export async function operationActivity(operations:OperationState[],o:PlayerObservation,after:number,read:(after:number,through:number)=>Promise<unknown>,receipt?:(id:string)=>unknown){
 const through=o.activityCursor;if(through===undefined)return {operations:reconcileOperations(operations,o,receipt),cursor:after};
 let cursor=after,result=operations;
 if(!Number.isSafeInteger(cursor)||cursor<0||cursor>through)throw Error('Invalid hybrid activity cut');
 for(let page=0;cursor<through&&page<8;page++){
  const raw=await read(cursor,through);if(!record(raw)||!Array.isArray(raw.events)||!raw.events.length||raw.through!==through||raw.nextCursor!==cursor+raw.events.length||raw.nextCursor>through||raw.events.some((e:any,i:number)=>e.id!==cursor+i))throw Error('Incomplete hybrid activity evidence');
  result=reconcileOperations(result,{...o,activity:raw.events},receipt);cursor=raw.nextCursor;
 }
 return {operations:reconcileOperations(result,o,receipt),cursor};
}
