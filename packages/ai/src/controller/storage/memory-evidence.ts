import {toolMetadata} from '../contracts/tool-metadata.js';
/** A receipt proves its own recorded outcome, not a plan's eventual success. */
export interface MemoryEvidence {
  reference:string;
  kind:string;
  tool?:string;
  actor?:'human';
  version?:number;
  outcome:'accepted'|'rejected'|'unconfirmed'|'partial'|'read'|'applied'|'scheduled'|'cancelled'|'released';
}
const object=(v:unknown):Record<string,unknown>|undefined=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
export function receiptMemoryEvidence(reference:string,kind:string,payload:unknown):MemoryEvidence|undefined {
  const p=object(payload);if(!p||typeof p.tool!=='string'&&kind!=='batch-item-unknown')return undefined;
  const result=object(p.result),diagnostic=object(p.diagnostic),request=object(diagnostic?.request);
  const base={reference,kind,...(typeof p.tool==='string'?{tool:p.tool}:{})};
  if(kind==='batch-item-unknown'||request?.outcome==='unknown')return {...base,outcome:'unconfirmed'};
  if(kind==='tool-rejected')return {...base,outcome:'rejected'};
  if(kind==='batch-item-result')return p.status==='accepted'||p.status==='rejected'?{...base,outcome:p.status}:undefined;
  if(kind!=='tool-result'&&kind!=='query-result')return undefined;
  if(!result)return {...base,outcome:'unconfirmed'};
  if(['unknown','unconfirmed','indeterminate','pending','cancelled'].includes(String(result.status)))return {...base,outcome:'unconfirmed'};
  if('error'in result||result.accepted===false||result.success===false||result.saved===false||['rejected','failed','error'].includes(String(result.status)))return {...base,outcome:'rejected'};
  if(result.status==='partial')return {...base,outcome:'partial'};
  if(p.tool==='batch')return {...base,outcome:result.complete===true?'accepted':'partial'};
  if(result.read===true||result.dryRun===true)return {...base,outcome:'read'};
  // Read-only predictions/queries are conditional information, never execution receipts.
  return {...base,outcome:kind==='query-result'||(toolMetadata(String(p.tool))?.effect??'read')==='read'?'read':'accepted'};
}
