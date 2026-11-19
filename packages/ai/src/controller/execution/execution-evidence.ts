import {createHash} from 'node:crypto';
import type {ReceiptObservationState} from './receipt-observation.js';
export interface ExecutionEvidenceReference {id:string;digest:string}
/** Only undelivered system conclusions cross round boundaries. Their original
 * transport evidence remains in the journal; this is not archived query recall. */
export function pendingExecutionEvidence(state:ReceiptObservationState){
 const notices=[
  ...(state.resolutions??[]).filter(r=>r.status!=='unknown').map(r=>({id:`write:${r.id}`,tool:r.tool,result:{id:r.id,status:r.status,reason:r.reason,...(r.protocolReceipt?{effects:r.protocolReceipt.effects,receiptState:r.protocolReceipt.state}:{}),...(r.message?{message:r.message}:{}),meaning:'程序核实原请求；提交效果不表示舰队抵达或获胜'}})),
  ...(state.recoveredBatches??[]).map(r=>({id:`batch:${r.id}`,tool:'batch',result:r.result})),
 ];
 const entries=notices.map(notice=>({notice,reference:{id:notice.id,digest:createHash('sha256').update(JSON.stringify(notice)).digest('hex')}})).filter(entry=>state.providedEvidence?.[entry.reference.id]!==entry.reference.digest);
 return {notices:entries.map(entry=>entry.notice),references:entries.map(entry=>entry.reference)};
}
