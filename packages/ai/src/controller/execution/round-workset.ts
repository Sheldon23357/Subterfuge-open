import {createHash} from 'node:crypto';
import type {AiSnapshot,DecisionTask} from '../contracts/types.js';
import type {ReceiptObservationState} from './receipt-observation.js';
import {toolMetadata} from '../contracts/tool-metadata.js';

export interface RoundWorkset {
 version:1;id:string;roomId:string;player:number;causes:unknown[];
 receipts:Record<string,unknown>[];digest:string;
}
export interface RoundMaterialChange {roundId:string;action:'release'|'replace';removed:string[];replacementId?:string}
/** An unfinished round still needs exact acceptance evidence for these writes.
 * Settled receipts carry their own result and need no observer retention. */
export function unresolvedRoundCommands(workset:RoundWorkset|null):Set<string>{
 const ids=new Set<string>();
 const add=(receipt:Record<string,unknown>)=>{
  const result=receipt.result as Record<string,unknown>|undefined;
  if(typeof receipt.id==='string'&&toolMetadata(String(receipt.tool))?.commit==='remote'
    &&(receipt.kind==='tool-intent'||receipt.kind==='tool-unknown'||['unknown','pending'].includes(String(result?.status??receipt.status))))ids.add(receipt.id);
  if(receipt.tool==='batch'&&Array.isArray(result?.results))for(const child of result.results){
   if(child&&typeof child==='object')add(child as Record<string,unknown>);
  }
 };
 for(const receipt of workset?.receipts??[])add(receipt);
 return ids;
}
export function roundMaterialSummary(raw:unknown,observation:AiSnapshot['observation']|null){
 if(raw==null)return {status:'none' as const};
 const workset=observation?restoreRoundWorkset(raw,observation):null;
 if(!workset)return {status:'unavailable' as const};
 const entries=workset.receipts.map(r=>({id:String(r.id),tool:String(r.tool),releasable:false,characters:JSON.stringify(r).length}));
 return {status:'active' as const,id:workset.id,entries,characters:entries.reduce((n,r)=>n+r.characters,0),reads:entries.filter(r=>r.releasable).length,protected:entries.filter(r=>!r.releasable).length};
}
const hash=(value:Omit<RoundWorkset,'digest'>)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const seal=(value:Omit<RoundWorkset,'digest'>):RoundWorkset=>({...value,digest:hash(value)});
/** Restore only a complete, integrity-checked record belonging to this player.
 * This is a round checkpoint, never a query into historical tool archives. */
export function restoreRoundWorkset(raw:unknown,observation:AiSnapshot['observation']):RoundWorkset|null{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const r=raw as RoundWorkset;
 if(r.version!==1||typeof r.id!=='string'||!r.id||r.roomId!==observation.roomId||r.player!==observation.view.player||!Array.isArray(r.causes)||!Array.isArray(r.receipts)||typeof r.digest!=='string')return null;
 if(r.receipts.some(x=>!x||typeof x!=='object'||typeof x.id!=='string'||typeof x.tool!=='string'||!Object.hasOwn(x,'result')))return null;
 const {digest,...body}=r;
 return digest===hash(body)?structuredClone(r):null;
}
export function createRoundWorkset(id:string,observation:AiSnapshot['observation'],task:DecisionTask):RoundWorkset{
 return seal({version:1,id,roomId:observation.roomId,player:observation.view.player,causes:structuredClone(task.triggers??task.reasons),receipts:[]});
}
export function addRoundCauses(current:RoundWorkset,task:DecisionTask):RoundWorkset{
 const {digest,...body}=current,causes=[...body.causes],seen=new Set(causes.map(c=>JSON.stringify(c)));
 for(const cause of task.triggers??task.reasons)if(!seen.has(JSON.stringify(cause))){causes.push(structuredClone(cause));seen.add(JSON.stringify(cause));}
 return seal({...body,causes});
}
/** Receipt and checkpoint must be saved in the same database transaction.
 * Identical IDs are idempotent; changed content under an accepted ID is a bug.
 * Distinct alternatives and failed/unknown writes are never silently evicted. */
export function appendRoundReceipt(current:RoundWorkset,receipt:Record<string,unknown>):RoundWorkset{
 if(typeof receipt.id!=='string'||typeof receipt.tool!=='string'||!Object.hasOwn(receipt,'result'))throw Error('Invalid round receipt');
 const copy=JSON.parse(JSON.stringify(receipt)) as Record<string,unknown>;
 const prior=current.receipts.find(r=>r.id===copy.id);
 if(prior){
  if(JSON.stringify(prior)===JSON.stringify(copy))return current;
  if(prior.kind==='tool-intent'&&prior.tool===copy.tool&&['tool-result','tool-rejected','tool-unknown'].includes(String(copy.kind))){
   const {digest,...body}=current;
   return seal({...body,receipts:body.receipts.map(r=>r.id===copy.id?copy:r)});
  }
  throw Error('Round receipt identity conflict');
 }
 const {digest,...body}=current;
 return seal({...body,receipts:[...body.receipts,copy]});
}

