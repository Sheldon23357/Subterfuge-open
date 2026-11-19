import {parseAgentReply} from '../contracts/reply-protocol.js';
import {discussPrompt,reconcilePrompt} from '../presentation/game-prompts.js';
import {encodePromptSections,readPromptSections} from '../../../../contracts/src/index.js';

import type {AgentDiagnostics,DiagnosticCallHandle} from '../diagnostics/agent-diagnostics.js';
import {manualVersion} from '../execution/manual-coordination.js';
import {randomUUID} from 'node:crypto';
import type {CommanderThread,CommanderMessage,PlayerObservation,CommanderWorkerUpdate} from '../../../../contracts/src/index.js';
import type {AgentProvider,AiState,AiMemory,AiSnapshot,ModelDispatchReceipt,AgentRequest,NotebookEntry} from '../contracts/types.js';
import type {CommanderRepository} from '../storage/store-interfaces.js';
import {patchMemory} from '../storage/memory-patch.js';
import {parseCommanderResult,commanderReplySchema,type CommanderMode} from '../contracts/commander-protocol.js';
export {parseCommanderResult} from '../contracts/commander-protocol.js';
import {ModelAdmissionStale} from '../runtime/model-queue.js';
import {ProviderError} from '../contracts/provider-error.js';
import {diagnosticText,errorDiagnostic} from '../../../../contracts/src/index.js';

export interface CommanderTransport {request(path:string,data?:unknown):Promise<unknown>}
/** Keep enough private diagnostic detail to classify a failed discussion, without
 * persisting prompts, provider output, credentials, or arbitrary error properties. */
function commanderFailureDiagnostic(error:unknown){
 const cause=errorDiagnostic(error);
 if(!(error instanceof ProviderError))return {error:cause};
 const diagnostic=error.diagnostic;
 const evidence=diagnostic?.evidence;
 return {
  error:cause,provider:{code:error.code,outcome:error.outcome,timeoutSource:error.timeoutSource??null,
   stage:diagnostic?.stage??null,reason:diagnostic?.reason?diagnosticText(diagnostic.reason,120):null,
   ...(diagnostic?.outputFormat?{outputFormat:diagnostic.outputFormat}:{}),
   durationMs:diagnostic?.durationMs??null,timeoutMs:diagnostic?.timeoutMs??null,
   exitCode:diagnostic?.exitCode??null,exitSignal:diagnostic?.exitSignal??null,httpStatus:diagnostic?.httpStatus??null,
   ...(diagnostic?.process?{process:{spawnMs:diagnostic.process.spawnMs??null,exitMs:diagnostic.process.exitMs??null,closeMs:diagnostic.process.closeMs??null,
    stopRequestedMs:diagnostic.process.stopRequestedMs??null,stopReason:diagnostic.process.stopReason??null,timeoutLagMs:diagnostic.process.timeoutLagMs??null}}:{}),
   ...(evidence?{evidence:{callId:evidence.callId,reasons:evidence.reasons,networkCodes:evidence.networkCodes,
    httpStatuses:evidence.httpStatuses,events:evidence.events,lastEvent:evidence.lastEvent,
    startedAt:evidence.startedAt,finishedAt:evidence.finishedAt,firstOutputMs:evidence.firstOutputMs,lastOutputMs:evidence.lastOutputMs,
    stdoutBytes:evidence.stdoutBytes,stderrBytes:evidence.stderrBytes,silenceMs:evidence.silenceMs,
    malformedLines:evidence.malformedLines,oversizedLines:evidence.oversizedLines,
    errorFingerprints:evidence.errorFingerprints}}:{})}
 };
}
/** A bounded preview of actual changed instruction text, not a duplicate of the chat reply.
 * This is not an exhaustive diff; the UI must still show removed/added lines and full text. */
