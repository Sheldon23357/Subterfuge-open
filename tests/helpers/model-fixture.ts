import type {AgentProvider,AgentReply} from '../../packages/ai/src/controller/contracts/types.js';
/** Encode the test's concise instruction fixtures as raw model wire JSON. */
export function commanderModelFactory(factory:(callId:string,onQueueWait:(waitMs:number,admitted:boolean)=>void)=>AgentProvider){
 return (callId:string,onQueueWait:(waitMs:number,admitted:boolean)=>void):AgentProvider=>wireModelFixture(factory(callId,onQueueWait));
}
export function wireModelFixture(provider:AgentProvider):AgentProvider {
 return {step:async request=>{
  const result=await provider.step(request),reply=result.reply as AgentReply;
  if(reply&&typeof reply==='object'&&'request' in reply)return result;
  return {...result,reply:{request:{tool:reply.tool,arguments:reply.arguments},summary:reply.summary,nextContext:reply.nextContext??null}};
 }};
}