/** A system-reconstructed batch replaces only its interrupted parent. The
 * original child journals remain the evidence; no child is dispatched here. */
export function recoverRoundBatch(current:RoundWorkset,id:string,result:ReturnType<typeof import('./batch-recovery.js').recoverBatchOutcome>):RoundWorkset{
 const prior=current.receipts.find(r=>r.id===id);
 if(!prior||prior.tool!=='batch')return current;
 const old=prior.result as {status?:unknown;recovered?:unknown}|null;
 if(prior.kind!=='tool-intent'&&prior.kind!=='tool-unknown'&&old?.status!=='unknown'&&old?.recovered!==true)return current;
 if(JSON.stringify(old)===JSON.stringify(result))return current;
 const {digest,...body}=current;
 return seal({...body,receipts:body.receipts.map(r=>r.id===id?{...r,kind:result.status==='unknown'?'tool-unknown':'tool-result',result}:r)});
}

/** Only the program's exact-ID acceptance ledger can resolve a pending write.
 * Acceptance establishes receipt, never arrival, battle success or execution. */
export function reconcileRoundReceipts(current:RoundWorkset,ledger:ReceiptObservationState|null):RoundWorkset{
 if(!ledger||ledger.roomId!==current.roomId)return current;
 let changed=false;
 const resolution=(id:unknown,tool:unknown)=>ledger.resolutions?.find(r=>r.id===id&&r.tool===tool&&r.status!=='unknown');
 const resolvedResult=(r:NonNullable<ReceiptObservationState['resolutions']>[number])=>({status:r.status==='committed'?'accepted':r.status,accepted:r.status==='committed',reason:r.reason,...(r.protocolReceipt?{protocolReceipt:r.protocolReceipt}:{}),...(r.message?{message:r.message}:{}),reconciled:{reference:`write-reconciled:${r.id}`},execution:r.status==='committed'?'effect-committed':'not-executed',meaning:'程序核实原请求；提交效果不表示舰队抵达或获胜'});
 const acceptance=(id:unknown)=>ledger.records.find(r=>r.owner==='system'&&r.roomId===current.roomId&&r.player===current.player&&r.commandId===id&&r.predicate.kind==='command-recorded'&&r.predicate.commandId===id&&!!r.acceptedRef&&r.fact==='command-accepted'&&['acceptedKnown','confirmedFact'].includes(r.state));
 const receipts=current.receipts.map(receipt=>{
  const result=receipt.result;
  if(!result||typeof result!=='object')return receipt;
  const body=result as Record<string,unknown>;
  if(receipt.tool==='batch'&&Array.isArray(body.results)){
   let childChanged=false;
   const results=body.results.map((child:Record<string,unknown>)=>{
    if(!child||!['unknown','pending'].includes(String(child.status)))return child;
    const resolved=resolution(child.id,child.tool);
    if(resolved){childChanged=true;return {...child,...resolvedResult(resolved)};}
    if(child.tool!=='order')return child;
    const accepted=acceptance(child.id);if(!accepted)return child;
    childChanged=true;
    return {...child,status:'accepted',execution:'not-established',reconciled:{reference:accepted.acceptedRef,revision:accepted.lastRevision??null}};
   });
   if(!childChanged)return receipt;
   changed=true;
   return {...receipt,result:{...body,results,status:results.some((r:Record<string,unknown>)=>r.status==='unknown')?'unknown':'partial',complete:false}};
  }
  const resolved=resolution(receipt.id,receipt.tool);
  if(resolved&&['pending','unknown'].includes(String(body.status))){changed=true;return {...receipt,kind:resolved.status==='committed'?'tool-result':'tool-rejected',result:resolvedResult(resolved)};}
  if(receipt.tool!=='order'||!['pending','unknown'].includes(String(body.status)))return receipt;
  const accepted=acceptance(receipt.id);
  if(!accepted)return receipt;
  changed=true;
  return {...receipt,kind:'tool-result',result:{status:'accepted',accepted:true,reconciled:{reference:accepted.acceptedRef,revision:accepted.lastRevision??null},execution:'not-established',meaning:'程序确认同一命令已接受；不表示抵达、执行完毕或获胜，禁止重发'}};
 });
 if(!changed)return current;
 const {digest,...body}=current;
 return seal({...body,receipts});
}