export function commanderProposalSummary(previous:string,next:string):string{
  if(!next.trim())return '清除现有指挥官指令，之后不再沿用这些要求。';
  const lines=(value:string)=>value.split(/\n+/).map(line=>line.trim()).filter(Boolean);
  const before=lines(previous),after=lines(next);
  const added=after.filter(line=>!before.includes(line)),removed=before.filter(line=>!after.includes(line));
  if(!added.length&&!removed.length)return '仅整理指示排布，具体内容见完整指示。';
  const preview=(added[0]??removed[0]??next).slice(0,100);
  const clipped=(added[0]??removed[0]??next).length>100?'…':'';
  if(!added.length&&removed.length)return `撤下这项要求：${preview}${clipped}${removed.length>1?'（另有其他移除，见下方）':''}`;
  return `${removed.length?'调整为':'增加要求'}：${preview}${clipped}${added.length>1||removed.length?'（完整变更见下方）':''}`;
}
/** Independent lane: it never acquires gameplay control, reports readiness, or awaits SeatRunner. */
export class CommanderWorker {
 private active:Promise<void>|null=null;
 private heartbeat:Promise<void>|null=null;
 private controller=new AbortController();
 private nextAt=0;
 private stopped=false;
 private checkpointDraining=false;
 private checkpointFrozen=false;
 private refreshes=0;
 private failedVersion:number|null=null;
 private failedAtMessage:string|undefined;
 private admissionWindow:{key:string;deadline:number}|null=null;
 private heldMessages=new Set<string>();
 constructor(private options:{promptCharacterLimit?:()=>number;reconciliationReceipt?:()=>string;buildPrompt?:(input:import('../contracts/bot-mode.js').CommanderPromptInput)=>string|undefined;state:AiState;expectedPlayer:number;roster:()=>NonNullable<AiSnapshot['roster']>;validateIdentity?:()=>Promise<unknown>;store:CommanderRepository;transport:CommanderTransport;provider:(callId:string,onQueueWait:(waitMs:number,admitted:boolean)=>void)=>AgentProvider;available:()=>boolean;onDirectives:()=>void;diagnostics?:Pick<AgentDiagnostics,'beginCommanderCall'|'updateCommanderCall'>;redact?:(text:string)=>string}){
  const held=options.store.latest<{messages:string[];failedVersion?:number;failedAtMessage?:string}>(options.state.roomId,options.state.lobbySeat,'commander-model-hold');
  this.heldMessages=new Set(held?.messages??[]);this.failedVersion=held?.failedVersion??null;this.failedAtMessage=held?.failedAtMessage;
  const pending=options.store.latest<ModelDispatchReceipt>(options.state.roomId,options.state.lobbySeat,'provider-dispatch-commander');
  if(pending?.status==='pending'){
    if(pending.messageId)this.heldMessages.add(pending.messageId);
    if(pending.mode==='reconcile'){this.failedVersion=pending.version??null;this.failedAtMessage=pending.latestPlayerMessage;}
    this.journal('commander-model-hold',{messages:[...this.heldMessages],...(this.failedVersion===null?{}:{failedVersion:this.failedVersion}),...(this.failedAtMessage?{failedAtMessage:this.failedAtMessage}:{}),recoveredDispatchId:pending.id});
  }

 }
 get busy(){return this.active!==null||this.heartbeat!==null||this.refreshes>0;}
 /** Stop new work without cancelling an in-flight discussion or losing its receipt. */
 beginCheckpointDrain(){this.checkpointDraining=true;}
 freezeCheckpoint(){if(this.busy)throw Error('Discussion has not drained');this.checkpointDraining=true;this.checkpointFrozen=true;}
 releaseCheckpoint(){this.checkpointFrozen=false;this.checkpointDraining=false;}
 tick(now=Date.now()){
   if(this.stopped||this.checkpointDraining||now<this.nextAt)return;
   this.nextAt=now+1000;
   if(this.active){if(!this.heartbeat)this.heartbeat=this.refresh().then(()=>{}).catch(()=>{}).finally(()=>{this.heartbeat=null;});return;}
   this.active=this.run().catch(()=>{this.nextAt=Date.now()+5000;}).finally(()=>{this.active=null;});
 }
 async close(){this.stopped=true;this.controller.abort();await this.active;await this.heartbeat;}
 async refresh(authorizedThread?:CommanderThread):Promise<CommanderThread>{
   if(this.stopped||this.checkpointFrozen)throw Error('Discussion is frozen');
   this.refreshes++;
   try{
   if(!authorizedThread)await this.options.validateIdentity?.();
   const t=authorizedThread??await this.options.transport.request('/tool/commander/worker') as CommanderThread;
   const s=this.options.state;
   if(!t||t.roomId!==s.roomId||t.player!==this.options.expectedPlayer||!t.directives||!Number.isSafeInteger(t.directives.version)||typeof t.directives.text!=='string'||!Array.isArray(t.messages))throw Error('Invalid commander identity');
   // Read private state and its authority version together. A heartbeat must
   // never save the older in-flight model object's memory over another writer.
   const durable=this.options.store.localDecisionView(s.roomId,s.lobbySeat,0);
   const fresh=durable.state??s;
   if(t.directives.version<Math.max(s.commanderDirectives?.version??0,fresh.commanderDirectives?.version??0))throw Error('Stale commander authority response');
   if((fresh.commanderDirectives?.version??0)!==t.directives.version){
     const next={...fresh,commanderDirectives:{version:t.directives.version,text:t.directives.text}};
     this.options.store.save(next,'commander-directives',{version:t.directives.version},durable.basis);
     // Publish to the shared object only after the CAS transaction succeeds.
     s.commanderDirectives=next.commanderDirectives;s.memory=next.memory;
     this.options.onDirectives();
   }else if((s.commanderDirectives?.version??0)!==t.directives.version){
     s.commanderDirectives=fresh.commanderDirectives!;s.memory=fresh.memory;
     this.options.onDirectives();
   }
   return t;
   }finally{this.refreshes--;}
 }
 // Journal writes are not private-state mutations. Always preserve the latest
 // durable seat, with CAS even when a different connection writes concurrently.
 private journalEvents(events:{kind:string;details:unknown}[],expectedBasis?:string){
   const {store,state}=this.options;
   const fresh=store.localDecisionView(state.roomId,state.lobbySeat,0);
   if(expectedBasis!==undefined&&fresh.basis!==expectedBasis)throw new ModelAdmissionStale('private-state-basis');
   store.saveEvents(fresh.state??state,events,undefined,fresh.basis);
 }
 private journal(kind:string,details:unknown,expectedBasis?:string){this.journalEvents([{kind,details}],expectedBasis);}
 private async send(update:CommanderWorkerUpdate){if(this.stopped||this.checkpointFrozen)throw Error('Discussion is frozen');await this.options.transport.request('/tool/commander/worker',update);}
 private async acknowledgeReconciliation(version:number,receipt:string,dispatchId?:string){
   try{
     this.options.onDirectives();
     await this.send({op:'ack',version,reply:receipt});
     // A durable reconciliation proves only its own dispatch committed. Never
     // replace a newer unknown dispatch with this older successful receipt.
     const {store,state}=this.options;
     const pending=store.latest<ModelDispatchReceipt>(state.roomId,state.lobbySeat,'provider-dispatch-commander');
     if(dispatchId&&pending?.id===dispatchId&&pending.mode==='reconcile'&&pending.version===version){
       const fresh=store.load(state.roomId,state.lobbySeat);if(fresh)state.memory=fresh.memory;
       if(pending.messageId)this.heldMessages.delete(pending.messageId);
       if(this.failedVersion===version){this.failedVersion=null;this.failedAtMessage=undefined;}
       this.journalEvents([{kind:'provider-dispatch-commander',details:{...pending,status:'settled',outcome:'completed'}},{kind:'commander-model-hold',details:{messages:[...this.heldMessages],...(this.failedVersion===null?{}:{failedVersion:this.failedVersion}),...(this.failedAtMessage?{failedAtMessage:this.failedAtMessage}:{})}}]);
     }
     return true;
   }catch(error){
     // The memory transaction already committed. Retry only notification and
     // acknowledgement; never label it a failed model call or regenerate it.
     this.nextAt=Date.now()+5000;
     const fresh=this.options.store.load(this.options.state.roomId,this.options.state.lobbySeat);if(fresh)this.options.state.memory=fresh.memory;
     try{this.journal('commander-ack-pending',{version,diagnostic:commanderFailureDiagnostic(error)});}catch{/* The committed receipt remains available for the next poll. */}
     return false;
   }
 }
 private async run(){
   const o=this.options,s=o.state;
   const thread=await this.refresh();
   const cleanup=o.store.pendingCommanderCleanup(s.roomId,s.lobbySeat);
   if(cleanup&&s.status!=='thinking'){
     try{
       const updated=await o.transport.request('/tool/commander/worker',{op:'cleanup',...cleanup}) as CommanderThread;
       if(updated.roomId!==s.roomId||updated.player!==o.expectedPlayer||updated.directives.version<thread.directives.version)throw Error('Invalid cleanup identity');
       await this.refresh();
       this.journal('commander-cleanup-applied',{requestId:cleanup.requestId,version:updated.directives.version,removed:cleanup.cleanup.completed});
     }catch(error){
       const status=(error as {status?:number}|null)?.status;
       this.journal(status===400||status===409?'commander-cleanup-rejected':'commander-cleanup-pending',{requestId:cleanup.requestId,diagnostic:commanderFailureDiagnostic(error)});
       this.nextAt=Date.now()+5000;
     }
     return;
   }
   const committed=o.store.latest<{version:number;receipt?:string;dispatchId?:string}>(s.roomId,s.lobbySeat,'commander-reconciled');
   const outstanding=o.store.latest<ModelDispatchReceipt>(s.roomId,s.lobbySeat,'provider-dispatch-commander');
   const committedDispatchPending=committed?.dispatchId!==undefined&&outstanding?.id===committed.dispatchId&&outstanding.status==='pending';
   if(committed?.version===thread.directives.version&&(thread.directives.version>thread.directives.appliedVersion||committedDispatchPending)){
     await this.acknowledgeReconciliation(committed.version,committed.receipt??'已将当前指挥官指令整理进策略，后续行动将按新指示复核。',committed.dispatchId);
     return;
   }
   const message=thread.messages.find(m=>m.role==='player'&&m.status==='queued'&&!this.heldMessages.has(m.id));
   const latestPlayerMessage=thread.messages.filter(m=>m.role==='player').at(-1)?.id;
   // A question owns only its discussion call. It neither retries an older
   // failed instruction version nor waits for an unrelated reconciliation.
   const reconcile=!message&&thread.directives.version>thread.directives.appliedVersion&&this.failedVersion!==thread.directives.version;
   if(!message&&!reconcile)return;
   if(!o.available()){
     if(message)await this.send({op:'reply',messageId:message.id,reply:'我现在还没有可用的模型配置，暂时无法分析。配置好后我们再继续。',error:true});
     this.nextAt=Date.now()+5000;return;
   }
   let local=o.store.localDecisionView(s.roomId,s.lobbySeat,0);
   if(!local.state){
     // A new seat must be loadable before it can become a decision snapshot.
     // Preserve the safe failure reply without persisting oversized memory.
     if(Object.values(s.memory).some(value=>typeof value!=='string'||value.length>12000)){
       if(message)await this.send({op:'reply',messageId:message.id,reply:'这次分析没能完成，你可以稍后再问我。刚才的讨论没有改变指挥官指令。',error:true});
       this.nextAt=Date.now()+5000;return;
     }
     // Bootstrap an empty seat before capturing any model context. A competing
     // initializer must fail this CAS; never attach its basis to our old state.
     o.store.save(s,'state',null,local.basis);
     local=o.store.localDecisionView(s.roomId,s.lobbySeat,0);
   }
   if(local.state)s.memory=local.state.memory;
   const mode:CommanderMode=reconcile?'reconcile':'discuss';
   const callId=randomUUID();
   const memoryBefore=JSON.stringify(s.memory),version=thread.directives.version;
   const admissionKey=message?`message:${message.id}`:`reconcile:${version}`;
   if(this.admissionWindow?.key!==admissionKey)this.admissionWindow={key:admissionKey,deadline:Date.now()+120000};
   const admissionDeadline=this.admissionWindow.deadline;
   const decisionBasis=local.basis;
   let capture:DiagnosticCallHandle|null=null,validated=false;
   let providerAttempted=false,providerCompleted=false;
   const dispatch:ModelDispatchReceipt={id:randomUUID(),status:'pending',boundary:'provider-adapter-handoff',mode,version,...(message?{messageId:message.id}:{}),...(latestPlayerMessage?{latestPlayerMessage}:{})};
   const settleDispatch=(outcome:ModelDispatchReceipt['outcome'])=>this.journal('provider-dispatch-commander',{...dispatch,status:'settled',outcome});
   try{
   let observation=await o.transport.request('/tool/observation') as PlayerObservation;
   if(observation.roomId!==s.roomId||observation.view.player!==thread.player)throw Error('Commander observation identity mismatch');
   const roster=o.roster();
   const buildCurrentPrompt=(currentThread:CommanderThread)=>{
    const miningPhase=o.store.observeMiningPhase(s.roomId,s.lobbySeat,observation);
    if(o.store.localWriteBasis(s.roomId,s.lobbySeat)!==decisionBasis)throw new ModelAdmissionStale('private-state-basis');
    let prompt=o.buildPrompt?.({mode,state:s,thread:currentThread,message:message??null,observation,roster})??(reconcile?reconcilePrompt(s,currentThread,observation,roster,local.notebook,miningPhase):discussPrompt(s,currentThread,message!,observation,roster,local.notebook,miningPhase));
    if(!readPromptSections(prompt))prompt=encodePromptSections([{id:'instructions.commander',label:'指挥官上下文',format:'text',text:prompt}]);
    if(prompt.length>(o.promptCharacterLimit?.()??240000))throw Error('Commander context limit');
    return prompt;
   };
   const prompt=buildCurrentPrompt(thread);
   this.journal('commander-call-started',{callId,mode,version,messageId:message?.id,startedAt:Date.now()},decisionBasis);
   // Journal events do not change private state. Never recapture a newer basis
   // for the older memory snapshot already used to prepare this prompt.
     const remaining=admissionDeadline-Date.now();
     if(remaining<=0)throw new ProviderError('timeout','round-deadline',{stage:'admission',outcome:'not-sent'});
     providerAttempted=true;
     const request:AgentRequest={commanderMode:mode,responseSchema:commanderReplySchema(mode),prompt,model:s.settings.model,...(s.settings.provider?{provider:s.settings.provider}:{}),...(s.settings.serviceTier?{serviceTier:s.settings.serviceTier}:{}),effort:s.settings.reasoningEffort??'low',timeoutMs:120000,signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(remaining)]),
       beforeSend:async()=>{
         if(Date.now()>=admissionDeadline)throw new ProviderError('timeout','round-deadline',{stage:'admission',outcome:'not-sent'});
         const admittedThread=await this.refresh();
         if((s.commanderDirectives?.version??0)!==version||JSON.stringify(s.memory)!==memoryBefore||o.store.localWriteBasis(s.roomId,s.lobbySeat)!==decisionBasis)throw new ModelAdmissionStale('commander-or-private-state');
         if(o.store.load(s.roomId,s.lobbySeat)?.memory.strategy!==s.memory.strategy)throw new ModelAdmissionStale('strategy-before-send');
         if(message&&!admittedThread.messages.some(m=>m.id===message.id&&m.status==='queued'))throw new ModelAdmissionStale('discussion-message-changed');
         const admitted=await o.transport.request('/tool/observation') as PlayerObservation;
         if(o.store.load(s.roomId,s.lobbySeat)?.memory.strategy!==s.memory.strategy)throw new ModelAdmissionStale('strategy-before-send');
         if(admitted.roomId!==s.roomId||admitted.view.player!==thread.player)throw Error('Commander admission identity mismatch');
         // Rebuild inside the acquired queue slot; clock progress must not
         // cancel a discussion or send its pre-queue world snapshot.
         observation=admitted;
         request.prompt=buildCurrentPrompt(admittedThread);
         o.diagnostics?.updateCommanderCall(capture,{prompt:request.prompt});
         if(o.store.localWriteBasis(s.roomId,s.lobbySeat)!==decisionBasis)throw new ModelAdmissionStale('private-state-basis');
         if(Date.now()>=admissionDeadline)throw new ProviderError('timeout','round-deadline',{stage:'admission',outcome:'not-sent'});
       },
       onSend:waitMs=>this.journalEvents([{kind:'provider-dispatch-commander',details:dispatch},{kind:'provider-request-sent',details:{lane:'commander',boundary:'provider-adapter-handoff',mode,version,messageId:message?.id,waitMs}}],decisionBasis),
     };
     capture=o.diagnostics?.beginCommanderCall(request,{callId,mode,version,...(message?{messageId:message.id}:{})})??null;
     const result=await o.provider(callId,(waitMs,admitted)=>{o.diagnostics?.updateCommanderCall(capture,{queueWaitMs:waitMs});try{this.journal('commander-queue-wait',{callId,waitMs,admitted});}catch{/* Diagnostics must not block the discussion. */}}).step(request);
     providerCompleted=true;
     o.diagnostics?.updateCommanderCall(capture,{result});
     this.admissionWindow=null;
     if(this.stopped)return;
     const parsed=parseCommanderResult(parseAgentReply(JSON.stringify(result.reply),mode),mode);
     validated=true;
     const text=o.redact?o.redact(parsed.text):parsed.text;
     if(o.redact)for(const key of Object.keys(parsed.memory) as (keyof AiMemory)[])parsed.memory[key]=o.redact(parsed.memory[key]!);
     // A second writer can update durable private state without mutating this
     // worker's object. Do not let diagnostic persistence overwrite that state.
     if(o.store.localWriteBasis(s.roomId,s.lobbySeat)!==decisionBasis){
       const fresh=o.store.load(s.roomId,s.lobbySeat);if(fresh)s.memory=fresh.memory;
       settleDispatch('completed');return;
     }
     this.journalEvents([{kind:'commander-call-completed',details:{callId,mode,version,tokens:result.tokens,usage:result.usage??null}},{kind:'provider-dispatch-commander',details:{...dispatch,outcome:'completed'}}]);
     const current=await this.refresh();
     if(current.directives.version!==version){settleDispatch('completed');return;} // Don't attach an old plan to new authority.
     if(reconcile){
       // This independent lane may run while the normal seat is paused. Check
       // existing manual authority before its already-requested merge; manual
       // clicks never enqueue a CommanderWorker reconciliation of their own.
       const latest=await o.transport.request('/tool/observation') as PlayerObservation;
       if(latest.roomId!==s.roomId||latest.view.player!==thread.player)throw Error('Commander commit identity mismatch');
       if(manualVersion(latest)!==manualVersion(observation)){
         o.store.observeManualCommands(s.roomId,s.lobbySeat,latest);
         const fresh=o.store.load(s.roomId,s.lobbySeat);if(fresh)s.memory=fresh.memory;
         this.journal('commander-manual-superseded',{callId,version,manualBasisVersion:manualVersion(observation),manualVersion:manualVersion(latest),saved:false});
         settleDispatch('completed');return;
       }
       // Submitted memory fields use last-writer-wins; record and authority
       // conflicts still reject this candidate against the captured basis.
       if(o.store.localWriteBasis(s.roomId,s.lobbySeat)!==decisionBasis){const fresh=o.store.load(s.roomId,s.lobbySeat);if(fresh)s.memory=fresh.memory;settleDispatch('completed');return;}
       const next=patchMemory(s.memory,parsed.memory,undefined);
       const labels:Record<keyof AiMemory,string>={strategy:'总体战略',relations:'关系判断',agreements:'协议记忆',deceptions:'真实意图'};
       const changed=(Object.keys(labels) as (keyof AiMemory)[]).filter(key=>next[key]!==s.memory[key]).map(key=>labels[key]);
       const receipt=(changed.length?`已更新${changed.join('、')}。`:'已复核现有战略笔记，无需改动。')+(o.reconciliationReceipt?.()??'具体行动会在正常决策中按新指示复核，文字整理不代表已执行。');
       o.store.saveEvents({...s,memory:next},[{kind:'memory-archived',details:{memory:s.memory,reason:'commander'}},{kind:'commander-reconciled',details:{version,callId,receipt,dispatchId:dispatch.id,manualBasisVersion:manualVersion(observation)}}],undefined,decisionBasis);
       s.memory=next;
       await this.acknowledgeReconciliation(version,receipt,dispatch.id);
       return; // ACK recovery owns settlement; a failed ACK stays pending.
     }else{
       const proposal=parsed.memory.strategy?.trim();
       await this.send({op:'reply',messageId:message!.id,reply:text,...(proposal!==undefined&&proposal!==thread.directives.text?{proposal:{baseVersion:version,text:proposal,summary:commanderProposalSummary(thread.directives.text,proposal)}}:{})});
     }
     // The delivery/ack is also complete. A crash before this receipt remains
     // held on restart, even when a model response was received in memory.
     settleDispatch('completed');
   }catch(error){
     o.diagnostics?.updateCommanderCall(capture,{error,...(providerCompleted&&!validated?{validationError:error instanceof Error?error.message:String(error)}:{})});
     if(this.stopped)return;
     if(error instanceof ModelAdmissionStale){
       const fresh=o.store.load(s.roomId,s.lobbySeat);if(fresh)s.memory=fresh.memory;
       this.journal('queued-stale-before-send',{lane:'commander',mode,version,messageId:message?.id,reason:error.reason,sent:false});
       this.nextAt=0;return; // Same pending task retains its original hard deadline.
     }
     this.admissionWindow=null;
     // Error delivery is a separate remote operation. Its failure must never
     // authorize another paid request whose previous outcome is unknown.
     const outcome=providerCompleted?'completed':error instanceof ProviderError?error.outcome:'unknown';
     const formatFailure=providerCompleted&&!validated||error instanceof ProviderError&&error.code==='invalid-response'&&error.outcome==='completed';
     if(providerAttempted&&(outcome==='unknown'||providerCompleted||formatFailure)){
       if(message)this.heldMessages.add(message.id);
       if(reconcile){this.failedVersion=version;this.failedAtMessage=latestPlayerMessage;}
       this.journalEvents([{kind:'provider-dispatch-commander',details:{...dispatch,...(formatFailure?{status:'settled'}:{}),outcome}},{kind:'commander-call-failed',details:{callId,mode,version,messageId:message?.id,diagnostic:commanderFailureDiagnostic(error)}},
         {kind:'commander-model-hold',details:{messages:[...this.heldMessages],...(this.failedVersion===null?{}:{failedVersion:this.failedVersion}),...(this.failedAtMessage?{failedAtMessage:this.failedAtMessage}:{})}}]);
     }else{this.journalEvents([{kind:'provider-dispatch-commander',details:{...dispatch,status:'settled',outcome:providerAttempted?outcome:'not-sent'}},{kind:'commander-call-failed',details:{callId,mode,version,messageId:message?.id,diagnostic:commanderFailureDiagnostic(error)}}]);}
     if(reconcile){this.failedVersion=version;this.failedAtMessage=latestPlayerMessage;await this.send({op:'notice',id:`reconcile-error-${version}`,reply:'指挥官指令已保存，但执行策略尚未整理完成，尚未确认新的行动安排。'+(formatFailure?'模型返回内容未通过校验，本次结果已丢弃。':'本次调用未成功，具体行动是否提交须以执行记录为准。')});}
     if(!reconcile&&message)await this.send({op:'reply',messageId:message.id,reply:'这次分析没能完成，你可以稍后再问我。刚才的讨论没有改变指挥官指令。',error:true});
     this.nextAt=Date.now()+5000;
   }
 }
}
