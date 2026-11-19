import type {AgentProvider,AgentRequest,LocalComputation} from '../controller/contracts/types.js';
import type {ModelCallQueue} from '../controller/runtime/model-queue.js';
import type {AgentDiagnostics} from '../controller/diagnostics/agent-diagnostics.js';
import type {SessionProvider} from './agent-provider.js';
interface ModelHostOptions {
 queue:ModelCallQueue;session:SessionProvider;sessionKey:string;fairnessKey:string;
 diagnostics:AgentDiagnostics;admit:(request:AgentRequest,modelCall:boolean)=>Promise<void>;
}
/** One model admission and capture path, separate from local computation admission. */
export function createSeatModelHost(o:ModelHostOptions):AgentProvider & LocalComputation {
 return {
  computeLocal:async(request,compute)=>{
   await o.admit(request,false);request.signal.throwIfAborted();
   const {beforeSend,onSend,...admitted}=request;return compute(admitted);
  },
  step:request=>o.queue.run(request.signal,async()=>{
   const handle=request.audit?.lane==='background'?null:o.diagnostics.beginCall(request);
   try{
    const result=await o.session.current.step({...request,providerSessionKey:o.sessionKey});
    o.diagnostics.finishCall(handle,result);return result;
   }catch(error){o.diagnostics.finishCall(handle,undefined,error);throw error;}
  },{fairnessKey:o.fairnessKey,beforeSend:()=>o.admit(request,true),...(request.onSend?{onStart:request.onSend}:{})}),
 };
}
export function createDiscussionModelHost(o:Omit<ModelHostOptions,'diagnostics'|'admit'> & {admit:(request:AgentRequest)=>Promise<void>;onQueueWait:(waitMs:number,admitted:boolean)=>void}):AgentProvider {
 return {step:request=>o.queue.run(request.signal,()=>o.session.current.step({...request,providerSessionKey:o.sessionKey}),{interactive:true,fairnessKey:o.fairnessKey,onQueueWait:o.onQueueWait,beforeSend:()=>o.admit(request),...(request.onSend?{onStart:request.onSend}:{})})};
}
