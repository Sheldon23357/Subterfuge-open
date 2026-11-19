import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexRpc} from './codex-rpc.js';
import {codexIsolationArguments} from './codex-config.js';
import {codexInput} from './codex-input.js';
import {codexGenerationSchema} from './codex-schema.js';
import {EMPTY_MODEL_SCHEMA} from '../../controller/contracts/model-json.js';
import {providerCallTimeout} from '../../controller/contracts/provider-timeout.js';
import {ProviderError,classifyProviderFailure} from '../../controller/contracts/provider-error.js';
import type {AgentRequest,ModelResult} from '../../controller/contracts/types.js';
interface Slot {threadId?:string;busy:boolean;used:number}
const valid=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');

/** Threads contain zero turns between calls. Any failed/uncertain reset evicts
 * the identity, so a subsequent call can never append to unverified history. */
export class CodexSessionPool {
 private slots=new Map<string,Slot>();private serial=0;
 constructor(private executable:string,private timeoutMs?:number){}
 async run(request:AgentRequest):Promise<{output:string;context:NonNullable<ModelResult['providerContext']>}>{
  if(request.signal.aborted)throw new ProviderError('cancelled',undefined,{stage:'app-server-admission',outcome:'not-sent'});
  const input=codexInput(request.prompt),schema=JSON.stringify(codexGenerationSchema(request.responseSchema??EMPTY_MODEL_SCHEMA));
  const tier=request.serviceTier??process.env.AI_CODEX_SERVICE_TIER??'default';
  const scope=request.providerSessionScope?{kind:request.providerSessionScope.kind,task:request.providerSessionScope.task}:undefined;
  const key=sha(JSON.stringify([request.providerSessionKey,request.commanderMode??'decision',scope?[scope.kind,scope.task]:null,request.model,request.effort??'low',tier,input.instructions]));
  if(!this.slots.has(key)&&this.slots.size>=64&&![...this.slots.values()].some(s=>!s.busy))throw new ProviderError('unavailable',undefined,{stage:'app-server-admission',outcome:'not-sent',reason:'session-capacity'});
  const slot:Slot=this.slots.get(key)??{busy:false,used:0};
  if(slot.busy)throw new ProviderError('unavailable',undefined,{stage:'app-server-admission',outcome:'not-sent',reason:'session-busy'});
  slot.busy=true;slot.used=++this.serial;this.slots.set(key,slot);
  const controller=new AbortController();const abort=()=>controller.abort(new ProviderError(request.signal.reason?.name==='TimeoutError'?'timeout':'cancelled',request.signal.reason?.name==='TimeoutError'?'round-deadline':undefined));
  request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
  const timeoutMs=this.timeoutMs??providerCallTimeout(request.effort,request.timeoutMs);
  const timer=setTimeout(()=>controller.abort(new ProviderError('timeout','provider-call')),timeoutMs);
  let client:CodexRpc|undefined,sent=false,text:string|undefined,usage:any,turnId:string|undefined,retained=false;
  const reused=!!slot.threadId;
  try{
   const cwd=join(tmpdir(),'subterfuge-codex-v1','workspace');await mkdir(cwd,{recursive:true});
   if(controller.signal.aborted)throw controller.signal.reason;
   const args=['app-server',...codexIsolationArguments(request.effort,tier)];
   for(const c of ['model_provider="openai"','model_providers={}','skills.include_instructions=false','skills.bundled.enabled=false','sandbox_mode="read-only"','approval_policy="never"'])args.push('-c',c);
   client=new CodexRpc(this.executable,args,cwd,controller.signal,event=>{
    if(event.params?.threadId!==slot.threadId)return;
    if(event.method==='error'&&classifyProviderFailure(String(event.params.error?.message??'')).diagnostic?.reason==='rate-limit')throw new ProviderError('transient',undefined,{stage:'provider-output',outcome:'rejected',reason:'rate-limit',httpStatus:429});
    if(event.method==='item/started'||event.method==='item/completed'){
     const item=event.params.item;
     if(item&&!['userMessage','agentMessage','reasoning'].includes(item.type))throw new ProviderError('native-tool',undefined,{stage:'app-server-item',outcome:'unknown'});
     if(event.method==='item/completed'&&item?.type==='agentMessage'&&typeof item.text==='string')text=item.text;
    }
    if(event.method==='thread/tokenUsage/updated')usage={turnId:event.params.turnId,...event.params.tokenUsage.last};
   });
   await client.request('initialize',{clientInfo:{name:'subterfuge_bot',title:'Subterfuge bot',version:'0.1.0'},capabilities:{experimentalApi:true}});client.notify('initialized');
   if(slot.threadId){
    const resumed=await client.request('thread/resume',{threadId:slot.threadId,excludeTurns:true});
    if(resumed.thread?.id!==slot.threadId)throw new Error('Unexpected resumed identity');
    await this.empty(client,slot.threadId);
   }else{
    const started=await client.request('thread/start',{model:request.model||null,cwd,approvalPolicy:'never',sandbox:'read-only',ephemeral:false,historyMode:'paginated',developerInstructions:input.instructions,serviceTier:tier,config:{model_reasoning_effort:request.effort??'low',mcp_servers:{}}});
    if(typeof started.thread?.id!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(started.thread.id))throw new Error('Missing thread identity');slot.threadId=started.thread.id;
   }
   const threadId=slot.threadId;if(!threadId)throw new Error('Missing thread identity');
   // Eviction only archives empty, idle threads; no game/audit records live here.
   while(this.slots.size>64){const oldest=[...this.slots].filter(([,s])=>!s.busy).sort((a,b)=>a[1].used-b[1].used)[0];if(!oldest)break;this.slots.delete(oldest[0]);if(oldest[1].threadId)await client.request('thread/archive',{threadId:oldest[1].threadId});}
   sent=true;
   const started=await client.request('turn/start',{threadId:slot.threadId,input:[{type:'text',text:input.input}],effort:request.effort??'low',serviceTier:tier,outputSchema:JSON.parse(schema)});turnId=started.turn?.id;
   if(typeof turnId!=='string'||!turnId)throw new Error('Missing turn identity');
   const completed=await client.wait(e=>e.method==='turn/completed'&&e.params.threadId===slot.threadId&&e.params.turn.id===turnId);
   if(completed.params.turn.status!=='completed'){const classified=classifyProviderFailure(String(completed.params.turn.error?.message??''));throw new ProviderError(classified.code,undefined,{stage:'app-server-turn',outcome:'unknown',...(classified.diagnostic?.reason?{reason:classified.diagnostic.reason}:{})});}
   if(text===undefined||usage?.turnId!==turnId||!valid(usage.inputTokens)||!valid(usage.outputTokens))throw new ProviderError('invalid-response',undefined,{stage:'app-server-turn',outcome:'completed',reason:'missing-message-or-usage'});
   const current=await client.request('thread/turns/list',{threadId:slot.threadId,limit:2,itemsView:'notLoaded'});
   if(!Array.isArray(current.data)||current.data.length!==1||current.data[0]?.id!==turnId||current.nextCursor!=null)throw new Error('Unexpected accumulated history');
   await client.request('thread/revert',{threadId:slot.threadId,beforeTurnId:turnId});
   await this.empty(client,threadId);retained=true;
   const output=[{type:'thread.started',thread_id:slot.threadId},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:usage.inputTokens,output_tokens:usage.outputTokens,...(valid(usage.cachedInputTokens)&&usage.cachedInputTokens<=usage.inputTokens?{cached_input_tokens:usage.cachedInputTokens}:{})}}].map(e=>JSON.stringify(e)).join('\n');
   return {output,context:{kind:'codex',sessionMode:'revert',threadId,...(scope?{sessionScope:scope}:{}),reusedSession:reused,historyBefore:0,historyAfter:1,historyAfterReset:0,schemaProjection:'openai-strict/2',instructionsSha256:sha(input.instructions),schemaSha256:sha(schema)}};
  }catch(error){
   this.slots.delete(key);
   // A failed turn or reset never becomes reusable. Archiving is best effort;
   // losing the in-memory identity is the hard barrier against future reuse.
   if(client&&slot.threadId&&!controller.signal.aborted)try{await client.request('thread/archive',{threadId:slot.threadId});}catch{}
   if(error instanceof ProviderError)throw new ProviderError(error.code,error.timeoutSource,{stage:'app-server',...error.diagnostic,outcome:error.diagnostic?.outcome??(sent?'unknown':'not-sent')});
   throw new ProviderError('unavailable',undefined,{stage:'app-server-history',outcome:sent?'unknown':'not-sent',reason:'session-not-reusable'});
  }finally{
   if(!retained)this.slots.delete(key);slot.busy=false;
   if(client)await client.close();clearTimeout(timer);request.signal.removeEventListener('abort',abort);
  }
 }
 private async empty(client:CodexRpc,threadId:string){const history=await client.request('thread/turns/list',{threadId,limit:1,itemsView:'notLoaded'});if(!Array.isArray(history.data)||history.data.length||history.nextCursor!=null)throw new Error('History reset not verified');}
}
