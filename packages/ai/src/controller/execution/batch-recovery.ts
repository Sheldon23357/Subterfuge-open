import type {WriteResolution} from './write-reconciliation.js';
type Row=Record<string,unknown>;
const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
export interface BatchChildEvidence {id:string;intentRecorded:boolean;evidence:{kind:string;result?:unknown}}
/** Called only after the live batch executor has stopped. A child intent is
 * durable before transmission; missing intent therefore means never started.
 * An intent without a terminal receipt remains unknown, never rejected. */
export function recoverBatchOutcome(id:string,args:unknown,children:readonly BatchChildEvidence[],resolutions:readonly WriteResolution[]){
 if(!row(args)||!Array.isArray(args.actions)||!args.actions.length||args.actions.length>8)throw Error('Invalid durable batch request');
 const results=args.actions.map((action,index)=>{
  if(!row(action)||action.tool!=='order')throw Error('Invalid durable batch child');
  const childId=`${id}-item-${index}`,source=children.find(c=>c.id===childId),base={id:childId,index,tool:String(action.tool)};
  if(!source)throw Error('Missing batch evidence coverage');
  if(!source.intentRecorded){
   if(source.evidence.kind!=='no-durable-outcome')throw Error('Batch child outcome has no durable intent');
   return {...base,status:'not-executed',reason:'程序未启动此子项'};
  }
  const resolved=resolutions.find(r=>r.id===childId&&r.tool===action.tool&&r.status!=='unknown');
  if(resolved)return {...base,status:resolved.status==='committed'?'accepted':resolved.status,reason:resolved.reason,...(resolved.protocolReceipt?{protocolReceipt:resolved.protocolReceipt,protocolReceiptPlayer:resolved.protocolReceiptPlayer}:{}),reconciled:{reference:`write-reconciled:${childId}`}};
  const result=source.evidence.result;
  if(source.evidence.kind==='batch-item-result'&&row(result)&&['accepted','rejected','not-executed'].includes(String(result.status)))return {...result,...base,status:String(result.status)};
  return {...base,status:'unknown',reason:'子项已启动但没有确定结果',...(result!==undefined?{evidence:result}:{})};
 });
 const complete=results.every(r=>r.status==='accepted'),unknown=results.some(r=>r.status==='unknown');
 return {status:unknown?'unknown':complete?'accepted':'partial',complete,requested:results.length,processed:children.filter(c=>c.intentRecorded).length,results,recovered:true};
}
