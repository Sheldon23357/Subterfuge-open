import {roundMaterialSummary} from '../execution/round-workset.js';
import {aggregateModelRateLimits,type ModelRateLimitStats} from './model-rate-limit-stats.js';
import {actionHistory} from './action-history.js';
import {aggregateToolUsage,type ToolUsageStatistics} from '../execution/tool-usage-stats.js';
import {NOTEBOOK_CHARACTERS,NOTEBOOK_ENTRIES,STRATEGY_CHARACTERS} from '../storage/notebook-capacity.js';
import {createHash,randomUUID} from 'node:crypto';
import {decisionContextBreakdown,promptDecisionContextStart} from '../presentation/prompt-decision-breakdown.js';
import {promptReceiptBreakdown,RECEIPT_MEASUREMENT,type PromptReceiptBreakdown} from '../presentation/prompt-receipt-breakdown.js';
import {isClosedMemoryStatus} from '../storage/memory-records.js';
import type {DiagnosticReadModel,DiagnosticCaptureRepository} from '../storage/store-interfaces.js';
import type {AgentRequest,AgentResult,AiState,NotebookEntry,AiReminder} from '../contracts/types.js';
import type {Campaign} from '../storage/campaign-state.js';

export interface DiagnosticUsage {inputTokens:number|null;outputTokens:number|null;cachedInputTokens:number|null;totalTokens:number|null;provenance:'reported'|'synthetic'|'legacy-unknown'|'unavailable'}
export interface DiagnosticSnapshot {state:AiState;notebook:NotebookEntry[];reminders:AiReminder[];campaigns:Campaign[]}
export interface DiagnosticComposition {unit:'characters';calls:number;total:number;sections:Record<string,number>;toolReturns:Record<string,number>;decisionContext:{total:number;sections:Record<string,number>;coveredCalls:number}}
export interface DiagnosticStatsCall {callRef:number;round:number;step:number|null;attempt:number|null;durationMs:number|null;usage:DiagnosticUsage}
export interface ExecutionEvent {id:number;kind:'error'|'rework'|'retry';source:string;reason:string;at:string|null;step:number|null;attempt:number|null}
export interface ExecutionRound {round:number;events:ExecutionEvent[]}
export interface DiagnosticCommanderUsage {calls:number;tokens:number;knownTokenCalls:number;unknownTokenCalls:number;inputTokens:number;outputTokens:number;cachedInputTokens:number;inputCalls:number;outputCalls:number;byMode:Record<string,{calls:number;tokens:number}>}
export interface DiagnosticStats {modelRateLimits:ModelRateLimitStats;toolUsage:ToolUsageStatistics;generation:string;calls:number;duration:{totalMs:number;measuredCalls:number};composition:{all:DiagnosticComposition;recent:DiagnosticComposition};rounds:{round:number;calls:DiagnosticStatsCall[]}[];executionRounds:ExecutionRound[];unassignedCalls:number;commanderUsage:DiagnosticCommanderUsage}
interface CapturedCall {completion?:import('../contracts/types.js').ModelResult['completion'];observedTick?:number|null;promptDecisionBreakdown?:unknown;tool?:string;bodyRetention?:'summary-only';summary?:string|null;promptReceiptBreakdown?:PromptReceiptBreakdown|undefined;captureGeneration:string;callRef:number;round:number|null;lane?:'commander';mode?:string;callId?:string;messageId?:string;version?:number;queueWaitMs?:number;validationError?:string;request?:unknown;step:number|null;attempt:number|null;startedAt:number;durationMs:number|null;outcome:'running'|'completed'|'failed'|'cancelled';promptText:string;promptCharacters:number;promptHash:string;truncated:boolean;reply:unknown;usage:DiagnosticUsage;model:string;error:string|null}
export interface DiagnosticCallHandle {record:CapturedCall;signal?:AbortSignal}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const number=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
const emptyUsage=(provenance:DiagnosticUsage['provenance']='unavailable'):DiagnosticUsage=>({inputTokens:null,outputTokens:null,cachedInputTokens:null,totalTokens:null,provenance});
function statsUsage(value:unknown):DiagnosticUsage{
  if(!object(value)||!['reported','synthetic','legacy-unknown','unavailable'].includes(String(value.provenance)))return emptyUsage('legacy-unknown');
  const inputTokens=number(value.inputTokens),outputTokens=number(value.outputTokens),cached=number(value.cachedInputTokens);
  return {inputTokens,outputTokens,cachedInputTokens:inputTokens!==null&&cached!==null&&cached<=inputTokens?cached:null,totalTokens:inputTokens!==null&&outputTokens!==null?number(inputTokens+outputTokens):null,provenance:value.provenance as DiagnosticUsage['provenance']};
}
function promptBreakdown(payload:unknown,promptText:string,savedReceipts?:unknown,savedDecision?:unknown){
  const journalPayload=object(payload)?payload:{};
  const promptContext=object(journalPayload.promptContext)?journalPayload.promptContext:null;
  if(!promptContext||!object(promptContext.sections))return null;
  const promptTools=object(journalPayload.promptTools)?journalPayload.promptTools:null;
  const parent=(number(promptContext.sections.decisionHistory)??0)+(number(promptContext.sections.feedback)??0);
  const receipts=object(savedReceipts)?savedReceipts:promptReceiptBreakdown(promptText);
  let toolResults:Record<string,unknown>={unavailable:parent};
  if(receipts?.measurement===RECEIPT_MEASUREMENT&&receipts.total===parent&&object(receipts.tools)&&
    [...Object.values(receipts.tools),receipts.structure,receipts.unavailable].every(n=>number(n)!==null)&&
    Object.values(receipts.tools).reduce<number>((sum,n)=>sum+(n as number),0)+Number(receipts.structure)+Number(receipts.unavailable)===parent){
    toolResults={...receipts.tools,structure:receipts.structure,unavailable:receipts.unavailable};
  }else if(promptTools?.measurement===RECEIPT_MEASUREMENT&&object(promptTools.results)&&object(promptTools.results.total)){
    const values=promptTools.results.total,counts=Object.values(values);
    const sum=counts.reduce<number>((n,v)=>n+(number(v)??0),0);
    if(counts.every(n=>number(n)!==null)&&sum<=parent)toolResults={...values,structure:(number(values.structure)??0)+parent-sum};
  }
  const recordedDetail=object(promptContext.decisionContext)?promptContext.decisionContext:null;
  const calculatedDetail=recordedDetail??(object(savedDecision)?savedDecision:null)??decisionContextBreakdown(promptText);
  const detail=calculatedDetail&&object(calculatedDetail.sections)&&calculatedDetail.total===promptContext.sections.decisionContext?calculatedDetail:null;
  return {unit:'characters' as const,total:number(promptContext.total),sections:promptContext.sections,...(detail?{decisionContext:detail}:{}),...(toolResults?{toolReturns:toolResults}:{})};
}
const emptyComposition=():DiagnosticComposition=>({unit:'characters',calls:0,total:0,sections:{},toolReturns:{},decisionContext:{total:0,sections:{},coveredCalls:0}});
function addCounts(target:Record<string,number>,source:Record<string,unknown>){
  for(const [key,value] of Object.entries(source))if(number(value)!==null&&(value as number)>0)target[key]=(Object.hasOwn(target,key)?target[key]!:0)+(value as number);
}
function addBreakdown(target:DiagnosticComposition,breakdown:NonNullable<ReturnType<typeof promptBreakdown>>){
  target.calls++;
  target.total+=breakdown.total??Object.values(breakdown.sections).reduce<number>((sum,value)=>sum+(number(value)??0),0);
  addCounts(target.sections,breakdown.sections);addCounts(target.toolReturns,breakdown.toolReturns??{});
  const parent=number(breakdown.sections.decisionContext)??0,detail=breakdown.decisionContext;
  target.decisionContext.total+=parent;
  if(detail&&object(detail.sections)&&detail.total===parent&&Object.values(detail.sections).every(value=>number(value)!==null)&&Object.values(detail.sections).reduce<number>((sum,value)=>sum+(value as number),0)===parent){
    target.decisionContext.coveredCalls++;addCounts(target.decisionContext.sections,detail.sections);
  }else if(parent>0)target.decisionContext.sections.unavailable=(target.decisionContext.sections.unavailable??0)+parent;
}
function addComposition(target:DiagnosticComposition,source:DiagnosticComposition){
  target.calls+=source.calls;target.total+=source.total;addCounts(target.sections,source.sections);addCounts(target.toolReturns,source.toolReturns);
  target.decisionContext.total+=source.decisionContext.total;target.decisionContext.coveredCalls+=source.decisionContext.coveredCalls;addCounts(target.decisionContext.sections,source.decisionContext.sections);
}
export function diagnosticUsage(result:import('../contracts/types.js').ModelResult<unknown>):DiagnosticUsage {
  const known=result.usageKnown;if(!known||!['reported','synthetic'].includes(known.provenance))return emptyUsage('legacy-unknown');
  const input=known.input===true?number(result.usage?.inputTokens):null,output=known.output===true?number(result.usage?.outputTokens):null;
  const rawCached=known.cached===true?number(result.usage?.cachedInputTokens):null;
  return {inputTokens:input,outputTokens:output,cachedInputTokens:input!==null&&rawCached!==null&&rawCached<=input?rawCached:null,totalTokens:input!==null&&output!==null&&Number.isSafeInteger(input+output)?input+output:null,provenance:known.provenance};
}
/** Local-only bounded reader/capture sink. No gateway, provider or filesystem path is exposed. */
export class AgentDiagnostics {
  readonly generation=randomUUID();
  private unavailable:string|null=null;
  private readonly openedAfter:number;
  constructor(private store:DiagnosticReadModel & DiagnosticCaptureRepository,private state:AiState,private redact:(value:unknown)=>unknown,private modeDiagnostics:(observation:import('../../../../contracts/src/index.js').PlayerObservation|undefined)=>Record<string,unknown>=()=>({}),private contextMemory?:(observation:import('../../../../contracts/src/index.js').PlayerObservation|undefined)=>unknown){this.openedAfter=store.debugRows(state.roomId,state.lobbySeat,{limit:1}).entries[0]?.id??0;}
  private modeEvent(name:string){return 'mode-'+this.state.settings.mode+'-'+name;}
  private clean<T>(value:T):T{return this.redact(value) as T;}
  beginCall(request:AgentRequest):DiagnosticCallHandle|null{
    try{
      const row=this.store.debugRows(this.state.roomId,this.state.lobbySeat,{kinds:['call-reserved'],limit:1}).entries[0];
      if(!row||!object(row.payload)||row.payload.sequence!==this.state.sequence)throw Error();
      const clean=this.clean(request.prompt);if(typeof clean!=='string')throw Error();
      const truncated=Buffer.byteLength(clean)>1048576;
      // Redact the complete source before clipping; never split a secret before redaction.
      const promptText=truncated?clean.slice(0,250000):clean;
      const marker=promptDecisionContextStart(request.prompt),observedTick=marker<0?null:request.prompt.slice(marker,marker+1500).match(/"tick"\s*:\s*(\d+)/)?.[1];
      const record:CapturedCall={observedTick:observedTick==null?null:Number(observedTick),promptDecisionBreakdown:decisionContextBreakdown(request.prompt),promptReceiptBreakdown:promptReceiptBreakdown(request.prompt),captureGeneration:this.generation,callRef:row.id,round:this.state.sequence,step:number(row.payload.step),attempt:number(row.payload.attempt),startedAt:number(row.payload.startedAt)??Date.now(),durationMs:null,outcome:'running',promptText,promptCharacters:request.prompt.length,promptHash:createHash('sha256').update(promptText).digest('hex'),truncated,reply:null,usage:emptyUsage(),model:this.clean(request.model),error:null};
      this.store.debugPutCall(this.state.roomId,this.state.lobbySeat,row.id,this.clean(record));this.unavailable=null;return {record,signal:request.signal};
    }catch{this.unavailable='Diagnostic capture unavailable';return null;}
  }
  finishCall(handle:DiagnosticCallHandle|null,result?:import('../contracts/types.js').ModelResult<unknown>,error?:unknown):void{
    if(!handle)return;
    try{
      const record=handle.record;record.durationMs=Math.max(0,Date.now()-record.startedAt);record.outcome=result?'completed':handle.signal?.aborted?'cancelled':'failed';
      record.completion=result?.completion;record.reply=result?this.clean(result.reply):null;record.usage=result?diagnosticUsage(result):emptyUsage();record.error=error===undefined?null:'Provider call failed; raw error withheld';
      this.store.debugPutCall(this.state.roomId,this.state.lobbySeat,record.callRef,this.clean(record));
    }catch{this.unavailable='Diagnostic capture unavailable';}
  }
  beginCommanderCall(request:AgentRequest,metadata:{callId:string;mode:string;version:number;messageId?:string}):DiagnosticCallHandle|null{
    try{
      const row=this.store.debugRows(this.state.roomId,this.state.lobbySeat,{kinds:['commander-call-started'],limit:1}).entries[0];
      if(!row||!object(row.payload)||row.payload.callId!==metadata.callId)throw Error('Missing commander call');
      const record:CapturedCall={captureGeneration:this.generation,callRef:row.id,round:null,lane:'commander',...metadata,request:{commanderMode:request.commanderMode,model:request.model,provider:request.provider,effort:request.effort,timeoutMs:request.timeoutMs},step:null,attempt:null,startedAt:Date.now(),durationMs:null,outcome:'running',promptText:request.prompt,promptCharacters:request.prompt.length,promptHash:createHash('sha256').update(request.prompt).digest('hex'),truncated:false,reply:null,usage:emptyUsage(),model:request.model,error:null};
      this.saveCommander(record);return {record,signal:request.signal};
    }catch{this.unavailable='Commander diagnostic capture unavailable';return null;}
  }
  private saveCommander(record:CapturedCall){
    // Preserve raw text within the repository's 2 MiB per-call bound. Any clipping
    // is explicit; normal request/reply objects are retained without redaction.
    while(Buffer.byteLength(JSON.stringify(record))>1900000){
      record.truncated=true;
      if(record.validationError)record.validationError=record.validationError.slice(0,16000);
      const reply=typeof record.reply==='string'?record.reply:JSON.stringify(record.reply);
      if(reply.length>record.promptText.length)record.reply=reply.slice(0,Math.floor(reply.length/2));
      else record.promptText=record.promptText.slice(0,Math.floor(record.promptText.length/2));
    }
    this.store.debugPutCall(this.state.roomId,this.state.lobbySeat,record.callRef,record);
  }
  updateCommanderCall(handle:DiagnosticCallHandle|null,update:{prompt?:string;result?:import('../contracts/types.js').ModelResult<unknown>;error?:unknown;validationError?:string;queueWaitMs?:number}):void{
    if(!handle)return;
    try{
      const r=handle.record;
      if(update.prompt!==undefined){r.promptText=update.prompt;r.promptCharacters=update.prompt.length;r.promptHash=createHash('sha256').update(update.prompt).digest('hex');}
      if(update.result){r.completion=update.result.completion;r.reply=structuredClone(update.result.reply);r.usage=diagnosticUsage(update.result);r.outcome='completed';r.durationMs=Math.max(0,Date.now()-r.startedAt);}
      if(update.queueWaitMs!==undefined)r.queueWaitMs=update.queueWaitMs;
      if(update.validationError!==undefined)r.validationError=update.validationError;
      if(update.error!==undefined){const error=update.error instanceof Error?update.error.stack??update.error.message:String(update.error);r.error=error.slice(0,16000);if(error.length>16000)r.truncated=true;if(r.reply===null){r.outcome=handle.signal?.aborted?'cancelled':'failed';r.durationMs=Math.max(0,Date.now()-r.startedAt);}}
      this.saveCommander(r);
    }catch{this.unavailable='Commander diagnostic capture unavailable';}
  }
  private strategyRecord(ref:number,payload?:unknown){
    const p=payload??this.store.debugGetStrategyCall(this.state.roomId,this.state.lobbySeat,ref,this.modeEvent('model-call'));if(!object(p))return null;
    const output=object(p.output)?p.output:null,returned=p.modelReturned===true||!!output,known=object(p.usageKnown)?p.usageKnown:null,usage=object(p.usage)?p.usage:{};
    const input=known?.input===true?number(usage.inputTokens):null,outputTokens=known?.output===true?number(usage.outputTokens):null,cached=known?.cached===true?number(usage.cachedInputTokens):null;
    const error=p.status==='failed'?(typeof p.error==='string'?p.error.slice(0,4000):'后台调用失败，未记录详细原因'):null;
    const failure=object(p.failure)?p.failure:error?{stage:returned?'validation':'unknown'}:null;
    const validationError=error&&failure?.stage==='validation'?error:null;
    return {callRef:ref,lane:'strategy',callPhase:p.callPhase,completion:p.completion,mode:String(p.kind),task:p.task,processingStatus:p.status,callId:p.callId,model:p.model,round:null,step:null,attempt:number(p.attempt),
      startedAt:typeof p.queuedAt==='string'?Date.parse(p.queuedAt):null,sentAt:p.sentAt,finishedAt:p.finishedAt,queueWaitMs:number(p.queueWaitMs),providerDurationMs:number(p.providerDurationMs),durationMs:number(p.durationMs),
      outcome:!p.finishedAt?(ref<=this.openedAfter?'interrupted-unconfirmed':'running'):p.status==='cancelled'?'cancelled':p.status==='failed'?(returned?'completed':'failed'):returned?'completed':'interrupted-unconfirmed',
      bodyRetention:p.bodyRetention,summary:p.summary,promptText:typeof p.prompt==='string'?p.prompt:'',promptCharacters:typeof p.promptCharacters==='number'?p.promptCharacters:typeof p.prompt==='string'?p.prompt.length:0,truncated:false,reply:output,
      request:{model:p.model,effort:p.effort,timeoutMs:p.timeoutMs,responseSchema:p.responseSchema,...(object(p.contextSelection)?{audit:{contextSelection:p.contextSelection,modelReferences:p.modelReferences??{}}}:{})},
      usage:{inputTokens:input,outputTokens,cachedInputTokens:input!==null&&cached!==null&&cached<=input?cached:null,totalTokens:input!==null&&outputTokens!==null?input+outputTokens:null,provenance:known?.provenance??'unavailable'},
      failure,validationError,error:validationError?null:error};
  }
  private strategySummary(ref:number,payload?:unknown){
    const record=this.strategyRecord(ref,payload);if(!record)return null;
    const {promptText,reply,request,...summary}=record;
    const args=reply??{};
    return {...summary,toolError:record.validationError??record.error,summary:typeof args.summary==='string'?args.summary:null,observedTick:object(payload)&&object(payload.basis)?number(payload.basis.tick):null,
      prompt:{available:record.bodyRetention!=='summary-only'&&!!promptText,characters:record.promptCharacters,truncated:false},captured:true};
  }
  private summary(row:{id:number;payload:unknown;unavailable:boolean}){
    const record=this.store.debugGetCall(this.state.roomId,this.state.lobbySeat,row.id) as CapturedCall|null;
    if(record?.lane==='commander'){
      const {promptText,reply,...summary}=record;const response=object(reply)?reply:{};
      return {...summary,outcome:record.outcome==='running'&&record.captureGeneration!==this.generation?'interrupted-unconfirmed':record.outcome,tool:null,summary:record.summary??(typeof response.summary==='string'?response.summary.slice(0,280):null),toolOutcome:record.validationError?'rejected':null,toolError:record.validationError??record.error,prompt:{available:record.bodyRetention!=='summary-only',characters:record.promptCharacters,truncated:record.truncated},captured:true};
    }
    if(record){
      const {promptText,reply,...summary}=record,trail=this.store.debugCallTrail(this.state.roomId,this.state.lobbySeat,row.id);
      const response=object(reply)?reply:{},tool=record.tool??(typeof response.tool==='string'?response.tool.slice(0,40):null);
      const receipt=[...trail].reverse().find(e=>['tool-result','tool-rejected','tool-unknown','write-reconciled','batch-recovered'].includes(String(e.kind)));
      const cancelled=record.outcome==='failed'&&trail.some(e=>e.kind==='paused')&&!trail.some(e=>e.kind==='call-failed');
      const outcome=cancelled?'cancelled':record.outcome==='running'&&record.captureGeneration!==this.generation?'interrupted-unconfirmed':record.outcome;
      const marker=promptDecisionContextStart(promptText),tick=marker<0?null:promptText.slice(marker,marker+1500).match(/"tick"\s*:\s*(\d+)/)?.[1];
      const breakdown=promptBreakdown(row.payload,promptText,record.promptReceiptBreakdown,record.promptDecisionBreakdown);
      return {...summary,...(breakdown?{promptBreakdown:breakdown}:{}),outcome,tool,summary:record.summary??(typeof response.summary==='string'?response.summary.slice(0,280):null),observedTick:record.observedTick??(tick==null?null:Number(tick)),
        resultTick:number(receipt?.resultTick),toolReconciled:receipt?.kind==='write-reconciled'||receipt?.kind==='batch-recovered',toolOutcome:receipt?.complete===0?'partial':receipt?.resolutionStatus==='not-executed'?'not-executed':receipt?.kind==='tool-unknown'||receipt?.resolutionStatus==='unknown'?'unknown':receipt?.kind==='tool-rejected'||receipt?.resolutionStatus==='rejected'?'rejected':trail.some(e=>e.kind==='reply-superseded')?'superseded':receipt?'returned':null,
        toolError:typeof receipt?.error==='string'?receipt.error.slice(0,160):typeof receipt?.batchError==='string'?receipt.batchError.slice(0,160):receipt?.complete===0?(tool==='queries'?'query-batch-incomplete':'batch-incomplete'):null,
        prompt:{available:record.bodyRetention!=='summary-only',characters:record.promptCharacters,truncated:record.truncated},captured:true};
    }
    const p=object(row.payload)?row.payload:{};
    return {...(typeof p.callId==='string'?{lane:'commander',mode:typeof p.mode==='string'?p.mode:undefined,callId:p.callId}:{}),callRef:row.id,round:number(p.sequence),step:number(p.step),attempt:number(p.attempt),startedAt:number(p.startedAt),durationMs:null,outcome:'legacy-unknown',prompt:{available:false,characters:number(p.promptCharacters),truncated:false,reason:row.id<=this.openedAfter?'legacy-not-recorded':'not-recorded'},usage:emptyUsage('legacy-unknown'),captured:false,error:null};
  }
  read(section:string,query:Record<string,string>={}):unknown{
    const result=this.readSection(section,query);return {...(result as Record<string,unknown>),redaction:{scope:section==='commander-calls'||section==='content'||section==='call'?'per-call-commander-raw':'known-session-secrets-and-patterns'}};
  }
  /** One read transaction keeps all-history totals and both round windows coherent.
   * Scan bounded pages, retaining only aggregates and the latest 50 rounds' usage;
   * never return prompt/reply bodies or cache another seat/generation's history. */
  private stats():DiagnosticStats{
    return this.store.debugReadTransaction(()=>{
      const commanderUsage:DiagnosticCommanderUsage={calls:0,tokens:0,knownTokenCalls:0,unknownTokenCalls:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,inputCalls:0,outputCalls:0,byMode:{}};
      const result:DiagnosticStats={modelRateLimits:{total:0,byLane:{automatic:0,background:0,commander:0},lastAt:null},toolUsage:{all:{total:0,counts:{}},recent:{total:0,counts:{}},recentRounds:[],unassigned:0},generation:this.generation,calls:0,duration:{totalMs:0,measuredCalls:0},composition:{all:emptyComposition(),recent:emptyComposition()},rounds:[],executionRounds:[],unassignedCalls:0,commanderUsage};
      const recent=new Map<number,{calls:DiagnosticStatsCall[];composition:DiagnosticComposition}>();
      let before=Number.MAX_SAFE_INTEGER,backfillCalls=0,backfillBytes=0;
      while(true){
        const page=this.store.debugStatsRows(this.state.roomId,this.state.lobbySeat,before,100);
        for(const row of page.entries){
          const record=row.capture,payload=row.payload;
          // Keep exact historical detail when inexpensive; omitted backfill remains
          // explicitly uncovered rather than turning a partial scan into a full total.
          let prompt='';const remainingBytes=4194304-backfillBytes;
          if(row.promptBytes!==null&&backfillCalls<30&&row.promptBytes<=remainingBytes){
            backfillCalls++;backfillBytes+=row.promptBytes;
            prompt=this.store.debugStatsPrompt(this.state.roomId,this.state.lobbySeat,row.id,remainingBytes)??'';
          }
          const round=number(record?.round)??number(payload.sequence),durationMs=number(record?.durationMs),breakdown=record?promptBreakdown(payload,prompt,record.promptReceiptBreakdown,record.promptDecisionBreakdown):null;
          result.calls++;
          if(durationMs!==null){result.duration.totalMs+=durationMs;result.duration.measuredCalls++;}
          if(breakdown)addBreakdown(result.composition.all,breakdown);
          if(round===null){result.unassignedCalls++;continue;}
          if(!recent.has(round)){
            const oldest=recent.size===50?Math.min(...recent.keys()):null;
            if(oldest!==null&&round<oldest)continue;
            if(oldest!==null)recent.delete(oldest);
            recent.set(round,{calls:[],composition:emptyComposition()});
          }
          const group=recent.get(round)!;
          group.calls.push({callRef:row.id,round,step:number(record?.step)??number(payload.step),attempt:number(record?.attempt)??number(payload.attempt),durationMs,usage:statsUsage(record?.usage)});
          if(breakdown)addBreakdown(group.composition,breakdown);
        }
        if(page.nextCursor===null)break;
        before=page.nextCursor;
      }
      const rounds=[...recent.entries()].sort(([a],[b])=>a-b);
      result.rounds=rounds.map(([round,group])=>({round,calls:group.calls.sort((a,b)=>a.callRef-b.callRef)}));
      for(const [,group] of rounds.slice(-10))addComposition(result.composition.recent,group.composition);
      const cleared=this.store.debugRows(this.state.roomId,this.state.lobbySeat,{kinds:['diagnostics-cleared'],limit:1}).entries[0]?.id??0;
      result.modelRateLimits=aggregateModelRateLimits(after=>this.store.debugModelFailureRows(this.state.roomId,this.state.lobbySeat,after),cleared);
      result.toolUsage=aggregateToolUsage(after=>this.store.debugToolUsageRows(this.state.roomId,this.state.lobbySeat,after),cleared);
      const execution=new Map<number,ExecutionRound>();
      let executionAfter=cleared,currentRound:number|null=null,lastFailurePhase:string|null=null,lastReason='';
      let lastFailure:{group:ExecutionRound;event:ExecutionEvent}|null=null;
      const removePreviousFailure=()=>{
        if(lastFailure){const index=lastFailure.group.events.indexOf(lastFailure.event);if(index>=0)lastFailure.group.events.splice(index,1);}
        lastFailure=null;
      };
      while(true){
        const page=this.store.debugExecutionRows(this.state.roomId,this.state.lobbySeat,executionAfter);
        for(const row of page){
          const [sequence,diagnosticSequence,id,step,attempt,reason,code,toolError,batchError,complete,cause,causeCode,operation,diagnosticAt,at,phase,diagnosticPhase]=row.metrics;
          const toolRound=typeof id==='string'?id.match(/^ai-\d+-(\d+)-\d+$/)?.[1]:undefined;
          const round:number|null=number(sequence)??number(diagnosticSequence)??(toolRound?number(Number(toolRound)):null)??currentRound;
          if(round===null||round<1)continue;
          if(row.kind==='started'||row.kind==='call-reserved'){currentRound=round;lastFailurePhase=null;lastFailure=null;lastReason='';}
          if(!execution.has(round))execution.set(round,{round,events:[]});
          const oldest=execution.size>50?Math.min(...execution.keys()):null;
          if(oldest!==null)execution.delete(oldest);
          const group=execution.get(round);if(!group)continue;
          const failurePhase=typeof (phase??diagnosticPhase)==='string'?String(phase??diagnosticPhase):null;
          const text=[operation,reason,toolError,batchError,cause,causeCode,code].filter((v):v is string=>typeof v==='string'&&v.length>0);
          const message=[...new Set(text)].join(' · ')||'未记录具体原因';
          const add=(kind:ExecutionEvent['kind'],detail=message)=>{const event=this.clean({id:row.id,kind,source:row.kind,reason:detail,at:typeof (diagnosticAt??at)==='string'?String(diagnosticAt??at):null,step:number(step),attempt:number(attempt)});event.reason=event.reason.length>1600?event.reason.slice(0,1600)+'…（原因过长，查看日志全文）':event.reason;group.events.push(event);return event;};
          const failure=(kind:'error'|'rework',detail=message)=>{lastFailure={group,event:add(kind,detail)};lastReason=detail;};
          if(row.kind==='call-failed'){failure('error');lastFailurePhase='model';}
          else if(row.kind==='tool-rejected'||row.kind==='tool-result'&&(typeof toolError==='string'||complete===false||complete===0)){
            failure('rework',message==='未记录具体原因'?'批量执行未完成，需重新决策':message);lastFailurePhase='tool';
          }else if(row.kind==='error'){
            if(!failurePhase||failurePhase!==lastFailurePhase)failure('error');
            lastFailurePhase=failurePhase;lastReason=message;
          }else if(row.kind==='runtime-error'||row.kind==='observation-error')failure('error');
          else if(row.kind==='reply-superseded')add('rework');
          else if(row.kind==='provider-retry'||row.kind==='recovery-started'){
            // A failure which actually starts a retry belongs only to retry,
            // rather than counting its failure and recovery as two incidents.
            removePreviousFailure();
            add('retry',message==='未记录具体原因'?lastReason||'恢复执行':message+(lastReason?' · '+lastReason:''));
          }else if(row.kind==='tool-result'){lastFailure=null;lastFailurePhase=null;lastReason='';}
        }
        if(page.length<100)break;
        executionAfter=page.at(-1)!.id;
      }
      result.executionRounds=[...execution.values()].sort((a,b)=>a.round-b.round);
      let eventBefore=Number.MAX_SAFE_INTEGER;
      while(true){
        const page=this.store.debugRows(this.state.roomId,this.state.lobbySeat,{after:cleared,before:eventBefore,limit:100,kinds:['commander-call-started','commander-call-completed']});
        for(const row of page.entries){
          if(!object(row.payload)){if(row.kind==='commander-call-started')commanderUsage.calls++;continue;}
          const payload=row.payload,mode=typeof payload.mode==='string'?payload.mode:'unknown',tokens=number(payload.tokens),usage=object(payload.usage)?payload.usage:{};
          const modeTotal=commanderUsage.byMode[mode]??(commanderUsage.byMode[mode]={calls:0,tokens:0});
          if(row.kind==='commander-call-started'){commanderUsage.calls++;modeTotal.calls++;continue;}
          if(tokens===null)commanderUsage.unknownTokenCalls++;
          else{commanderUsage.knownTokenCalls++;commanderUsage.tokens+=tokens;modeTotal.tokens+=tokens;}
          const input=number(usage.inputTokens),output=number(usage.outputTokens),cached=number(usage.cachedInputTokens);
          if(input!==null){commanderUsage.inputTokens+=input;commanderUsage.inputCalls++;}
          if(output!==null){commanderUsage.outputTokens+=output;commanderUsage.outputCalls++;}
          if(input!==null&&cached!==null&&cached<=input)commanderUsage.cachedInputTokens+=cached;
        }
        if(page.nextCursor===null)break;
        eventBefore=page.nextCursor;
      }
      commanderUsage.unknownTokenCalls=Math.max(0,commanderUsage.calls-commanderUsage.knownTokenCalls);
      // Call rows contain only validated numbers and fixed usage provenance. Redact
      // the dynamic metric names separately so long complete rounds do not hit
      // the generic redactor's per-object traversal cap.
      return {...result,toolUsage:this.clean(result.toolUsage),commanderUsage:this.clean(commanderUsage),composition:{all:this.clean(result.composition.all),recent:this.clean(result.composition.recent)}};
    });
  }
  private readSection(section:string,query:Record<string,string>):unknown{
    const parameters:Record<string,string[]>={live:[],state:[],stats:[],'commander-calls':['before','limit'],calls:['before','limit','round','from','to'],call:['ref'],content:['ref','kind','offset','limit'],notebook:['before','limit','scope'],reminders:['before','limit','scope'],campaigns:['before','limit','scope'],rounds:['before','limit','round'],events:['before','limit','round']};
    const allowed=new Set([...(parameters[section]??[]),'generation']);
    if(Object.keys(query).some(k=>!allowed.has(k))||query.generation!==undefined&&query.generation!==this.generation)throw Error('Invalid diagnostic query');
    const integer=(key:string,fallback?:number)=>{const raw=query[key];if(raw===undefined)return fallback;if(!/^(0|[1-9][0-9]*)$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw Error('Invalid diagnostic cursor');return Number(raw);};
    const limit=integer('limit',20)!;if(limit<1||limit>50&&section!=='content')throw Error('Invalid diagnostic page size');
    const before=integer('before',Number.MAX_SAFE_INTEGER)!,round=integer('round'),from=integer('from'),to=integer('to');
    if(before<1)throw Error('Invalid diagnostic cursor');
    if(from!==undefined&&to!==undefined&&from>to)throw Error('Invalid time range');
    const room=this.state.roomId,seat=this.state.lobbySeat;
    const page=(kinds?:string[])=>this.store.debugRows(room,seat,{before,limit,...(kinds?{kinds}:{}),...(round!==undefined?{sequence:round}:{}),...(from!==undefined?{from}:{}),...(to!==undefined?{to}:{})});
    if(section==='stats')return this.stats();
    if(section==='state'){
      let campaigns:Campaign[]|null=null;try{campaigns=this.currentCampaigns();}catch{}
      return this.clean({generation:this.generation,state:structuredClone(this.state),capture:{available:this.unavailable===null,error:this.unavailable},campaigns,campaignState:{available:campaigns!==null}});
    }
    if(section==='commander-calls'){
      const after=this.store.debugRows(room,seat,{kinds:['diagnostics-cleared'],limit:1}).entries[0]?.id??0;
      const rows=this.store.debugRows(room,seat,{after,before,limit,kinds:['commander-call-started']});
      return {generation:this.generation,entries:rows.entries.map(row=>this.summary(row)),rounds:[],nextCursor:rows.nextCursor};
    }
    if(section==='calls'){
      const rows=page(['call-reserved']);
      const after=this.store.debugRows(room,seat,{kinds:['diagnostics-cleared'],limit:1}).entries[0]?.id??0;
      const strategyCalls=round===undefined?this.store.debugStrategyCalls(room,seat,this.modeEvent('model-call'),{before,after,limit,...(from!==undefined?{from}:{}),...(to!==undefined?{to}:{})}):{entries:[],nextCursor:null};
      const all=[...rows.entries.map(row=>this.summary(row)),...strategyCalls.entries.map(row=>this.strategySummary(row.id,row.payload)).filter((row):row is NonNullable<typeof row>=>row!==null)].sort((a,b)=>b.callRef-a.callRef);
      const entries=all.slice(0,limit),nextCursor=all.length>limit||rows.nextCursor!==null||strategyCalls.nextCursor!==null?entries.at(-1)?.callRef??null:null;
      const rounds=[...new Set(entries.map(e=>e.round).filter((r):r is number=>r!==null))].map(round=>{
        const row=this.store.debugRows(room,seat,{kinds:['started'],sequence:round,limit:1}).entries[0],p=object(row?.payload)?row.payload:{};
        return {round,tick:number(p.tick),reasons:Array.isArray(p.reasons)?p.reasons.filter((r):r is string=>typeof r==='string').slice(0,8).map(r=>r.slice(0,120)):[]};
      });
      return this.clean({generation:this.generation,entries,rounds,nextCursor});
    }
    if(section==='rounds')return this.clean({generation:this.generation,...page(['started'])});
    if(section==='call'){
      const ref=integer('ref');if(!ref||ref<1)throw Error('Invalid call reference');
      const row=this.store.debugRows(room,seat,{after:ref-1,before:ref+1,limit:1,kinds:['call-reserved','commander-call-started']}).entries[0];if(!row){const strategyCalls=this.strategySummary(ref);if(!strategyCalls)throw Error('Unknown call');return this.clean({generation:this.generation,...strategyCalls,reply:this.strategyRecord(ref)?.reply??null});}
      const record=this.store.debugGetCall(room,seat,ref) as CapturedCall|null;
      const detail={generation:this.generation,...this.summary(row),reply:record?.reply??null};return record?.lane==='commander'?detail:this.clean(detail);
    }
    if(section==='content'){
      const ref=integer('ref'),offset=integer('offset',0)!,size=integer('limit',32768)!;if(!ref||size<1||size>32768)throw Error('Invalid content page');
      let value:unknown=null,truncated=false,raw=false;
      if(query.kind==='prompt'||query.kind==='reply'||query.kind==='request'){
        const record=(this.store.debugGetCall(room,seat,ref) as CapturedCall|null)??this.strategyRecord(ref);
        if(record?.bodyRetention==='summary-only')return {generation:this.generation,available:false,reason:'summary-only',text:null,nextOffset:null,truncated:false};
        if(record){raw=record.lane==='commander';value=query.kind==='prompt'?record.promptText:query.kind==='request'&&(raw||record.lane==='strategy')?{...(object(record.request)?record.request:{}),prompt:record.promptText}:query.kind==='request'?null:record.reply;truncated=record.truncated;}
      }else if(query.kind==='event')value=this.store.debugGetEvent(room,seat,ref);
      else throw Error('Invalid content kind');
      if(value===null)return {generation:this.generation,available:false,text:null,nextOffset:null,truncated:false,reason:query.kind==='event'?'not-recorded-or-over-limit':'not-recorded'};
      const cleaned=raw?value:this.clean(value),text=typeof cleaned==='string'?cleaned:JSON.stringify(cleaned,null,raw?2:undefined);
      if(offset>text.length)throw Error('Invalid content offset');
      return {generation:this.generation,available:true,text:text.slice(offset,offset+size),nextOffset:offset+size<text.length?offset+size:null,truncated};
    }
    const observed=this.store.latest<import('../../../../contracts/src/index.js').PlayerObservation>(room,seat,'wake-observation')??this.store.latest<{observed?:import('../../../../contracts/src/index.js').PlayerObservation}>(room,seat,'wake-state')?.observed??this.store.baseline(room,seat);
    if(section==='live'){
      const events=this.store.debugRows(room,seat,{limit:24,kinds:['started','completed','paused','error','tool-intent','tool-result','tool-rejected','tool-unknown','write-reconciled',this.modeEvent('task-dispatched'),this.modeEvent('task-failed'),this.modeEvent('task-skipped'),this.modeEvent('background-settled'),this.modeEvent('validation'),this.modeEvent('search-failed'),this.modeEvent('decision')]}).entries;
      return this.clean({generation:this.generation,round:this.state.sequence,observedTick:observed?.view.tick??null,names:observed?.outpostNames??{},
        strategyDetails:this.modeDiagnostics(observed??undefined).strategyDetails??null,directive:null,tasks:[],intents:[],decision:null,operations:[],...this.modeDiagnostics(observed??undefined).live as Record<string,unknown>,
        events:events.map(e=>{const p=object(e.payload)?e.payload:{};return {id:e.id,kind:e.kind,summary:String(p.summary??p.reason??(Array.isArray(p.reasons)?p.reasons.join('；'):null)??p.status??p.kind??'').slice(0,500),tool:typeof p.tool==='string'?p.tool:null,round:typeof p.sequence==='number'?p.sequence:null};})});
    }
    const outpostNames=observed?.outpostNames??{};
    if(section==='notebook'||section==='reminders'){
      if(query.scope!==undefined&&!['current','history'].includes(query.scope))throw Error('Invalid scope');
      const kinds=section==='notebook'?['notebook-set','notebook-removed']:['reminder-set','reminder-cancelled','reminder-fired'];
      const rows=query.scope==='history'?this.store.debugRows(room,seat,{before,limit,kinds}):this.store.debugEntityPage(room,seat,section,before,limit,section==='reminders');
      let entries=rows.entries;
      if(section==='notebook'&&query.scope!=='history'){
        const seconds=observed?observed.view.tick*600+observed.secondsSinceLastTick:null;
        entries=rows.entries.map(entry=>{
          const note=object(entry.payload)?entry.payload:{},record=object(note.record)?note.record:{};
          const expired=seconds!==null&&typeof note.expiresAt==='number'&&note.expiresAt<=seconds;
          return {...entry,archived:expired||isClosedMemoryStatus(record.status),...(expired?{archiveReason:'expired'}:isClosedMemoryStatus(record.status)?{archiveReason:'closed'}:{})};
        });
      }
      if(section==='reminders'&&query.scope!=='history')entries=entries.map(entry=>({...entry,archived:entry.kind!=='reminder-set',...(entry.kind!=='reminder-set'?{archiveReason:'closed'}:{})}));
      const overview=section==='notebook'&&query.scope!=='history'&&before===Number.MAX_SAFE_INTEGER?
        {roundMaterials:roundMaterialSummary(this.store.latest<{workset:unknown}>(room,seat,'round-workset')?.workset,observed),memory:{strategy:this.state.memory.strategy},commanderDirectives:structuredClone(this.state.commanderDirectives??{version:0,text:""}),capacity:observed?(()=>{
          const active=this.store.notebook(room,seat,observed.view.tick*600+observed.secondsSinceLastTick);
          return {characters:active.reduce((sum,n)=>sum+n.text.length,0),entries:active.length,characterLimit:NOTEBOOK_CHARACTERS,entryLimit:NOTEBOOK_ENTRIES,strategyCharacters:this.state.memory.strategy.length,strategyLimit:STRATEGY_CHARACTERS};
        })():null}:undefined;
      const screeningRow=section==='notebook'&&query.scope!=='history'&&before===Number.MAX_SAFE_INTEGER?this.store.latest<{report?:import('../analysis/attack-screening.js').AttackScreeningReport}>(room,seat,'attack-screening'):null;
      const screening=screeningRow?.report;
      const attackScreening=screening?{basisRevision:screening.basisRevision,observedTick:screening.observedTick,current:observed?.revision===screening.basisRevision,
        ranked:screening.ranked.map(p=>({target:p.target,name:p.name,owner:p.owner,type:p.type,score:p.score,confidence:p.confidence,assessment:p.assessment,tags:p.tags,reasons:p.reasons,attackMargin:p.attackMargin,additionalForceEstimate:p.additionalForceEstimate,components:p.components,valueBreakdown:p.valueBreakdown,timing:p.timing,existingOperation:p.existingOperation,contested:p.contested})),
        excluded:screening.excluded.map(p=>({target:p.target,reason:p.reason}))}:undefined;
      const modeDetails=section==='notebook'&&query.scope!=='history'&&before===Number.MAX_SAFE_INTEGER?this.modeDiagnostics(observed??undefined):{};
      const executionHistory=section==='notebook'&&query.scope!=='history'&&before===Number.MAX_SAFE_INTEGER?actionHistory(this.store.debugActionRows(room,seat)):undefined;
      return this.clean({generation:this.generation,scope:query.scope??'current',...rows,entries,outpostNames,...overview?{overview,...(this.contextMemory?{contextMemory:this.contextMemory(observed??undefined)}:{})}:{},...attackScreening?{attackScreening}:{},...modeDetails,...executionHistory?{executionHistory}:{}});
    }
    if(section==='campaigns'){
      if(query.scope!==undefined&&!['current','history'].includes(query.scope))throw Error('Invalid scope');
      const rows=query.scope==='history'?page(['campaign-state']):{...this.store.debugRows(room,seat,{kinds:['campaign-state'],limit:1}),nextCursor:null};
      return this.clean({generation:this.generation,scope:query.scope??'current',...rows,outpostNames});
    }
    if(section==='events'){
      if(from!==undefined||to!==undefined)throw Error('Event wall timestamps are not uniformly recorded; filter calls by time');
      const kinds=['tool-intent','tool-result','tool-rejected','usage','call-reserved','call-completed','call-failed','completed','error','runtime-error','paused','started',this.modeEvent('model-call'),this.modeEvent('task-dispatched'),this.modeEvent('task-failed'),this.modeEvent('task-skipped'),this.modeEvent('usage')];
      const bounds:{after?:number;before?:number}|null=round===undefined?{}:this.store.debugRoundBounds(room,seat,round);if(!bounds)return {generation:this.generation,entries:[],nextCursor:null};
      return this.clean({generation:this.generation,...this.store.debugRows(room,seat,{...bounds,before:Math.min(before,bounds.before??Number.MAX_SAFE_INTEGER),limit,kinds})});
    }
    throw Error('Unknown diagnostics section');
  }
  private currentCampaigns():Campaign[]{
    const row=this.store.debugRows(this.state.roomId,this.state.lobbySeat,{kinds:['campaign-state'],limit:1}).entries[0];
    if(row?.unavailable)throw Error('Campaign state exceeds diagnostic limit');
    return object(row?.payload)&&Array.isArray(row.payload.plans)?row.payload.plans as Campaign[]:[];
  }
  exportSnapshot():DiagnosticSnapshot{return this.store.debugReadTransaction(()=>this.snapshot());}
  private snapshot():DiagnosticSnapshot{
    const readAll=(section:'notebook'|'reminders')=>{
      const result:unknown[]=[];let before=Number.MAX_SAFE_INTEGER;
      for(let pages=0;pages<11;pages++){
        const page=this.store.debugEntityPage(this.state.roomId,this.state.lobbySeat,section,before,100);
        if(page.entries.some(e=>e.unavailable))throw Error('Snapshot content exceeds limit');
        result.push(...page.entries.map(e=>e.payload));if(result.length>1000)throw Error('Snapshot entry limit exceeded');
        if(page.nextCursor===null)return result;before=page.nextCursor;
      }
      throw Error('Snapshot entry limit exceeded');
    };
    const snapshot=this.clean({state:structuredClone(this.state),notebook:readAll('notebook') as NotebookEntry[],reminders:readAll('reminders') as AiReminder[],campaigns:this.currentCampaigns()});
    if(Buffer.byteLength(JSON.stringify(snapshot))>1048576)throw Error('Snapshot size limit exceeded');
    return snapshot;
  }
}
