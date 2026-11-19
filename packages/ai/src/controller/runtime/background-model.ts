import {randomUUID} from 'node:crypto';
import type {AgentProvider,AgentRequest,AiState,ModelResult} from '../contracts/types.js';
import {errorDiagnostic} from '../../../../contracts/src/index.js';

/** Shared background model journal; strategy task events correlate by callId. */
export async function runBackgroundModel(state:AiState,provider:AgentProvider,request:AgentRequest,record:(kind:string,value:Record<string,unknown>)=>void):Promise<ModelResult<unknown>>{
 const started=Date.now(),callId=request.audit?.callId??randomUUID();
 let sentAt:number|undefined,result:ModelResult<unknown>|undefined,failure:unknown;
 const save=(finished:boolean)=>record('model-call',{
  callId,callPhase:'transport',sequence:state.sequence,kind:request.audit?.kind??'strategy',task:request.audit?.task??'background',attempt:request.audit?.attempt??0,
  status:finished?(request.signal.aborted?'cancelled':failure?'failed':'completed'):'queued',model:request.model,effort:request.effort??'low',timeoutMs:request.timeoutMs??null,
  queuedAt:new Date(started).toISOString(),sentAt:sentAt===undefined?null:new Date(sentAt).toISOString(),finishedAt:finished?new Date().toISOString():null,
  queueWaitMs:sentAt===undefined?null:sentAt-started,durationMs:finished?Date.now()-started:null,providerDurationMs:finished&&sentAt!==undefined?Date.now()-sentAt:null,
  prompt:request.prompt,responseSchema:request.responseSchema??null,output:result?.reply??null,tokens:result?.tokens??null,usage:result?.usage??null,usageKnown:result?.usageKnown??null,
  completion:result?.completion??null,providerContext:result?.providerContext??null,error:failure?errorDiagnostic(failure).message:null,sent:sentAt!==undefined,
 });
 request.signal.throwIfAborted();save(false);state.calls++;
 try{
  result=await provider.step({...request,audit:{...request.audit,callId,lane:'background'},onSend:wait=>{sentAt=Date.now();request.onSend?.(wait);}});
  state.tokens+=result.tokens;
  record('background-settled',{tokens:result.tokens,usage:result.usage??null,usageKnown:result.usageKnown??null,paused:!state.enabled});
  request.signal.throwIfAborted();return result;
 }catch(error){failure=error;throw error;}finally{save(true);}
}
