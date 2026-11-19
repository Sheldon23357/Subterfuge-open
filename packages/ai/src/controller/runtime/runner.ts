import {LocalBasisChanged} from '../contracts/local-basis.js';
import {runBackgroundModel} from './background-model.js';
import type {BotModeResolver} from '../contracts/bot-mode.js';
import {maintainActivity,type MechanicalKeepaliveOptions} from './mechanical-keepalive.js';
import {recoverBatchOutcome} from '../execution/batch-recovery.js';
import {restoreRoundWorkset,recoverRoundBatch,unresolvedRoundCommands} from '../execution/round-workset.js';
import {ContextBudgetError} from '../contracts/context-budget.js';
import {observeReceipts,reduceReceiptJournal,restoreReceiptObservations,receiptObservationKind,receiptObserverAlerts,compactReceiptObservations,type ReceiptObservationState} from '../execution/receipt-observation.js';
import {journalPayload} from '../storage/journal-events.js';
import { errorDiagnostic } from '../../../../contracts/src/index.js';
import { type CoalescedArrival } from '../observation/arrival-coalescing.js';
import { AttackScreeningConfigError } from '../analysis/attack-screening-config.js';
import {StaleAnalysisResultError} from '../analysis/analysis-efficiency.js';
import { chatWake,type ChatHandled } from '../observation/chat-wake.js';
import { runDecisionLoop } from './decision-loop.js';
import {sendCommunication,type CommunicationWrite} from './communication.js';
import { makeTask } from './decision.js';
import {restoreDecisionSignal,restoreDecisionTask} from '../contracts/decision-task-validation.js';
import {recoverySignals} from './decision-recovery.js';
import { type DepartureReview } from '../observation/departure-confirmation.js';
import { shortFleetReferences } from '../presentation/fleet-labels.js';
import { GameRequestError,GameTransportError } from "../transport/gateway.js";
import { collectObservation } from '../observation/observation-collector.js';
import { ProviderError } from '../contracts/provider-error.js';
import { recoveryDelay } from './recovery.js';
import type { DecisionHost } from './runner-host.js';
import { RunnerState } from './runner-state.js';
import type {RunnerRepository} from "../storage/store-interfaces.js";
import type { DecisionSignal,DecisionTask,DeferredEvent } from '../contracts/types.js';
import {
gameSeconds,
type AgentProvider,
type AiSnapshot,
type AiState,
type GameGateway,
} from "../contracts/types.js";
import { reducePendingWake,takePendingNotices } from './wake-reducer.js';

export const DEFAULT_EVENT_COALESCE_MS=15_000;
export interface SeatPollOptions {
  /** Event observer may ingest facts/background inputs without admitting a decision. */
  observeOnly?:boolean;
  /** Feed and flush background diplomacy without collecting a foreground wake. */
  backgroundOnly?:boolean;
  oneRoundPerTick?:boolean;
  beforeDecision?:()=>Promise<void>;
  /** Positive wall-time window from the first pending event, not a polling interval.
   * A scheduler override applies only to this poll and is never persisted. */
  eventCoalesceMs?:number;
}

export class ControllerSeatRunner {
  private readonly runtime=new RunnerState();
  startReadinessTiming(ready:boolean){return this.runtime.pipeline.start(ready?'readiness':'sync',this.runtime.observed?.view.tick??null);}
  private searchProgress:import('../../../../contracts/src/index.js').BotRuntimeTelemetry['search']=null;
  get telemetry():import('../../../../contracts/src/index.js').BotRuntimeTelemetry {
    const pipeline=this.runtime.pipeline?.read();
    return {...(pipeline?{pipeline}:{}),background:this.background?.activity??{active:0,queued:0},round:this.state.sequence,phase:this.runtime.phase,tool:this.runtime.activeTool?.tool??null,tick:this.runtime.observed?.view.tick??null,pendingSignals:this.runtime.signals.size,search:this.searchProgress?.sequence===this.state.sequence?this.searchProgress:null};
  }
  private background:import('../contracts/bot-mode.js').BotBackground|undefined;
  private backgroundMode:string|undefined;
  private backgroundRevision=0;
  private backgroundUnread=false;
  private backgroundController:AbortController|null=null;
  get backgroundPending(){return this.backgroundUnread;}
  /** Local publication wake only; never a server observation or decision-input version. */
  get backgroundWakeRevision(){return this.backgroundRevision;}
  private saveBackground(events:{kind:string;details:unknown}[]){
    const fresh=this.store.localDecisionView(this.state.roomId,this.state.lobbySeat,0),state={...this.state,memory:fresh.state?.memory??this.state.memory};
    if(fresh.state?.commanderDirectives)state.commanderDirectives=fresh.state.commanderDirectives;else delete state.commanderDirectives;
    this.store.saveEvents(state,events,undefined,fresh.basis,{preserveMemory:true});
  }
  private observeBackground(snapshot:AiSnapshot){
    const mode=this.resolveMode(this.state.settings,this.state);
    if(this.backgroundMode!==mode.id){this.background?.pause();this.background=undefined;this.backgroundMode=mode.id;}
    if(!this.background&&mode.createBackground){
      const kind=(name:string)=>{if(!/^[a-z][a-z0-9-]{0,63}$/.test(name))throw Error('Invalid background record');return mode.recordPrefix+'-'+name;};
      this.background=mode.createBackground({state:this.state,
        receipt:id=>this.store.queryResult(this.state.roomId,this.state.lobbySeat,id),
        fail:error=>{this.state.enabled=false;this.state.status='error';this.state.error='后台战略状态保存失败，已停止席位，需检查私有运行记录';this.runtime.controller?.abort();this.background?.pause();try{this.store.saveEvents(this.state,[{kind:mode.recordPrefix+'-storage-failed',details:{cause:errorDiagnostic(error)}}],undefined,undefined,{preserveMemory:true});}catch{console.error('Background persistence failed; seat stopped.');}},
        model:{step:request=>{if(!mode.usesModelProvider)throw Error('This strategy does not declare model capability');return runBackgroundModel(this.state,this.provider,request,(name,details)=>{this.saveBackground([{kind:kind(name),details}]);});}},
        latest:<T>(name:string)=>this.store.latest<T>(this.state.roomId,this.state.lobbySeat,kind(name))??undefined,
        record:(name,details)=>{this.saveBackground([{kind:kind(name),details}]);},
        wake:()=>{if(!this.state.enabled)return;this.runtime.signals.set('background-update',{key:'background-update',kind:'campaign-review',category:'strategy',reason:'后台战略或外交更新待处理',entities:[],urgent:true});this.backgroundRevision++;},
      });
    }
    this.background?.observe(snapshot);
  }
  resetStrategy(){
    if(this.settling||this.state.enabled)throw Error('Fully pause strategy before replacing it');
    this.background?.pause();this.background=undefined;this.backgroundMode=undefined;
    this.requestMemoryReview();
  }
  async drainBackground(){await this.background?.drain();}

