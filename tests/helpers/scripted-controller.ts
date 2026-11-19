import {SeatRunner as ApplicationSeatRunner} from '../../packages/ai/src/reference.js';
import {AgentRuntime as ApplicationAgentRuntime} from '../../packages/ai/src/reference.js';
import type {BotMode} from '../../packages/ai/src/controller/contracts/bot-mode.js';
import type {AgentProvider} from '../../packages/ai/src/controller/contracts/types.js';
import {buildLocalModeContext} from '../../packages/ai/src/controller/contracts/local-mode-context.js';
import {DEFAULT_EVENT_COALESCE_MS} from '../../packages/ai/src/controller/runtime/runner.js';

/** A scripted instruction source exercises the common execution state machine.
 * It has no strategy, prompt policy, background worker or production registration.
 * Product/hybrid integration tests use the application runner directly. */
export const scriptedExecution=(provider:AgentProvider):BotMode=>({
 id:'test-execution',recordPrefix:'mode-test-execution',usesModelProvider:true,
 supportsCommander:true,automaticEventCoalesceMs:undefined,
 retainSignals:()=>[],needsAnalysis:()=>true,
 prepare:input=>{
  const context=buildLocalModeContext(input.state,input.snapshot,'Scripted controller test');
  const prompt=JSON.stringify({snapshot:input.snapshot,memory:input.state.memory,feedback:input.feedback});
  context.prompt=prompt;context.promptContext={unit:'characters',total:prompt.length,sections:{testFixture:prompt.length}};
  return {context,run:(request,services)=>services.local(request,async admitted=>{const result=await provider.step(admitted);return {...result,reply:result.reply as import('../../packages/ai/src/controller/contracts/types.js').AgentReply};})};
 },
});
export class SeatRunner extends ApplicationSeatRunner{
 constructor(...args:ConstructorParameters<typeof ApplicationSeatRunner>){
  const [state,store,gateway,provider,pollIntervalMs,maintenance,resolveMode]=args;
  super(state,store,gateway,provider,pollIntervalMs,maintenance,resolveMode??(()=>scriptedExecution(provider)));
 }
 /** Execution/storage assertions explicitly drain the observation window.
  * Scheduler tests call poll() and assert each phase instead. */
 async pollAndFlush(...args:Parameters<ApplicationSeatRunner['poll']>){
  const [wallMs=Date.now(),force=false,observe=true,options={}]=args;
  await this.poll(wallMs,force,true,options);
  if(force)return;
  await this.poll(wallMs+(options.eventCoalesceMs??DEFAULT_EVENT_COALESCE_MS),false,true,options);
 }
}
export class AgentRuntime extends ApplicationAgentRuntime{
 constructor(...args:ConstructorParameters<typeof ApplicationAgentRuntime>){
  const [config,provider,env,options]=args;super(config,provider,env,{...options,resolveMode:options?.resolveMode??(()=>scriptedExecution(provider))});
 }
}
