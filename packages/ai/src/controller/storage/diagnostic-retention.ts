import {createHash} from 'node:crypto';

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Explicit allowlist: operation history, observations used as evidence, writes,
 * receipts, private notes and unknown extension records keep their full journal. */
export function currentSnapshotOnly(kind:string){
 return /^(?:mode-[a-z][a-z0-9-]{0,39}-(?:state|search|decision|feedback)|attack-screening|decision-observation|round-workset)$/.test(kind);
}
export function snapshotSummary(kind:string,payload:string,sequence:number){
 const value=JSON.parse(payload);
 return {format:'diagnostic-snapshot-summary/1',kind,sequence:object(value)&&Number.isSafeInteger(value.sequence)?value.sequence:sequence,bytes:Buffer.byteLength(payload),sha256:hash(payload),bodyRetained:false};
}
/** Call bodies are diagnostic, not the durable command/validation ledger. */
export function compactModelCall(value:unknown,captured=false):unknown{
 if(!object(value))return value;
 const result={...value},prompt=captured?value.promptText:value.prompt,reply=captured?value.reply:value.output;
 result.bodyRetention='summary-only';
 if(typeof prompt==='string'){
  result.promptCharacters=typeof value.promptCharacters==='number'?value.promptCharacters:prompt.length;
  result.promptHash=typeof value.promptHash==='string'?value.promptHash:hash(prompt);
 }
 if(value.responseSchema!==undefined&&value.responseSchema!==null)result.responseSchemaHash=hash(JSON.stringify(value.responseSchema));
 const summary=object(reply)&&typeof reply.summary==='string'?reply.summary.slice(0,1000):typeof value.summary==='string'?value.summary.slice(0,1000):null;
 result.summary=summary;
 if(captured){result.promptText='';result.reply=null;if(object(reply)&&typeof reply.tool==='string')result.tool=reply.tool.slice(0,40);}
 else {result.modelReturned=typeof value.modelReturned==='boolean'?value.modelReturned:reply!==null&&reply!==undefined;result.output=summary===null?null:{summary};delete result.prompt;}
 delete result.responseSchema;
 // Raw transport callbacks must never provide another route around body retention.
 if(object(value.rawOutput)&&typeof value.rawOutput.text==='string'){
  result.outputCharacters=value.rawOutput.text.length;result.outputHash=hash(value.rawOutput.text);
 }
 delete result.rawOutput;
 if(object(value.request)){
  result.request=Object.fromEntries(['commanderMode','model','provider','effort','timeoutMs'].filter(key=>value.request&&Object.hasOwn(value.request as object,key)).map(key=>[key,(value.request as Record<string,unknown>)[key]]));
 }
 return result;
}