  private receiptObservations:ReceiptObservationState;
  get hasUnresolvedWrites(){return this.receiptObservations.pendingWrites.length>0||this.runtime.inFlight!==null;}
  private lastSavedWakeObservation:string|null=null;
  /** A completed idle poll must cover the current world and visible chat version. */
  readyToAdvance(tick:number,version?:string){return !this.runtime.busy&&!this.runtime.observing&&this.runtime.checkedTick>=tick&&(this.runtime.deferredDecisionTick===tick||this.runtime.pendingSince===null&&this.runtime.signals.size===0)&&this.runtime.inFlight===null&&this.receiptObservations.pendingWrites.length===0&&this.state.status==='waiting'&&(version===undefined||this.runtime.checkedAdvanceVersion===version);}
  /** Only the completed observer's basis may acknowledge an external clock. */
  advanceReadiness(){
    if(!this.runtime.observed||!this.runtime.latestSnapshot||!this.readyToAdvance(this.runtime.observed.view.tick)||this.runtime.latestSnapshot.hasMore)return null;
    return {tick:this.runtime.observed.view.tick,revision:this.runtime.observed.revision,chatCursor:this.runtime.latestSnapshot.chatCursor};
  }
  /** Close admission before sending readiness, including ticks with no decision.
   * A lost acknowledgement or restart may retry readiness, never reopen work. */
  closeForeground(tick:number){
    if(!this.readyToAdvance(tick)||this.runtime.observed?.view.tick!==tick)throw Error('Cannot close unfinished foreground work');
    const closed=this.store.latest<{tick:number}>(this.state.roomId,this.state.lobbySeat,'foreground-closed');
    if(closed?.tick!==tick)this.saveWake(true,[{kind:'foreground-closed',details:{tick}}]);
    this.runtime.deferredDecisionTick=tick;
  }
  private host():DecisionHost{return {mode:this.resolveMode(this.state.settings,this.state),state:this.state,store:this.store,gateway:this.gateway,provider:this.provider,receiptState:()=>structuredClone(this.receiptObservations),
    saveEvents:events=>this.saveWithObservers(events,this.runtime.localDecisionBasis),
    save:(kind,details)=>this.save(kind,details),saveWake:()=>this.saveWake(),collect:(snapshot,ownEffects)=>this.collect(snapshot,ownEffects),
    mergePending:(snapshot,task)=>this.mergePending(snapshot,task),beginObservationBarrier:()=>this.beginObservationBarrier(),diagnostic:(error,phase)=>this.diagnostic(error,phase)};}
  private failurePhase(){return this.runtime.phase;}
  private diagnostic(error:unknown,phase=this.failurePhase()){return {
    at:new Date().toISOString(),phase,sequence:this.state.sequence,
    ...(this.runtime.observed?{tick:this.runtime.observed.view.tick,revision:this.runtime.observed.revision}:{}),
    ...(this.runtime.activeTool&&phase==='tool'?{tool:this.runtime.activeTool}:{}),
    ...((error instanceof GameTransportError||error instanceof GameRequestError)&&error.diagnostic?{request:error.diagnostic}:{}),
    ...(error instanceof ProviderError&&error.diagnostic?{provider:error.diagnostic}:{}),
    cause:errorDiagnostic(error,true)};}
  constructor(
    readonly state: AiState,
    private store: RunnerRepository,
    private gateway: GameGateway,
    private provider: AgentProvider & import('../contracts/types.js').LocalComputation,
    private readonly pollIntervalMs=5000,
    private readonly maintenance:MechanicalKeepaliveOptions={},
    private readonly resolveMode:BotModeResolver,
  ) {
    gateway.factBaseline?.(current=>{
      const provided=store.latest<AiSnapshot['observation']>(state.roomId,state.lobbySeat,'decision-observation');
      let base:import('../observation/activity-facts.js').FactBaseline;
      if(provided)base={roomId:provided.roomId,player:provided.view.player,activityCursor:provided.activityCursor,manualVersion:provided.manualCommands?.version};
      else{
        // Save the initial tail cuts BEFORE any read or provider dispatch. A
        // failed first reply and process restart must not consume later facts.
        let origin=store.latest<{roomId:string;player:number;cursor:number;manualVersion?:number}>(state.roomId,state.lobbySeat,'activity-facts-origin');
        if(!origin){
          // Active protections may append isolated old receipts to the tail.
          // They must not turn a fresh binding into a whole-match backfill.
          let manualOrigin=current.manualCommands?.version;
          const manualVersions=new Set(current.manualCommands?.receipts.map(receipt=>receipt.version));
          while(manualOrigin!==undefined&&manualOrigin>0&&manualVersions.has(manualOrigin))manualOrigin--;
          origin={roomId:current.roomId,player:current.view.player,cursor:current.activity?.[0]?.id??current.activityCursor??0,
            ...(manualOrigin!==undefined?{manualVersion:manualOrigin}:{})};
          if(!Number.isSafeInteger(origin.cursor)||origin.cursor<0||origin.cursor>(current.activityCursor??0)||
            current.manualCommands&&(!Number.isSafeInteger(origin.manualVersion)||origin.manualVersion!<0||origin.manualVersion!>current.manualCommands.version))throw Error('Invalid initial fact origin');
          this.saveWithObservers([{kind:'activity-facts-origin',details:origin}]);
        }
        if(origin.roomId!==current.roomId||origin.player!==current.view.player||!Number.isSafeInteger(origin.cursor)||origin.cursor<0)throw Error('Invalid persisted activity origin');
        base={roomId:origin.roomId,player:origin.player,activityCursor:origin.cursor,manualVersion:origin.manualVersion};
      }
      if(current.manualCommands){
        if(typeof base.manualVersion!=='number'||!Number.isSafeInteger(base.manualVersion)||base.manualVersion<0)throw Error('Invalid persisted manual fact origin');
        const pending=store.pendingManualFacts(state.roomId,state.lobbySeat);
        if(pending.some(receipt=>receipt.player!==current.view.player))throw Error('Pending manual facts belong to another player');
        base.manualFacts=pending;
      }
      return base;
    });
    this.receiptObservations=restoreReceiptObservations(store,state.roomId,state.lobbySeat);
    state.memory=shortFleetReferences(state.memory);
    const pending=store.latest<{signals:DecisionSignal[];deferred:DeferredEvent[];coalescedArrivals?:CoalescedArrival[];departureReviews?:DepartureReview[];observed?:AiSnapshot['observation'];inFlight?:DecisionTask|null;notices?:import('../../../../contracts/src/index.js').PlayerNotification[]}>(state.roomId,state.lobbySeat,'wake-state');
    const persistedWakeObservation=store.latest<AiSnapshot['observation']>(state.roomId,state.lobbySeat,'wake-observation');
    this.runtime.observed=persistedWakeObservation??pending?.observed??store.baseline(state.roomId,state.lobbySeat);
    const recoveredRound=this.runtime.observed?restoreRoundWorkset(store.latest<{workset:unknown}>(state.roomId,state.lobbySeat,'round-workset')?.workset,this.runtime.observed):null;
    this.receiptObservations=restoreReceiptObservations(store,state.roomId,state.lobbySeat,unresolvedRoundCommands(recoveredRound),recoveredRound?.player);
    this.receiptObservations=this.compactObservers(this.receiptObservations);
    this.lastSavedWakeObservation=persistedWakeObservation?JSON.stringify(persistedWakeObservation):null;
    for(const [index,raw] of (pending?.signals??[]).entries()){const signal=restoreDecisionSignal(raw,`wake-state.signals[${index}]`);this.runtime.signals.set(signal.key,signal);}
    for(const arrival of pending?.coalescedArrivals??[]){const signal=restoreDecisionSignal(arrival.signal,'wake-state.coalescedArrivals.signal');this.runtime.coalescedArrivals.set(signal.key,{...arrival,signal});}
    for(const event of pending?.deferred??[])this.runtime.deferred.set(event.key,event);
    for(const notice of pending?.notices??[])this.runtime.pendingNotices.set(notice.id,notice);
    const completed=store.latest<{reason?:string;sequence?:number}>(state.roomId,state.lobbySeat,'completed');
    if(!pending?.inFlight&&completed?.reason==='finished')this.runtime.departureReviews=(pending?.departureReviews??[]).filter(r=>r.sequence===completed.sequence&&r.roomId===state.roomId&&r.player===this.runtime.observed?.view.player);
    if(completed?.reason==='time-budget-yield'&&!this.runtime.signals.has('continuation'))this.runtime.signals.set('continuation',{key:'continuation',kind:'recovery',sources:[{kind:'runtime',id:'time-budget-yield'}],category:store.latest<DecisionTask>(state.roomId,state.lobbySeat,'started')?.category??'plan',reason:'上一轮达到时限，复核接受回执后自动续办未完成事项',entities:[],urgent:false});
    if(pending?.inFlight){
      const task=restoreDecisionTask(pending.inFlight,'wake-state.inFlight');
      for(const signal of recoverySignals(task,'interrupted','上轮决策中断：先核对已接受回执，再继续未完成事项，禁止重复出兵',true))this.runtime.signals.set(signal.key,signal);
      for(const event of task.deferred)if(!this.runtime.deferred.has(event.key))this.runtime.deferred.set(event.key,event);
    }
  }
  private wakePayload(){return journalPayload('wake-state',{signals:[...this.runtime.signals.values()],deferred:[...this.runtime.deferred.values()],coalescedArrivals:[...this.runtime.coalescedArrivals.values()],departureReviews:this.runtime.departureReviews,inFlight:this.runtime.inFlight,notices:[...this.runtime.pendingNotices.values()]});}
  private wakeObservationEvents():{kind:string;details:unknown}[]{
    const observed=this.runtime.observed;if(!observed)return [];
    const encoded=JSON.stringify(observed);
    return encoded===this.lastSavedWakeObservation?[]:[{kind:'wake-observation',details:observed}];
  }
  private saveWake(external=false,events:{kind:string;details:unknown}[]=[]){
    // External authority changes must not replace an in-flight model's CAS basis.
    const details=this.wakePayload();
    if(external){
      // Wake records own scheduling, not private strategy or commander authority.
      // Preserve both from one durable snapshot, and reject a concurrent writer
      // rather than silently refreshing the in-flight model's old CAS basis.
      const fresh=this.store.localDecisionView(this.state.roomId,this.state.lobbySeat,0);
      const next={...this.state,memory:fresh.state?.memory??this.state.memory};
      if(fresh.state){if(fresh.state.commanderDirectives)next.commanderDirectives=fresh.state.commanderDirectives;else delete next.commanderDirectives;}
      const rows=[...this.wakeObservationEvents(),...events,{kind:'wake-state',details}];
      this.store.saveEvents(next,rows,undefined,fresh.basis,{preserveMemory:true});
      this.lastSavedWakeObservation=this.runtime.observed?JSON.stringify(this.runtime.observed):null;
      this.state.memory=next.memory;
      if(next.commanderDirectives)this.state.commanderDirectives=next.commanderDirectives;else delete this.state.commanderDirectives;
    }else this.saveWithObservers([...events,{kind:'wake-state',details}],this.runtime.localDecisionBasis);
  }
  private beginObservationBarrier(){
    this.runtime.observationGeneration++;
    let release!:()=>void;
    this.runtime.observationBarrier=new Promise<void>(resolve=>{release=resolve;});
    return ()=>{this.runtime.observationGeneration++;this.runtime.observationBarrier=null;release();};
  }
  /** Observation continues during model work. Queue ownership is transferred
   * only at model boundaries; completion never clears newly queued signals. */
  private collect(snapshot:AiSnapshot,ownEffects=false){
    this.runtime.pipeline.scope(snapshot.observation.view.tick);
    // Some interrupted batches have no saved observation. Defer exact-ID
    // receipt recovery until the first authorized view can validate the round.
    if(!this.runtime.observed){
      const workset=restoreRoundWorkset(this.store.latest<{workset:unknown}>(this.state.roomId,this.state.lobbySeat,'round-workset')?.workset,snapshot.observation);
      if(workset)this.receiptObservations=restoreReceiptObservations(this.store,this.state.roomId,this.state.lobbySeat,unresolvedRoundCommands(workset),workset.player);
    }
    // Persist outside the model's CAS basis, retaining the old basis so an
    // in-flight model cannot silently overwrite newly recorded human authority.
    const changed=this.store.observeManualCommands(this.state.roomId,this.state.lobbySeat,snapshot.observation);
    const observerHost=this.host();
    if(changed){
      observerHost.save=(kind,details)=>{
        const fresh=this.store.localDecisionView(this.state.roomId,this.state.lobbySeat,0),saved=fresh.state??this.state;
        const next={...this.state,memory:saved.memory};
        if(saved.commanderDirectives)next.commanderDirectives=saved.commanderDirectives;else delete next.commanderDirectives;
        this.store.save(next,kind,details,fresh.basis);
      };
      observerHost.saveWake=()=>this.saveWake(true);
    }
    collectObservation(observerHost,this.runtime,snapshot,ownEffects||changed);
    if(this.runtime.observed!==snapshot.observation)return;
    const next=observeReceipts(this.receiptObservations,snapshot.observation);
    if(next!==this.receiptObservations)this.saveWithObservers([],undefined,next);
  }
  /** Original source receipts and the derived cursor commit in one journal
   * transaction. Restarts can also reconstruct from original historical rows. */
  private saveWithObservers(events:{kind:string;details:unknown}[],expectedBasis?:string,next=this.receiptObservations){
    for(const e of events)next=reduceReceiptJournal(next,e.kind,e.details,this.runtime.observed??undefined);
    next=this.compactObservers(next,events);
    const changed=JSON.stringify(next)!==JSON.stringify(this.receiptObservations);
    const alerts=receiptObserverAlerts(this.receiptObservations,next);
    for(const r of alerts)this.runtime.signals.set(`receipt-observer:${r.id}`,{key:`receipt-observer:${r.id}`,kind:'execution-failure',sources:[{kind:'runtime',id:r.id}],category:'plan',reason:`系统事实观察异常：${r.reason??r.state}；仅提供事实，不完成战略义务`,entities:r.predicate.kind==='fleet-state'?[r.predicate.fleetId]:[],urgent:true});
    const persistsWake=events.some(event=>event.kind==='wake-state')||alerts.length>0;
    const wakeObservationEvents=persistsWake?this.wakeObservationEvents():[];
    const rows=[...wakeObservationEvents,...events,...(changed?[{kind:receiptObservationKind,details:next}]:[]),...(alerts.length?[{kind:'wake-state',details:this.wakePayload()}]:[])];
    try{
      if(rows.length){
        const memorySubmitted=events.some(event=>event.kind==='memory-maintained');
        const saved=this.store.saveEvents(this.state,rows,undefined,expectedBasis,{preserveMemory:!memorySubmitted});
        this.state.memory=saved.memory;
      }
    }catch(error){
      // All atomic journal writes need the same conflict handling as a single
      // save. The rejected event is never retried: only refresh private state
      // so the caller can safely record the failure without overwriting it.
      if(error instanceof LocalBasisChanged){
        const fresh=this.store.localDecisionView(this.state.roomId,this.state.lobbySeat,0);
        this.runtime.localDecisionBasis=fresh.basis;
        const saved=fresh.state;
        if(saved){this.state.memory=saved.memory;if(saved.commanderDirectives)this.state.commanderDirectives=saved.commanderDirectives;else delete this.state.commanderDirectives;}
      }
      throw error;
    }
    this.receiptObservations=next;
    if(wakeObservationEvents.length)this.lastSavedWakeObservation=JSON.stringify(this.runtime.observed);
    const requestIds=events.filter(e=>['tool-result','tool-rejected','write-reconciled','batch-recovered'].includes(e.kind))
      .map(e=>(e.details as {id?:unknown})?.id).filter((id):id is string=>typeof id==='string');
    if(requestIds.length){
      const mode=this.resolveMode(this.state.settings,this.state);
      const kind=(name:string)=>{if(!/^[a-z][a-z0-9-]{0,63}$/.test(name))throw Error('Invalid receipt projection record');return mode.recordPrefix+'-'+name;};
      mode.onReceipt?.({requestIds,
        latest:<T>(name:string)=>this.store.latest<T>(this.state.roomId,this.state.lobbySeat,kind(name))??undefined,
        record:(name,details)=>{this.saveBackground([{kind:kind(name),details}]);},
        attemptReceipt:(name,id)=>this.store.modeReceipt?.(this.state.roomId,this.state.lobbySeat,kind(name),id),
        wake:()=>{if(this.state.enabled){this.runtime.signals.set('background-update',{key:'background-update',kind:'campaign-review',category:'strategy',reason:'协议回执已确认，处理后续意图',entities:[],urgent:true});this.backgroundRevision++;}},
      });
    }

  }
  private compactObservers(next:ReceiptObservationState,events:{kind:string;details:unknown}[]=[]){
    const update=[...events].reverse().find(event=>event.kind==='round-workset');
    const raw=update?(update.details as {workset:unknown}).workset:this.store.latest<{workset:unknown}>(this.state.roomId,this.state.lobbySeat,'round-workset')?.workset;
    const observation=this.runtime.observed;
    if(!observation&&raw)return next; // Validate scope on the first authorized snapshot before releasing evidence.
    const workset=observation?restoreRoundWorkset(raw,observation):null;
    return compactReceiptObservations(next,unresolvedRoundCommands(workset));
  }
  private takeNotices(snapshot:AiSnapshot){return takePendingNotices(this.runtime,snapshot);}
  private mergePending(snapshot:AiSnapshot,task:DecisionTask){return reducePendingWake(this.host(),this.runtime,snapshot,task,!this.resolveMode(this.state.settings,this.state).backgroundHandlesChat);}
  requestMemoryReview(){
    this.runtime.signals.set('memory-review',{key:'memory-review',kind:'memory-review',sources:[{kind:'user',id:'memory-review'}],category:'strategy',reason:'用户要求依据当前授权事实整理笔记与战略，保留必要参数及重新评估条件',entities:[],urgent:true});
    this.saveWake(true);
  }
  pause() {
    this.background?.pause();this.backgroundController?.abort();
    this.runtime.recoveryAt=null;this.runtime.recoveryAttempts=0;
    if(this.runtime.inFlight){
      for(const signal of recoverySignals(this.runtime.inFlight,'interrupted','上轮暂停：先核对已接受回执，再继续未完成事项',true))this.runtime.signals.set(signal.key,signal);
      for(const event of this.runtime.inFlight.deferred)if(!this.runtime.deferred.has(event.key))this.runtime.deferred.set(event.key,event);
      this.saveWake();
    }
    this.state.enabled = false;
    if(this.state.status!=="ended")this.state.status = "paused";
    this.runtime.controller?.abort();
    this.store.save(this.state, "paused");
  }
  private save(kind: string, details: unknown = null) {
    // Transient display samples must not mutate durable game or audit state.
    if(kind.endsWith('-search-progress')){const sample=details as {sequence:number;progress:import('../../../../contracts/src/index.js').BotSearchProgress};this.searchProgress={sequence:sample.sequence,at:Date.now(),progress:sample.progress};return;}
    if(/-(search|decision|search-failed)$/.test(kind))this.searchProgress=null;
    this.saveWithObservers([{kind,details}],this.runtime.localDecisionBasis);

  }
  /** Background input and diplomacy never own the foreground observation gate. */
  async pollBackground(){
    const s=this.state;if(!s.enabled||this.backgroundController)return;
    const controller=new AbortController();this.backgroundController=controller;
    try{
      const snapshot=await this.gateway.snapshot(s.chatCursor,s.notificationCursor,true);
      if(!s.enabled||controller.signal.aborted)return;
      this.observeBackground(snapshot);this.backgroundUnread=!!snapshot.hasMore;
      const mode=this.resolveMode(s.settings,s);
      if(mode.backgroundHandlesChat&&s.chatCursor<snapshot.chatCursor){s.chatCursor=snapshot.chatCursor;this.saveBackground([]);}
      if(!mode.communicate)return;
      const kind=(name:string)=>{if(!/^[a-z][a-z0-9-]{0,63}$/.test(name))throw Error('Invalid communication record');return mode.recordPrefix+'-'+name;};
      const latest=<T>(name:string)=>this.store.latest<T>(s.roomId,s.lobbySeat,kind(name))??undefined;
      const record=(name:string,details:Record<string,unknown>)=>{this.saveBackground([{kind:kind(name),details}]);};
      await mode.communicate({state:s,snapshot,latest,record,wake:()=>{this.backgroundRevision++;},send:async(id,args)=>{
        const run=async()=>{const previous=latest<CommunicationWrite>('communication-write');const result=await sendCommunication({state:s,snapshot,gateway:this.gateway,signal:controller.signal,
          latest:()=>latest<CommunicationWrite>('communication-write'),save:write=>record('communication-write',write as unknown as Record<string,unknown>),
          guard:arguments_=>mode.beforeExecute?.({state:s,snapshot,tool:'say',arguments:arguments_,latest}),},id,args);
          if(result.status==='accepted'&&!(previous?.requestId===id&&previous.status==='accepted'))this.backgroundRevision++;
          return result;};
        const context={turn:`communication:${id}`,deadline:Date.now()+15000,signal:controller.signal,revision:snapshot.observation.revision,instructionsVersion:s.commanderDirectives?.version??0};
        if(this.gateway.withWriteContext)return this.gateway.withWriteContext(context,run);
        this.gateway.writeContext?.(context);try{return await run();}finally{this.gateway.writeContext?.(null);}
      }});
    }catch(error){this.backgroundUnread=false;throw error;}finally{if(this.backgroundController===controller)this.backgroundController=null;}
  }
  /** Wall time coalesces events; all strategic deadlines use game time. */
  async poll(wallMs = Date.now(), force = false, refreshForAdvance = false, options:SeatPollOptions = {}): Promise<void> {
    if(options.backgroundOnly){await this.pollBackground();return;}
    const eventCoalesceMs=options.eventCoalesceMs??DEFAULT_EVENT_COALESCE_MS;
    if(!Number.isSafeInteger(eventCoalesceMs)||eventCoalesceMs<=0)throw new RangeError('eventCoalesceMs must be a positive safe integer');
    if (
      this.runtime.observing ||
      !this.state.enabled ||
      this.state.status==='ended' ||
      (this.state.status==='error'&&(this.runtime.recoveryAt===null||wallMs<this.runtime.recoveryAt)) ||
      (wallMs - this.runtime.lastPoll < this.pollIntervalMs && !force && !refreshForAdvance)
    )
      return;
    if(this.state.status==='error'){
      this.state.status='waiting';this.state.error=null;this.runtime.recoveryAt=null;
      this.save('recovery-started',{attempt:this.runtime.recoveryAttempts,at:new Date().toISOString()});
    }else if(this.runtime.recoveryAt!==null||this.state.nextReview===0){
      // An explicit manual resume supersedes the pending recovery timer.
      this.runtime.recoveryAt=null;this.runtime.recoveryAttempts=0;
    }
    const pollStartedAt=Date.now();
    let snapshotMs=0,snapshotReads=0,decisionMs=0,admissionMs=0;
    const readSnapshot=async()=>{const started=Date.now();snapshotReads++;try{return await this.runtime.pipeline.measure('sync',this.runtime.observed?.view.tick??null,()=>this.gateway.snapshot(this.state.chatCursor,this.state.notificationCursor,options.backgroundOnly),value=>value.observation.view.tick);}finally{snapshotMs+=Date.now()-started;}};
    this.runtime.observing = true;
    if(!options.backgroundOnly)this.runtime.checkedAdvanceVersion=undefined;
    let startedThought=false,maintaining=false,preparingDecision=false;
    this.runtime.lastPoll = wallMs;
    if(!this.runtime.busy&&!options.backgroundOnly)this.runtime.phase='observation';
    try {
      const advanceVersion=this.gateway.advanceVersion?.();
      let snapshot:AiSnapshot;
      for(;;){
        // A composite poll can capture its game view before an acknowledged
        // command, then return after it while reading chat/notices. Re-read
        // after the tool settles; do not turn the old view into inverse events.
        if(this.runtime.observationBarrier)await this.runtime.observationBarrier;
        const generation=this.runtime.observationGeneration;
        snapshot=await readSnapshot();
        if(generation===this.runtime.observationGeneration&&!this.runtime.observationBarrier)break;
      }
      let checkedVersion=advanceVersion===this.gateway.advanceVersion?.()?advanceVersion:undefined;
      let now=gameSeconds(snapshot);
      const s=this.state;
      // A previously started observer must not resume an unknown write outcome.
      if(s.status==='error')return;
      if (
        snapshot.observation.view.match?.ended ||
        !snapshot.observation.view.self.active
      ) {
        this.background?.pause();this.store.endSeat(s,snapshot.observation);
        return;
      }
      if (!s.enabled) return;
      const backgroundChat=this.resolveMode(s.settings,s).backgroundHandlesChat===true;
      const chat=backgroundChat?{active:snapshot.chat,muted:[]}:chatWake(snapshot.chat,snapshot.chatPlayer,this.store.latest<ChatHandled>(s.roomId,s.lobbySeat,'chat-handled')??{},snapshot.observation.view.tick);
      if(chat.muted.length){
        this.save('chat-coalesced',{ids:chat.muted.map(m=>m.id),reason:'已处理对话的重复礼貌回执',messages:chat.muted});
        if(!chat.active.some(m=>m.from!==snapshot.chatPlayer))s.chatCursor=Math.max(s.chatCursor,snapshot.chatCursor);
        snapshot={...snapshot,chat:chat.active};
      }
      if(!options.backgroundOnly)this.collect(snapshot);
      this.observeBackground(snapshot);
      // observe() persists the incoming evidence before the transport cursor moves.
      // This acknowledges ingestion, never a diplomatic interpretation or agreement.
      if(backgroundChat&&s.chatCursor<snapshot.chatCursor){s.chatCursor=snapshot.chatCursor;this.saveWake(true);}
      if((this.runtime.busy||options.observeOnly)&&!options.backgroundOnly){this.runtime.observing=false;return;}
      const reviewPolicy=this.resolveMode(s.settings,s).tacticalReviewAfterTicks;
      const reviewAfter=typeof reviewPolicy==='function'?reviewPolicy(s.settings):reviewPolicy;
      if(!options.backgroundOnly&&reviewAfter!==undefined){
        const last=this.store.latest<{tick:number}>(s.roomId,s.lobbySeat,'tactical-search-completed');
        // World observations drive this check. Finishes, receipts and messages do not reset it.
        const due=!last||snapshot.observation.view.tick-last.tick>reviewAfter;
        if(due)this.runtime.signals.set('tactical-review',{key:'tactical-review',kind:'reminder-due',category:'plan',reason:last?`距上次战术搜索已超过${reviewAfter} tick，复查当前行动`:'尚无已完成的战术搜索，检查当前行动',entities:[],urgent:false});
        else this.runtime.signals.delete('tactical-review');
        for(const id of this.resolveMode(s.settings,s).reviewReminders??[])this.runtime.signals.delete('reminder:'+id);
      }
      if(this.receiptObservations.pendingWrites.length&&this.gateway.reconcileWrites){
        const requests=this.store.pendingWriteEvidence(s.roomId,s.lobbySeat,this.receiptObservations.pendingWrites);
        const resolutions=await this.gateway.reconcileWrites(requests);
        if(!s.enabled)return;
        const changed=resolutions.filter(r=>JSON.stringify(r)!==JSON.stringify(this.receiptObservations.resolutions?.find(old=>old.id===r.id)));
        if(changed.length)this.saveWithObservers(changed.map(details=>({kind:'write-reconciled',details})));
        if(changed.some(r=>r.status==='committed')){
          snapshot=await readSnapshot();
          if(!s.enabled)return;
          this.collect(snapshot);now=gameSeconds(snapshot);checkedVersion=undefined;
        }
      }
      // The executor is idle here. Recover complete child coverage from durable
      // journals even if the process died before the parent receipt was saved.
      for(const parent of this.store.pendingWriteEvidence(s.roomId,s.lobbySeat,this.receiptObservations.pendingWrites).filter(r=>r.tool==='batch')){
        const args=parent.arguments as {actions?:unknown[]}|undefined;
        if(!Array.isArray(args?.actions))throw Error('Invalid pending batch intent');
        const children=this.store.pendingWriteEvidence(s.roomId,s.lobbySeat,args.actions.map((_,index)=>`${parent.id}-item-${index}`));
        const result=recoverBatchOutcome(parent.id,parent.arguments,children,this.receiptObservations.resolutions??[]);
        if('result'in parent.evidence&&JSON.stringify(parent.evidence.result)===JSON.stringify(result))continue;
        const saved=restoreRoundWorkset(this.store.latest<{workset:unknown}>(s.roomId,s.lobbySeat,'round-workset')?.workset,snapshot.observation);
        const workset=saved?recoverRoundBatch(saved,parent.id,result):null;
        this.saveWithObservers([{kind:'batch-recovered',details:{id:parent.id,tool:'batch',result}},...(workset&&workset!==saved?[{kind:'round-workset',details:{workset}}]:[])]);
      }
      if((this.maintenance.mechanicalKeepalive===true||['intent','unknown','accepted'].includes(this.store.latest<{status:string}>(s.roomId,s.lobbySeat,'mechanical-keepalive-state')?.status??''))&&!this.runtime.inFlight){
        // The owning poll remains observing, so readiness, concurrent polls,
        // pause, and runtime checkpoint draining see the whole maintenance.
        const activitySignal=this.runtime.signals.get('activity');
        const activityNotices=snapshot.notifications.filter(n=>n.kind==='inactivity-warning').map(n=>n.id);
        const noUnresolvedWrites=this.receiptObservations.pendingWrites.length===0;
        maintaining=true;this.runtime.controller=new AbortController();this.runtime.phase='tool';
        this.runtime.activeTool={id:'mechanical-keepalive',tool:'order'};
        try{
          const result=await maintainActivity({state:s,store:this.store,gateway:this.gateway,options:{...this.maintenance,canMaintain:()=>noUnresolvedWrites&&this.maintenance.canMaintain?.()===true},
            beginBarrier:()=>this.beginObservationBarrier(),signal:this.runtime.controller.signal,
            saveEvents:(events,basis)=>this.saveWithObservers(events,basis)},snapshot,refreshForAdvance);
          if(result.performed){
            checkedVersion=undefined;
            snapshot={...snapshot,observation:result.observation};this.collect(snapshot,true);
            if(activitySignal&&this.runtime.signals.get('activity')===activitySignal&&result.observation.view.self.activity?.inactivityWarningCount===0){this.runtime.signals.delete('activity');for(const id of activityNotices)this.runtime.pendingNotices.delete(id);this.saveWake();}
            // Collect messages/directives/events that arrived during the write
            // before constructing any model context from the returned revision.
            if(s.enabled){snapshot=await readSnapshot();this.collect(snapshot);}
            now=gameSeconds(snapshot);
          }
        }finally{this.runtime.controller=null;}
        maintaining=false;this.runtime.activeTool=null;this.runtime.phase='observation';
        if(!s.enabled)return;
        if(snapshot.observation.view.match?.ended||!snapshot.observation.view.self.active){this.background?.pause();this.store.endSeat(s,snapshot.observation);return;}
      }
      this.runtime.observing=false;
      if(this.runtime.recoveryAttempts&&!this.runtime.signals.has('recovery')){
        this.save('recovery-completed',{attempts:this.runtime.recoveryAttempts,at:new Date().toISOString()});
        this.runtime.recoveryAttempts=0;
      }
      // Background work never owns clock readiness. A mode may finish with a
      // conservative hold while constraints are pending, using the ordinary
      // foreground fact/receipt and completion path before reporting ready.
      const incoming=!backgroundChat&&snapshot.chat.some(m=>m.from!==snapshot.chatPlayer);
      if(s.lastThought===null)this.runtime.signals.set('initial',{key:'initial',kind:'opening',sources:[{kind:'runtime',id:'initial',observedSeconds:now}],category:'strategy',reason:'首次进入对局',entities:[],urgent:true});
      if(s.nextReview===0)this.runtime.signals.set('resume',{key:'resume',kind:'resume',sources:[{kind:'runtime',id:'explicit-resume',observedSeconds:now}],category:'plan',reason:'恢复AI后重新检查',entities:[],urgent:true});
      // The existing durable admission survives a process restart. Observation,
      // background work and receipt recovery above continue after admission closes.
      const admitted=this.store.latest<{tick:number}>(s.roomId,s.lobbySeat,'started');
      const closed=this.store.latest<{tick:number}>(s.roomId,s.lobbySeat,'foreground-closed');
      this.runtime.deferredDecisionTick=options.oneRoundPerTick&&(admitted?.tick===snapshot.observation.view.tick||closed?.tick===snapshot.observation.view.tick)?snapshot.observation.view.tick:null;
      if(this.runtime.deferredDecisionTick!==null&&!force){
        // Observation and write reconciliation ran above with no active executor.
        // A paused/aborted round can leave only its recovery marker behind.
        const interrupted=this.runtime.inFlight;
        if(interrupted){
          for(const signal of recoverySignals(interrupted,'interrupted','上轮决策已中断；保留原因待下一 tick 复查，已接受操作继续按账本查账',true))this.runtime.signals.set(signal.key,signal);
          for(const event of interrupted.deferred)if(!this.runtime.deferred.has(event.key))this.runtime.deferred.set(event.key,event);
          this.runtime.inFlight=null;
        }
        this.runtime.pendingSince=null;
        this.saveWake(true,interrupted?[{kind:'interrupted-round-deferred',details:{sequence:s.sequence,tick:snapshot.observation.view.tick}}]:[]);
        if(!snapshot.hasMore)this.runtime.checkedAdvanceVersion=checkedVersion;
        return;
      }
      // A new tick reopens admission, but creates no strategic reason to run.
      // Preserve real trigger kinds so routine tactical checks stay lightweight.
      const signals=[...this.runtime.signals.values()];
      if((incoming||signals.length)&&this.runtime.pendingSince===null)this.runtime.pendingSince=wallMs;
      if(!incoming)s.chatCursor=Math.max(s.chatCursor,snapshot.chatCursor);
      if(!incoming&&!signals.length)this.runtime.pendingSince=null;
      // Observation and reconciliation may already consume the merge window.
      // Preserve the caller's scheduling clock while including time spent awaiting facts.
      const admissionWallMs=wallMs+Math.max(0,Date.now()-pollStartedAt);
      const ready=force||s.lastThought===null||s.nextReview===0||this.runtime.pendingSince!==null&&admissionWallMs-this.runtime.pendingSince>=eventCoalesceMs;
      if(!ready){if(!snapshot.hasMore)this.runtime.checkedAdvanceVersion=checkedVersion;return;}
      const reasons=incoming?['收到新消息']:force?['手动请求分析']:[];
      const taskSignals:DecisionSignal[]=[...signals,...(incoming?snapshot.chat.filter(m=>m.from!==snapshot.chatPlayer):[]).map(m=>({key:`chat:${m.from}:${m.id}`,kind:'diplomacy-message' as const,category:'diplomacy' as const,reason:'收到新消息',entities:[],urgent:false,sources:[{kind:'chat' as const,id:`${m.from}:${m.id}`,observedSeconds:now}]}))];
      if(force&&!incoming)taskSignals.push({key:'manual-analysis',kind:'unknown',category:'plan',reason:'手动请求分析',entities:[],urgent:false,sources:[{kind:'user',id:'manual-analysis',observedSeconds:now}]});
      const task=makeTask(taskSignals,reasons,[...this.runtime.deferred.values()],incoming);
      this.runtime.observing=true;
      preparingDecision=true;
      const admissionStarted=Date.now();
      try{await options.beforeDecision?.();}finally{admissionMs+=Date.now()-admissionStarted;}
      preparingDecision=false;
      if(!s.enabled)return;
      this.runtime.observing=false;
      if(options.oneRoundPerTick)this.runtime.deferredDecisionTick=snapshot.observation.view.tick;
      this.runtime.pendingSince=null;
      snapshot=this.takeNotices(snapshot);this.runtime.inFlight=task;
      this.runtime.signals.clear();this.runtime.deferred.clear();this.saveWake();
      this.runtime.busy=true;startedThought=true;
      const decisionStarted=Date.now();
      try{await this.think({...snapshot,task},task);}finally{decisionMs+=Date.now()-decisionStarted;}
    } catch(error) {
      if(error instanceof LocalBasisChanged){
        // The transaction saved nothing. Keep the new authority and unfinished
        // wake causes; the next normal round reconciles any existing receipts.
        this.state.status='waiting';this.state.error=null;this.state.nextReview=0;
        const task=this.runtime.inFlight;
        if(task){
          for(const signal of recoverySignals(task,'continuation','指令或私有资料已更新，按最新依据继续；已接受操作先查回执。',false))this.runtime.signals.set(signal.key,signal);
          for(const event of task.deferred)if(!this.runtime.deferred.has(event.key))this.runtime.deferred.set(event.key,event);
          this.runtime.inFlight=null;
        }
        this.save('decision-superseded',{sequence:this.state.sequence,reason:'local-basis-changed'});
        this.saveWake();return;
      }
      // Scheduler admission is not a started decision. Preserve its transport
      // error and operation label for the owner to recover the lease safely.
      if(preparingDecision)throw error;
      if(this.runtime.busy&&!startedThought){this.save('observation-error',{reason:'观察暂时失败，保留队列待重试',diagnostic:this.diagnostic(error,'observation')});return;}
      if (this.state.enabled) {
        const phase=error instanceof StaleAnalysisResultError?'observation':error instanceof ContextBudgetError?'context':this.failurePhase();
        if(error instanceof StaleAnalysisResultError){
          this.runtime.analysisCache={screeningKey:'',routeKey:''};
          this.runtime.phase='observation';
          this.save('analysis-cache',{kind:'routes',hit:false,discarded:'stale-result',expected:error.expected,actual:error.actual});
        }
        this.state.status = "error";
        this.state.error = error instanceof StaleAnalysisResultError?error.displayReason:error instanceof ContextBudgetError||error instanceof ProviderError||error instanceof AttackScreeningConfigError?error.message:error instanceof GameTransportError||error instanceof GameRequestError?error.displayReason:phase==='local'?'本地战术计算失败，请检查诊断后恢复 AI。':'AI执行失败，请检查该轮操作回执后恢复。';
        const delay=error instanceof ProviderError?null:recoveryDelay(error,this.runtime.recoveryAttempts+1);
        this.runtime.recoveryAt=delay===null?null:wallMs+Math.max(0,Date.now()-pollStartedAt)+delay;
        if(delay!==null){
          this.runtime.recoveryAttempts++;
          if(this.runtime.inFlight){
            const task=this.runtime.inFlight;
            const reason='失败后继续未完成任务。先读取最新情报和已成功回执，已接受命令和已发送消息不得重复执行。';
            for(const signal of recoverySignals(task,'recovery',reason,true))this.runtime.signals.set(signal.key,signal);
            for(const event of task.deferred)if(!this.runtime.deferred.has(event.key))this.runtime.deferred.set(event.key,event);
            this.runtime.inFlight=null;this.saveWake();
          }
          this.state.error=this.state.error.replace(/请[^。]*恢复[^。]*。?/g,'').trim()+` 将于${delay/1000}秒后自动恢复（第${this.runtime.recoveryAttempts}次）；重新读取情报后继续。`;
        }
        this.save("error", { reason: this.state.error,code:error instanceof StaleAnalysisResultError?'analysis-stale':error instanceof ContextBudgetError?'context-budget':error instanceof ProviderError?error.code:error instanceof GameTransportError?'game-transport':error instanceof GameRequestError?'game-request':'unknown',phase,...(error instanceof ContextBudgetError?{contextBudget:{characters:error.characters,sections:error.sections}}:{}),...(delay!==null?{recovery:{attempt:this.runtime.recoveryAttempts,delayMs:delay,at:new Date(this.runtime.recoveryAt!).toISOString()}}:{}),...(error instanceof ProviderError&&error.timeoutSource?{timeoutSource:error.timeoutSource}:{}),diagnostic:this.diagnostic(error) });
      }
    } finally {
      if(!startedThought)this.runtime.observing=false;
      if(maintaining){this.runtime.controller=null;this.runtime.activeTool=null;}
      if(startedThought){this.runtime.busy = false;this.runtime.controller = null;this.runtime.activeTool=null;this.runtime.localDecisionBasis=undefined;}
      this.store.recordTiming(this.state.roomId,this.state.lobbySeat,'runtime-poll-timing',{startedAt:pollStartedAt,durationMs:Date.now()-pollStartedAt,snapshotMs,snapshotReads,decisionMs,admissionMs,startedDecision:startedThought,observeOnly:!!options.observeOnly,backgroundOnly:!!options.backgroundOnly,tick:this.runtime.observed?.view.tick??null,sequence:this.state.sequence});
    }
  }
  private think(initial:AiSnapshot,task:DecisionTask){return runDecisionLoop(this.host(),this.runtime,initial,task);}
  get running() {
    return this.runtime.busy;
  }
  /** Observation may still append wake/baseline records before a model turn starts. */
  get settling(){return this.runtime.busy||this.runtime.observing||!!this.background?.settling;}
  get recovering(){return this.state.enabled&&this.state.status==='error'&&this.runtime.recoveryAt!==null;}
}
