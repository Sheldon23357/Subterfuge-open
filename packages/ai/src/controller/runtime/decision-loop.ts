import {LocalBasisChanged} from '../contracts/local-basis.js';
import {BatchTransportError} from '../execution/batch-outcome.js';
import {diagnosticText} from '../../../../contracts/src/index.js';
import {pendingExecutionEvidence} from '../execution/execution-evidence.js';
import {roundArrivalEstimates} from '../presentation/round-map.js';
import {manualVersion} from '../execution/manual-coordination.js';
import {createRoundWorkset,restoreRoundWorkset,appendRoundReceipt,addRoundCauses,reconcileRoundReceipts} from '../execution/round-workset.js';
import type {JournalEvent} from '../storage/journal-events.js';
import {recoverySignals} from './decision-recovery.js';
import { analysisKey,loadAnalysisEfficiency,reportInput,prepareAttackRoutes,StaleAnalysisResultError,AttackRouteConflictError } from '../analysis/analysis-efficiency.js';
import { loadAttackScreeningConfig,screeningConfigId } from '../analysis/attack-screening-config.js';
import {loadOutpostRiskConfig} from '../analysis/outpost-risk-config.js';
import { screenAttacks,screeningSummary } from '../analysis/attack-screening.js';
import { observationChanges } from '../observation/changes.js';
import {resolveOutpostReferences} from '../presentation/outpost-references.js';
import { chatBudget,chatTarget } from '../analysis/chat-budget.js';
import { courtesy,handledChat,reopenChat,type ChatHandled } from '../observation/chat-wake.js';
import { decisionBudget } from './decision-budget.js';
import { type DepartureReview } from '../observation/departure-confirmation.js';
import { GameRequestError,GameTransportError,compactGameError } from "../transport/gateway.js";
import { planLocalCommit } from '../execution/local-commit-plan.js';


import { ModelAdmissionStale } from './model-queue.js';
import { ProviderError } from '../contracts/provider-error.js';
import { recoveryDelay } from './recovery.js';
import { parseToolArguments,ToolArgumentsError } from '../contracts/tool-arguments.js';
import { toolMetadata } from '../contracts/tool-metadata.js';
import { executeToolResult } from '../execution/tool-results.js';
import type { DecisionTask } from '../contracts/types.js';
import {
gameSeconds,
type AgentProvider,
type AiSnapshot
} from "../contracts/types.js";

import type { DecisionHost } from './runner-host.js';
import type { RunnerState } from './runner-state.js';

/** Realtime planning survives tick changes; execution validates current authority. */
export function samePlanningTick(a:AiSnapshot,b:AiSnapshot){
 return a.observation.roomId===b.observation.roomId&&a.observation.view.player===b.observation.view.player
  &&a.observation.realtime===b.observation.realtime
  &&(a.observation.realtime===true||a.observation.view.tick===b.observation.view.tick);
}

export async function runDecisionLoop(host:DecisionHost,runtime:RunnerState,initial:AiSnapshot,task:DecisionTask) {
    const s = host.state,budget=decisionBudget(host.state.lastThought===null);
    const mode=host.mode;
    const fixedTickMaterial=mode.deferStaleUntilNextTick===true;
    const recordKind=(name:string)=>{if(!/^[a-z][a-z0-9-]{0,63}$/.test(name))throw Error('Invalid mode record name');return `${mode.recordPrefix}-${name}`;};
    // A write receipt may finish this round, but cannot retire a military
    // cause that has not reached the planner. The existing wake checkpoint
    // carries these causes into a fresh round without replaying old writes.
    const unreviewedThreats=new Map(mode.retainSignals(task.triggers??[]).map(signal=>[signal.key,signal]));
    const pendingWakeSignals=()=>[...new Map([...unreviewedThreats,...runtime.signals]).values()];
    const retainUnreviewedThreats=()=>{for(const [key,signal] of unreviewedThreats)if(!runtime.signals.has(key))runtime.signals.set(key,signal);};
    runtime.departureReviews=[];
    const departureCandidates=new Map<string,DepartureReview>();
    runtime.presentedReminders.clear();
    let snapshot = fixedTickMaterial?structuredClone(initial):initial,
      spoken = 0;
    const stored=restoreRoundWorkset(host.store.latest<{workset:unknown}>(s.roomId,s.lobbySeat,'round-workset')?.workset,initial.observation);
    const restored=stored;
    let roundWorkset=restored??createRoundWorkset(`round-${s.sequence+1}`,initial.observation,task);
    const feedback:unknown[]=[...(restored?[{resumedRound:restored.id,causes:restored.causes}]:[]),...roundWorkset.receipts];
    const saveReceipt=(kind:string,receipt:Record<string,unknown>)=>{
      const proposed=appendRoundReceipt(roundWorkset,{...receipt,kind,basisRevision:snapshot.observation.revision,worldDay:gameSeconds(snapshot)/600});
      host.saveEvents([{kind,details:receipt},{kind:'round-workset',details:{workset:proposed}}]);
      roundWorkset=proposed;
    };
    const reopenedChat=new Set<string>();
    const chatSentByTarget:Record<string,number>={};
    const readMessages=new Set<string>();
    let baseline=host.store.latest<AiSnapshot['observation']>(s.roomId,s.lobbySeat,'decision-observation');

    // Current-round material comes from its checkpoint; cross-round execution
    // facts come from the system ledger. Never select historical tool archives.
    const efficiency=loadAnalysisEfficiency();
    const history:unknown[]=[];
    runtime.controller = new AbortController();
    s.status = "thinking";
    s.error = null;
    s.sequence++;
    host.save("round-workset",{workset:roundWorkset});
    host.save("started", {
      ...task,sequence:s.sequence,tick:snapshot.observation.view.tick,seconds:gameSeconds(snapshot),budgetMs:budget.hardMs,
      incomingMessages:snapshot.chat.filter(m=>m.from!==snapshot.chatPlayer),
    });
    runtime.inFlight=task;host.saveWake();
    const startedAt = Date.now();
    const cache=runtime.analysisCache;
    const analysis={screeningKey:cache.screeningKey,cachedRoutes:cache.routes,cachedScreening:cache.screening?screeningSummary(cache.screening,initial.observation,initial):undefined};
    let yielded=false,routeRefreshes=0,actionCompleted=false,staleDeferred=false;
    let reconciledRoutes:{routes:import('../../../../contracts/src/index.js').AttackRoutes;windows:string}|undefined;
    decisionLoop: for (let step = 0; ; step++) {
      if (!s.enabled || runtime.controller.signal.aborted) return;
      // Stop only between acknowledged tool calls. Already accepted actions
      // remain effective; a continuation reminder makes unfinished work explicit.
      if (!actionCompleted&&step>0&&Date.now()-startedAt>=budget.yieldMs){yielded=true;break;}
      if((!fixedTickMaterial||actionCompleted)&&runtime.latestSnapshot&&gameSeconds(runtime.latestSnapshot)>=gameSeconds(snapshot))snapshot={...snapshot,...runtime.latestSnapshot,notifications:[...new Map([...snapshot.notifications,...runtime.latestSnapshot.notifications].map(n=>[n.id,n])).values()],task:snapshot.task??task};
      for(const signal of mode.retainSignals([...runtime.signals.values()]))unreviewedThreats.set(signal.key,signal);
      if(!fixedTickMaterial&&!actionCompleted)snapshot=host.mergePending(snapshot,snapshot.task??task);
      task=snapshot.task!;runtime.inFlight=task;host.saveWake();
      // Accounting only: calls/tokens never impose a quota. Persist before launch for interruption audit.
      snapshot={...snapshot,changes:observationChanges(baseline??null,snapshot.observation),reminders:host.store.reminders(s.roomId,s.lobbySeat),notebook:host.store.notebook(s.roomId,s.lobbySeat,gameSeconds(snapshot))};
      // Capture the actual displayed private view before the provider can run.
      // Audit writes also use this basis so they cannot overwrite a concurrent
      // memory/commander change before the finish CAS gets a chance to check it.
      const localView=host.store.localDecisionView(s.roomId,s.lobbySeat,gameSeconds(snapshot));
      if(localView.state){s.memory=localView.state.memory;if(localView.state.commanderDirectives)s.commanderDirectives=localView.state.commanderDirectives;else delete s.commanderDirectives;}
      snapshot={...snapshot,notebook:localView.notebook,reminders:localView.reminders};
      const providedStrategy=s.memory.strategy;
      let decisionBasis=localView.basis;
      runtime.localDecisionBasis=decisionBasis;
      snapshot.manualReviewedVersion=host.store.latest<{version:number}>(s.roomId,s.lobbySeat,'manual-intent-reconciled')?.version??0;
      snapshot.manualReviewedReceiptIds=host.store.manualReviewedReceiptIds(s.roomId,s.lobbySeat);
      // Current facts and round work materials replace retired focus/review domains.
      delete snapshot.notebookDependencies;delete snapshot.memoryConsistency;
      delete snapshot.campaigns;
      if(!actionCompleted&&host.gateway.attackRoutes&&mode.needsAnalysis(feedback,{state:s,latest:<T>(kind:string)=>host.store.latest<T>(s.roomId,s.lobbySeat,recordKind(kind))??undefined})){
        const config=loadAttackScreeningConfig(),riskConfig=loadOutpostRiskConfig(),key=analysisKey([reportInput(snapshot.observation),screeningConfigId(config),riskConfig,snapshot.task?.entities??[]]);
        runtime.phase='observation';
        try{
          const windows={attackTicks:mode.analysisWindows?.attackTicks??config.limits.attackTicks,localTicks:mode.analysisWindows?.localTicks??config.limits.localTicks,holdTicks:config.limits.holdTicks};
          let refreshedSnapshot:AiSnapshot|undefined;
          const prepared=await prepareAttackRoutes(snapshot.observation,windows,cache,(o,w)=>{
            const paired=reconciledRoutes;reconciledRoutes=undefined;
            return paired&&paired.windows===JSON.stringify(w)&&paired.routes.roomId===o.roomId&&paired.routes.revision===o.revision&&paired.routes.observedTick===o.view.tick?Promise.resolve(paired.routes):host.gateway.attackRoutes!(o,w);
          },efficiency.cacheRoutes,routeRefreshes<1?async()=>{
            routeRefreshes++;
            const generation=runtime.observationGeneration;
            const fresh=await host.gateway.snapshot(s.chatCursor,s.notificationCursor);
            // An overlapping observer owns the newer local read. Do not poll
            // indefinitely trying to win the race; validate that one basis.
            refreshedSnapshot=generation!==runtime.observationGeneration&&runtime.latestSnapshot?runtime.latestSnapshot:fresh;
            return refreshedSnapshot.observation;
          }:undefined);
          if(prepared.refreshed){
            if(mode.deferStaleUntilNextTick){staleDeferred=true;break decisionLoop;}
            reconciledRoutes={routes:prepared.routes,windows:JSON.stringify(windows)};
            const expectedRevision=snapshot.observation.revision;
            snapshot={...refreshedSnapshot!,task:snapshot.task!};
            host.collect(snapshot);
            host.save('analysis-cache',{kind:'routes',hit:false,refreshed:true,expectedRevision:expectedRevision.slice(0,128),currentRevision:prepared.observation.revision.slice(0,128)});
            // Rebuild task causes, private CAS, facts and screening together.
            // The exact validated route pair is cached, not an old decision.
            continue decisionLoop;
          }
          reconciledRoutes=undefined;
          analysis.cachedRoutes=prepared.routes;
          host.save('analysis-cache',{kind:'routes',hit:prepared.hit});
          if(!efficiency.cacheReports||key!==analysis.screeningKey){
            const routes=analysis.cachedRoutes;
            const fullReport=screenAttacks(snapshot.observation,routes,config,[],snapshot.task?.entities??[],riskConfig);
            const report=screeningSummary(fullReport,snapshot.observation,snapshot);
            snapshot={...snapshot,attackScreening:report};analysis.cachedScreening=report;analysis.screeningKey=key;
            cache.screening=fullReport;cache.screeningKey=key;
            host.save('attack-screening',{config,report:fullReport});
            host.save('analysis-cache',{kind:'screening',hit:false});
          }else {
            if(cache.screening)analysis.cachedScreening=screeningSummary({...cache.screening,basisRevision:snapshot.observation.revision},snapshot.observation,snapshot);
            host.save('analysis-cache',{kind:'screening',hit:true});
          }
        }catch(error){
            // A read-only preparation may race a confirmed private change.
            // The failed CAS already refreshed local authority; rebuild the
            // same pending first input rather than sending its stale contract.
            if(error instanceof Error&&error.message.startsWith('LOCAL_BASIS_CHANGED:')){
              if(mode.deferStaleUntilNextTick){staleDeferred=true;break decisionLoop;}continue;
            }
            if(error instanceof GameRequestError&&error.status===409&&(error.code===undefined&&error.observation||['REVISION_CONFLICT','query-replan-required','stale-observation'].includes(error.code??''))){
              const prior=snapshot.observation;
              const validateIdentity=(next:AiSnapshot['observation'])=>{
                if(next.roomId!==prior.roomId)throw new StaleAnalysisResultError({roomId:prior.roomId,revision:prior.revision,tick:prior.view.tick},{roomId:next.roomId,revision:next.revision,tick:next.view.tick});
                if(next.view.player!==prior.view.player)throw Error('Attack route refresh changed player identity');
              };
              if(error.observation)validateIdentity(error.observation);
              if(mode.deferStaleUntilNextTick){staleDeferred=true;break decisionLoop;}
              if(routeRefreshes>=1)throw new AttackRouteConflictError(error);
              routeRefreshes++;
              const generation=runtime.observationGeneration;
              const fresh=await host.gateway.snapshot(s.chatCursor,s.notificationCursor);
              const current=generation!==runtime.observationGeneration&&runtime.latestSnapshot?runtime.latestSnapshot:fresh;
              validateIdentity(current.observation);
              snapshot={...current,task:snapshot.task!};
              host.collect(snapshot);
              continue;
            }
            throw error;
        }
      }
      if(analysis.cachedScreening)snapshot.attackScreening=analysis.cachedScreening;
      decisionBasis=runtime.localDecisionBasis??decisionBasis;
      snapshot={...snapshot,communication:chatBudget(chatSentByTarget,spoken,{now:gameSeconds(snapshot),lastSpoke:s.lastSpoke,chat:snapshot.chat,player:snapshot.chatPlayer})};
      const newlyRead=snapshot.chat.filter(m=>m.from!==snapshot.chatPlayer&&!readMessages.has(`${m.from}:${m.id}`));
      if(newlyRead.length){for(const m of newlyRead)readMessages.add(`${m.from}:${m.id}`);host.save('messages-read',{sequence:s.sequence,messages:newlyRead});}
      runtime.phase='local';
      runtime.activeTool=null;
      const commanderVersion=s.commanderDirectives?.version??0;
      const manualBasis=manualVersion(snapshot.observation);
      const receiptState=host.receiptState();
      roundWorkset=reconcileRoundReceipts(addRoundCauses(roundWorkset,snapshot.task!),receiptState);
      const executionEvidence=pendingExecutionEvidence(receiptState);
      snapshot.executionLedger={pending:host.store.pendingWriteEvidence(s.roomId,s.lobbySeat,receiptState.pendingWrites),observations:receiptState.records.filter(r=>r.player===snapshot.observation.view.player&&r.state!=='confirmedFact'),notices:executionEvidence.notices};
      const currentReceipts=new Map(roundWorkset.receipts.map(r=>[r.id,r]));
      for(let i=0;i<feedback.length;i++){
        const row=feedback[i] as {id?:unknown}|null;
        if(row?.id&&currentReceipts.has(row.id))feedback[i]=currentReceipts.get(row.id)!;
        else if(row?.id&&toolMetadata(String((row as {tool?:unknown}).tool))?.effect==='read'){feedback.splice(i,1);i--;}
      }
      const modeInput={state:s,snapshot,history,feedback,efficiency,routes:analysis.cachedRoutes,
        suffix:Date.now()-startedAt>=budget.warnMs?'\n本轮即将达到运行时限：优先保存必要记忆并finish，未完成事项用reminders明确复查，避免新增大规模查询。':''};
      let result:import('../contracts/types.js').AgentResult;
      const providedArrivals=roundArrivalEstimates(snapshot);
      if(actionCompleted&&mode.afterAction){result=mode.afterAction(modeInput,<T>(name:string)=>host.store.latest<T>(s.roomId,s.lobbySeat,recordKind(name))??undefined,(kind,details)=>host.save(recordKind(kind),details));}
      else {
      if(!mode.supportsCommander&&s.commanderDirectives?.text.trim())throw Error('当前 AI 无法执行已确认指挥官要求，请先处理这些要求。');
      const prepared=mode.prepare(modeInput);
      const {prompt,promptContext,promptTools,contextSelection,memoryContext,contextBudget}=prepared.context;
      host.saveEvents([{kind:'context-selected',details:{sequence:s.sequence,step,...contextSelection,contextBudget}},
        {kind:'round-workset',details:{workset:roundWorkset}}]);
      { const attempt=0;
        const callStartedAt=Date.now();
        host.save('bot-compute-started',{sequence:s.sequence,step,attempt,startedAt:callStartedAt,roundElapsedMs:callStartedAt-startedAt,promptCharacters:prompt.length,promptContext,promptTools,memoryContext,contextSelection,contextBudget,remainingMs:Math.max(0,budget.hardMs-(callStartedAt-startedAt))});
        try{
          const remaining=budget.hardMs-(Date.now()-startedAt);
          if(remaining<=0)throw new ProviderError('timeout','round-deadline',{stage:'admission',outcome:'not-sent'});
          // Context breadth and time allowance remain task-dependent; effort follows the operator's seat setting.
          const dispatchStep=(request:import('../contracts/types.js').AgentRequest)=>prepared.run(request,{
            receipt:id=>host.store.queryResult(s.roomId,s.lobbySeat,id),
            attemptReceipt:(kind,id)=>host.store.modeReceipt?.(s.roomId,s.lobbySeat,recordKind(kind),id),
            ...(host.gateway.readActivity?{readActivity:(after:number,through:number)=>host.gateway.readActivity!(after,through)}:{}),
            refreshSnapshot:async()=>{const fresh=await host.gateway.snapshot(s.chatCursor,s.notificationCursor);host.collect(fresh);return fresh;},
            local:(request,compute)=>runtime.pipeline.measure('search',snapshot.observation.view.tick,()=>host.provider.computeLocal?host.provider.computeLocal(request,compute):compute(request)),
            model:{step:async modelRequest=>{
              if(!mode.usesModelProvider)throw Error('This strategy does not declare model capability');
              const signal=AbortSignal.any([request.signal,modelRequest.signal]);signal.throwIfAborted();
              s.calls++;host.save('call-reserved',{sequence:s.sequence,step,attempt:0,startedAt:Date.now(),model:modelRequest.model,promptCharacters:modelRequest.prompt.length});
              runtime.phase='model';
              try{
                const result=await host.provider.step({...modelRequest,signal,beforeSend:async()=>{await request.beforeSend?.();await modelRequest.beforeSend?.();}});
                s.tokens+=result.tokens;host.save('call-completed',{sequence:s.sequence,step,tokens:result.tokens,usage:result.usage??null,usageKnown:result.usageKnown??null});signal.throwIfAborted();return result;
              }catch(error){host.save('call-failed',{sequence:s.sequence,step,diagnostic:host.diagnostic(error,'model')});throw error;}
              finally{runtime.phase='local';}
            }},
            latest:<T>(kind:string)=>host.store.latest<T>(s.roomId,s.lobbySeat,recordKind(kind))??undefined,
            record:(kind,details)=>{request.signal.throwIfAborted();host.save(recordKind(kind),{...details,sequence:s.sequence,step});},
            markAssessed:()=>{unreviewedThreats.clear();host.save('tactical-search-completed',{tick:fixedTickMaterial?snapshot.observation.view.tick:Math.max(snapshot.observation.view.tick,runtime.latestSnapshot?.observation.view.tick??0),sequence:s.sequence});},
          });
          result=await dispatchStep({model:s.settings.model,...(s.settings.provider ? {provider:s.settings.provider} : {}),...(s.settings.serviceTier?{serviceTier:s.settings.serviceTier}:{}),prompt,effort:s.settings.reasoningEffort??'low',timeoutMs:snapshot.task?.weight==='light'||snapshot.task?.weight==='medium'?120_000:300_000,signal:AbortSignal.any([runtime.controller.signal,AbortSignal.timeout(remaining)]),
            beforeSend:async()=>{
              if(Date.now()-startedAt>=budget.hardMs)throw new ProviderError('timeout','round-deadline',{stage:'admission',outcome:'not-sent'});
              if(fixedTickMaterial){
                if(runtime.latestSnapshot&&!samePlanningTick(snapshot,runtime.latestSnapshot))throw new ModelAdmissionStale('planning-tick-changed');
                return;
              }
              if(runtime.signals.size)throw new ModelAdmissionStale('important-events');
              if((s.commanderDirectives?.version??0)!==commanderVersion)throw new ModelAdmissionStale('commander-version');
              if(host.store.localWriteBasis(s.roomId,s.lobbySeat)!==decisionBasis)throw new ModelAdmissionStale('private-state-basis');
              // Last-writer-wins applies after dispatch. An unsent request must
              // still use the latest strategy, without turning this into a CAS.
              if(host.store.load(s.roomId,s.lobbySeat)?.memory.strategy!==providedStrategy)throw new ModelAdmissionStale('strategy-before-send');
              // Polling may have paused while this ticket waited. Re-read the
              // authorized source at admission instead of assuming the last poll
              // still represents the server. A concurrent observer owns its read.
              const generation=runtime.observationGeneration;
              const admitted=await host.gateway.snapshot(s.chatCursor,s.notificationCursor);
              if(generation!==runtime.observationGeneration&&(runtime.observationBarrier||!runtime.latestSnapshot||!samePlanningTick(admitted,runtime.latestSnapshot)))throw new ModelAdmissionStale('observation-read-raced');
              if(host.store.localWriteBasis(s.roomId,s.lobbySeat)!==decisionBasis)throw new ModelAdmissionStale('private-state-basis');
              // Last-writer-wins applies after dispatch. An unsent request must
              // still use the latest strategy, without turning this into a CAS.
              if(host.store.load(s.roomId,s.lobbySeat)?.memory.strategy!==providedStrategy)throw new ModelAdmissionStale('strategy-before-send');
              host.collect(admitted);
              if(Date.now()-startedAt>=budget.hardMs)throw new ProviderError('timeout','round-deadline',{stage:'admission',outcome:'not-sent'});
              if(runtime.signals.size)throw new ModelAdmissionStale('important-events');
              const latest=runtime.latestSnapshot;
              // Fractional game time alone does not churn queued prompts. Actual
              // revisions, ticks and newly observed messages do require rebuild.
              if(latest&&(manualVersion(latest.observation)!==manualBasis||latest.observation.revision!==snapshot.observation.revision||latest.observation.view.tick!==snapshot.observation.view.tick||latest.chatCursor!==snapshot.chatCursor||latest.notificationCursor!==snapshot.notificationCursor))throw new ModelAdmissionStale('observation-or-messages');
            },
          });
          if(runtime.latestSnapshot&&manualVersion(runtime.latestSnapshot.observation)!==manualBasis){
            const fresh=host.store.localDecisionView(s.roomId,s.lobbySeat,gameSeconds(snapshot));
            if(fresh.state){s.memory=fresh.state.memory;if(fresh.state.commanderDirectives)s.commanderDirectives=fresh.state.commanderDirectives;else delete s.commanderDirectives;}
            runtime.localDecisionBasis=fresh.basis;
          }
          host.save('bot-compute-completed',{sequence:s.sequence,step,attempt,durationMs:Date.now()-callStartedAt,roundElapsedMs:Date.now()-startedAt});

        }catch(error){
          if(!s.enabled||runtime.controller.signal.aborted)return;
          if(error instanceof ModelAdmissionStale){
            const fresh=host.store.localDecisionView(s.roomId,s.lobbySeat,gameSeconds(snapshot));
            if(fresh.state){s.memory=fresh.state.memory;if(fresh.state.commanderDirectives)s.commanderDirectives=fresh.state.commanderDirectives;else delete s.commanderDirectives;}
            runtime.localDecisionBasis=fresh.basis;
            host.save('queued-stale-before-send',{sequence:s.sequence,step,attempt,reason:error.reason,sent:false,roundElapsedMs:Date.now()-startedAt});
            if(mode.deferStaleUntilNextTick){staleDeferred=true;break decisionLoop;}
            // No provider request exists to replay. Rejoin the tail on the next
            // rebuilt call with the original round clock and merged task.
            continue decisionLoop;
          }
          if(error instanceof LocalBasisChanged)throw error;
          const roundExpired=Date.now()-startedAt>=budget.hardMs;
          host.save('bot-compute-failed',{sequence:s.sequence,step,attempt,durationMs:Date.now()-callStartedAt,roundElapsedMs:Date.now()-startedAt,code:error instanceof ProviderError?error.code:'unknown',timeoutSource:roundExpired?'round-deadline':error instanceof ProviderError?error.timeoutSource:undefined,diagnostic:host.diagnostic(error)});
          if(error instanceof ProviderError&&roundExpired&&step>0&&error.outcome==='not-sent'){yielded=true;break decisionLoop;}
          if(error instanceof ProviderError&&error.code==='cancelled'&&roundExpired)throw new ProviderError('timeout','round-deadline',{...error.diagnostic,stage:error.diagnostic?.stage??'provider-transport',outcome:error.outcome});
          // A failed local computation cannot establish any game-write effect.
          throw error;
        }
      }
      }
      baseline=structuredClone(snapshot.observation);
      host.saveEvents([{kind:'decision-observation',details:baseline},{kind:'arrival-estimates',details:providedArrivals},...(executionEvidence.references.length?[{kind:'execution-evidence-provided',details:{references:executionEvidence.references}}]:[])]);
      if (!s.enabled || runtime.controller.signal.aborted) return;
      // A memory-review wake is merged at the next normal step; it must not
      // discard an already paid reply after same-version reconciliation.
      let referenced='';
      try{referenced=JSON.stringify(resolveOutpostReferences(parseToolArguments(result.reply.arguments).args,snapshot.observation));}catch{}
      const affected=[...runtime.signals.values()].some(signal=>signal.key!=='memory-review'&&(signal.scope==='global'||!signal.entities.length||signal.entities.some(entity=>referenced.includes(JSON.stringify(entity)))));
      const mutation=toolMetadata(result.reply.tool)?.effect!=='read';
      // Finishing acknowledges the whole round. New causes or incoming messages
      // must be presented before that acknowledgement, even without entity args.
      const unseenAtFinish=result.reply.tool==='finish'&&([...runtime.signals.values()].some(signal=>signal.key!=='memory-review')||runtime.latestSnapshot?.chat.some(message=>message.from!==snapshot.chatPlayer&&!snapshot.chat.some(provided=>provided.id===message.id)));
      const expired=fixedTickMaterial
        ?!!(runtime.latestSnapshot&&!samePlanningTick(snapshot,runtime.latestSnapshot)||result.executionObservation&&!samePlanningTick(snapshot,{...snapshot,observation:result.executionObservation}))
        :affected||unseenAtFinish||(s.commanderDirectives?.version??0)!==commanderVersion||!!(runtime.latestSnapshot&&manualVersion(runtime.latestSnapshot.observation)!==manualBasis);
      if(!actionCompleted&&mutation&&expired){
        host.save('reply-superseded',{sequence:s.sequence,step,reason:'思考期间出现新重要事件，旧回复未执行'});
        if(mode.deferStaleUntilNextTick){staleDeferred=true;break decisionLoop;}
        feedback.push({error:'new-important-events',instruction:'情报已更新；先处理新增任务，上一回复未执行。'});
        continue;
      }
      if(!fixedTickMaterial&&runtime.latestSnapshot)snapshot={...snapshot,...runtime.latestSnapshot,notifications:[...new Map([...snapshot.notifications,...runtime.latestSnapshot.notifications].map(n=>[n.id,n])).values()],task:snapshot.task??task};
      if(result.executionObservation){
        const validated=result.executionObservation;
        if(validated.roomId!==snapshot.observation.roomId||validated.view.player!==snapshot.observation.view.player)throw Error('Local proposal observation changed identity');
        snapshot={...snapshot,observation:validated};
      }
      const reply = result.reply,
        id = `ai-${s.lobbySeat}-${s.sequence}-${step}`;
      let value: unknown;
      let receiptCommitted=false,toolSucceeded=false,feedbackCommitted=false;
      runtime.phase='tool';
      runtime.activeTool={id,tool:reply.tool};
      const toolBasisRevision=snapshot.observation.revision;
      // Serialize tool effects and fresh-conflict callbacks with the observer.
      // The observer waits for this tool, never the other way around.
      const endObservationBarrier=host.beginObservationBarrier();
      const endPipelineTiming=runtime.pipeline.start(reply.tool==='finish'?'finish':'execution',snapshot.observation.view.tick);
      const toolTimingStart=performance.now(),toolStartedAt=Date.now();let timingMark=toolTimingStart;const timingStages:Record<string,number>={};
      const markTiming=(stage:string)=>{const now=performance.now();timingStages[stage]=(timingStages[stage]??0)+now-timingMark;timingMark=now;};
      try {
        // Audit intent before writes. Unknown outcomes stop the round; never invent a fresh retry ID.
        const {args,repairs} = parseToolArguments(reply.arguments);
        if(repairs.length)host.save('tool-arguments-normalized',{id,tool:reply.tool,repairs,rawArguments:reply.arguments});
        saveReceipt("tool-intent", {
          id,
          tool: reply.tool,
          summary: reply.summary,
          arguments: args,
          basisRevision:snapshot.observation.revision,
          manualBasisVersion:manualBasis,result:{status:'pending'},
        });
        // Model requests use the authorized name namespace exclusively. Lower
        // level helpers may already contain engine IDs, but cannot widen this
        // public boundary. Keep the original request in the journal.
        resolveOutpostReferences(args,snapshot.observation,{modelInput:true});
        const localBasis=(toolMetadata(reply.tool)?.commit==='local-cas')?decisionBasis:undefined;
        const commanderMutation=(toolMetadata(reply.tool)!==undefined&&toolMetadata(reply.tool)?.commit!=='receipt');
        if(commanderMutation&&reply.tool!=='finish'){
          if(host.gateway.authorityCheck)await host.gateway.authorityCheck(commanderVersion,manualBasis);
          else{await host.gateway.commanderCheck?.(commanderVersion);await host.gateway.manualCheck?.(manualBasis);}
          if((s.commanderDirectives?.version??0)!==commanderVersion)throw Error('Commander directives changed during this decision; reconsider before writing');
        }
        markTiming('authority-checks');
        mode.beforeExecute?.({state:s,snapshot,tool:reply.tool,arguments:args,latest:<T>(name:string)=>host.store.latest<T>(s.roomId,s.lobbySeat,recordKind(name))??undefined});
        const argumentsForContext = args;
        const predictedDepartures:{id:string;evidence:import('../../../../prediction/src/index.js').KnownDepartureEvidence}[]=[];
        host.gateway.writeContext?.({turn:`${s.sequence}:${id}`,deadline:startedAt+budget.hardMs,signal:runtime.controller!.signal,revision:snapshot.observation.revision,instructionsVersion:commanderVersion});
        markTiming('prepare-execution');
        const execution = await executeToolResult(reply.tool, args, {
          batchPrevalidated:mode.serverBatch===true,
          beforeEffect:(tool,arguments_,current,batchEffect)=>mode.beforeExecute?.({state:s,snapshot:current,tool,arguments:arguments_,...(batchEffect?{batchEffect}:{}),latest:<T>(name:string)=>host.store.latest<T>(s.roomId,s.lobbySeat,recordKind(name))??undefined}),
          state: s,
          signal: runtime.controller.signal,
          snapshot,
          gateway: host.gateway,
          id,
          spoken,
          chatSentByTarget,
          onObservation:observation=>{snapshot={...snapshot,observation};host.collect(snapshot);},
          now: gameSeconds(snapshot),
          active:()=>s.enabled&&!runtime.controller!.signal.aborted,
          audit:(kind,details)=>{
            host.save(kind,details);
            if(kind==='departure-prediction')predictedDepartures.push(details as typeof predictedDepartures[number]);
          },
          // Model-authored references can acknowledge only evidence actually
          // supplied in this round. Program audit/reconciliation readers retain
          // their original archive access outside this model capability.
          readToolResult:id=>roundWorkset.receipts.find(receipt=>receipt.id===id)??executionEvidence.notices.find(notice=>notice.id===id),
          readManualReceipt:id=>snapshot.observation.manualCommands?.receipts.find(r=>r.id===id),
          readObservedFleetIds:reference=>host.store.observedFleetIds(s.roomId,s.lobbySeat,reference),
        });
        markTiming('execute-tool');
        value=execution.result;
        toolSucceeded=true;
        const successfulReceipts=new Set([id]);
        for(const p of predictedDepartures.filter(p=>successfulReceipts.has(p.id))){
          const {departures,...basis}=p.evidence;
          for(const departure of departures)departureCandidates.set(departure.fleetId,{...basis,departure,
            sequence:s.sequence,resultRef:p.id,validatedRevision:p.evidence.basisRevision});
        }
        const localPlan=planLocalCommit(execution,s.memory,snapshot);
        const localEvents:JournalEvent[]=[...localPlan.events];
        const localMemory=localPlan.memory;
        if(reply.tool==='batch') snapshot={...snapshot,observation:(value as {observation:AiSnapshot['observation']}).observation};
        if (reply.tool === "say") {
          spoken++;
          const target=chatTarget((args as {to:number|number[]|null}).to);
          chatSentByTarget[target]=(chatSentByTarget[target]??0)+1;
          if(typeof (args as {text?:unknown}).text==='string'&&!courtesy((args as {text:string}).text)){
            const to=(args as {to:number|number[]|null}).to;
            if(to===null)reopenedChat.add('public');else for(const recipient of Array.isArray(to)?to:[to])reopenedChat.add(`player:${recipient}`);
            host.save('chat-handled',reopenChat(host.store.latest<ChatHandled>(s.roomId,s.lobbySeat,'chat-handled')??{},reopenedChat));
          }
          s.lastSpoke = gameSeconds(snapshot);
        }
        if (["order", "cancelSchedule"].includes(reply.tool)) {
          snapshot = {
            ...snapshot,
            observation: value as AiSnapshot["observation"],
          };
        }
        if(['order','cancelSchedule','batch'].includes(reply.tool)){
          host.collect(snapshot,reply.tool!=='batch'||(value as {results:{status:string}[]}).results.some(r=>r.status==='accepted'));
          if(manualVersion(snapshot.observation)!==manualBasis){
            // A successful remote response may already contain newer human
            // authority. Keep that accepted effect durable without rebasing a
            // local model candidate or relabeling the human command as AI.
            const fresh=host.store.localDecisionView(s.roomId,s.lobbySeat,gameSeconds(snapshot));
            if(fresh.state){s.memory=fresh.state.memory;if(fresh.state.commanderDirectives)s.commanderDirectives=fresh.state.commanderDirectives;else delete s.commanderDirectives;}
            runtime.localDecisionBasis=fresh.basis;
          }
        }
        const receipt={id,tool:reply.tool,summary:reply.summary,manualBasisVersion:manualBasis,result:value};
        const proposedWorkset=reply.tool==='finish'?null:appendRoundReceipt(roundWorkset,{...receipt,arguments:args,kind:'tool-result',basisRevision:snapshot.observation.revision,worldDay:gameSeconds(snapshot)/600});
        markTiming('apply-result');
        if((toolMetadata(reply.tool)?.commit==='local-cas')){
          // Finish changes private memory only. The local CAS below guards
          // concurrent authority/fact updates without another remote read.
          if(reply.tool!=='finish'){
            if(host.gateway.authorityCheck)await host.gateway.authorityCheck(commanderVersion,manualBasis);
            else{await host.gateway.commanderCheck?.(commanderVersion);await host.gateway.manualCheck?.(manualBasis);}
            markTiming('finish-authority-checks');
          }
          if((s.commanderDirectives?.version??0)!==commanderVersion)throw Error('Commander directives changed before local commit; previous result was not saved');
          const next={...s,memory:localMemory};
          localEvents.push({kind:'tool-result',details:receipt},{kind:'round-workset',details:{workset:proposedWorkset}});
          if(reply.tool==='finish'){
            Object.assign(next,{lastThought:gameSeconds(snapshot),lastRevision:snapshot.observation.revision,nextReview:null,
              chatCursor:Math.max(s.chatCursor,snapshot.chatCursor),notificationCursor:Math.max(s.notificationCursor,snapshot.notificationCursor),status:'waiting'});
            const reviews=[...departureCandidates.values()].filter(r=>r.basisRevision===snapshot.observation.revision&&r.basisRevision===runtime.observed?.revision);
            const remaining=new Set(host.store.reminders(s.roomId,s.lobbySeat).map(r=>r.id));
            for(const event of localEvents){const key=(event.details as {id?:string})?.id;if(key){if(event.kind==='reminder-set')remaining.add(key);else if(['reminder-cancelled','reminder-fired'].includes(event.kind))remaining.delete(key);}}
            for(const id of [...remaining].filter(id=>id.startsWith('continuation:')))localEvents.push({kind:'reminder-cancelled',details:{id}});
            if(runtime.recoveryAttempts)localEvents.push({kind:'recovery-completed',details:{attempts:runtime.recoveryAttempts,at:new Date().toISOString()}});
            localEvents.push({kind:'observation-baseline',details:snapshot.observation},
              {kind:'wake-state',details:{signals:pendingWakeSignals(),deferred:[...runtime.deferred.values()],coalescedArrivals:[...runtime.coalescedArrivals.values()],departureReviews:reviews,inFlight:null,notices:[...runtime.pendingNotices.values()]}},
              {kind:'chat-handled',details:reopenChat(handledChat(host.mode.backgroundHandlesChat?[]:snapshot.chat,snapshot.chatPlayer,host.store.latest<ChatHandled>(s.roomId,s.lobbySeat,'chat-handled')??{}),reopenedChat)},
              {kind:'completed',details:{sequence:s.sequence,nextReview:null,durationMs:Date.now()-startedAt,reason:'finished'}});
          }
          const persisted=host.store.saveLocalEvents(next,id,localEvents,localBasis);
          runtime.localDecisionBasis=undefined;
          receiptCommitted=true;if(proposedWorkset)roundWorkset=proposedWorkset;Object.assign(s,persisted);
          if(reply.tool==='finish'){
            retainUnreviewedThreats();
            runtime.inFlight=null;runtime.recoveryAttempts=0;runtime.recoveryAt=null;
            runtime.departureReviews=[...departureCandidates.values()].filter(r=>r.basisRevision===snapshot.observation.revision&&r.basisRevision===runtime.observed?.revision);
            return;
          }
        }else{saveReceipt('tool-result',{...receipt,arguments:args});receiptCommitted=true;}
        feedback.push({ id, tool: reply.tool, summary:reply.summary, arguments:argumentsForContext, result:value });feedbackCommitted=true;
        if(mode.afterAction&&['order','batch'].includes(reply.tool))actionCompleted=true;
        if (reply.tool === "finish") {
          s.nextReview = null;
          break;
        }
      } catch (e) {
        // A durable receipt is authoritative even if a later local operation fails.
        // Never tell the provider to retry an accepted effect (especially game commands).
        if(e instanceof Error&&e.message.startsWith('LOCAL_ID_CONFLICT:'))throw e;
        const durable=host.store.queryResult(s.roomId,s.lobbySeat,id)!==undefined;
        if(durable&&(toolMetadata(reply.tool)?.commit==='local-cas')){
          runtime.localDecisionBasis=undefined;
          Object.assign(s,host.store.load(s.roomId,s.lobbySeat)!);
          roundWorkset=restoreRoundWorkset(host.store.latest<{workset:unknown}>(s.roomId,s.lobbySeat,'round-workset')?.workset,snapshot.observation)??roundWorkset;
          if(reply.tool==='finish'){retainUnreviewedThreats();runtime.inFlight=null;runtime.recoveryAttempts=0;runtime.recoveryAt=null;runtime.departureReviews=host.store.latest<{departureReviews?:DepartureReview[]}>(s.roomId,s.lobbySeat,'wake-state')?.departureReviews??[];return;}
          const accepted=host.store.queryResult(s.roomId,s.lobbySeat,id) as {result:unknown};
          if(!feedbackCommitted)feedback.push({id,tool:reply.tool,summary:reply.summary,arguments:reply.arguments,result:accepted.result});
          continue;
        }
        if(receiptCommitted||durable||toolSucceeded&&(toolMetadata(reply.tool)?.commit==='remote'))throw e;
        if(e instanceof LocalBasisChanged||(toolMetadata(reply.tool)?.commit==='local-cas')&&host.store.localWriteBasis(s.roomId,s.lobbySeat)!==decisionBasis)throw new LocalBasisChanged();
        const errorEvidence=e instanceof GameRequestError||e instanceof GameTransportError?compactGameError(e,{expectedRevision:toolBasisRevision}):{};
        if (e instanceof GameTransportError) {
          if(e instanceof BatchTransportError){
            snapshot={...snapshot,observation:e.observation};host.collect(snapshot,true);
            saveReceipt('tool-unknown',{id,tool:reply.tool,summary:reply.summary,arguments:reply.arguments,result:{...e.outcome,error:diagnosticText(e.displayReason),...errorEvidence},diagnostic:host.diagnostic(e)});
            throw e;
          }
          if(e.diagnostic?.outcome==='read-only')saveReceipt('tool-rejected',{id,tool:reply.tool,summary:reply.summary,arguments:reply.arguments,result:{error:diagnosticText(e.displayReason),...errorEvidence},diagnostic:host.diagnostic(e)});
          else saveReceipt('tool-unknown',{id,tool:reply.tool,summary:reply.summary,arguments:reply.arguments,result:{status:'unknown',error:diagnosticText(e.displayReason),...errorEvidence},diagnostic:host.diagnostic(e)});
          throw e;
        }
        if (e instanceof GameRequestError && e.status === 409) {
          if(e.observation) snapshot={...snapshot,observation:e.observation};
          else snapshot={...await host.gateway.snapshot(s.chatCursor,s.notificationCursor),task:snapshot.task??task};
          host.collect(snapshot);
          // Recording a newly authoritative manual event intentionally changes
          // the private CAS basis. The rejected old candidate is discarded;
          // refresh only the audit writer before recording this rejection.
          const fresh=host.store.localDecisionView(s.roomId,s.lobbySeat,gameSeconds(snapshot));
          if(fresh.state){s.memory=fresh.state.memory;if(fresh.state.commanderDirectives)s.commanderDirectives=fresh.state.commanderDirectives;else delete s.commanderDirectives;}
          runtime.localDecisionBasis=fresh.basis;
          value = {
            error: diagnosticText(e.message,80),
            refreshed:true,
            currentRevision:snapshot.observation.revision,observedTick:snapshot.observation.view.tick,
            instruction: "Updated authorized map and changes are already supplied. Reconsider this snapshot; this rejected request made no changes. No automatic retry was sent.",
            ...compactGameError(e,{expectedRevision:toolBasisRevision,currentRevision:snapshot.observation.revision}),
          };
        } else if (e instanceof GameRequestError) {
          if(recoveryDelay(e,1)!==null){
            saveReceipt('tool-rejected',{id,tool:reply.tool,summary:reply.summary,arguments:reply.arguments,result:{error:diagnosticText(e.displayReason),...errorEvidence},diagnostic:host.diagnostic(e)});
            throw e;
          }
          value = { error:diagnosticText(e.message),...(e.detail?{detail:diagnosticText(e.detail)}:{}),...errorEvidence };
        } else if (e instanceof ToolArgumentsError) {
          host.save('tool-intent',{id,tool:reply.tool,summary:reply.summary,arguments:reply.arguments,invalidArguments:true});
          value = {error:e.message,detail:e.detail,instruction:'No tool was executed. Return the complete corrected arguments. For deploy/finish/queries use a structured object; other tools use one JSON object encoded as a string.'};
        } else if (e instanceof TypeError) {
          throw e;
        } else {
          const message=e instanceof Error?e.message:'Tool rejected';
          let detail:unknown;try{const parsed=JSON.parse(message);if(parsed&&typeof parsed==='object'&&typeof parsed.code==='string')detail=parsed;}catch{}
          value = {error:message,...(detail?{detail}:{}),submittedArguments:reply.arguments};
        }
        feedback.push({ id, tool: reply.tool, summary:reply.summary, arguments:reply.arguments, result:value });
        saveReceipt("tool-rejected", { id, tool: reply.tool, summary:reply.summary, arguments:reply.arguments, result: value,diagnostic:host.diagnostic(e) });
        if(mode.deferStaleUntilNextTick){staleDeferred=true;break decisionLoop;}
      }finally{
        endPipelineTiming();
        markTiming('commit-and-cleanup');
        host.gateway.writeContext?.(null);
        endObservationBarrier();
        host.save('execution-tool-timing',{sequence:s.sequence,id,tool:reply.tool,startedAt:toolStartedAt,durationMs:performance.now()-toolTimingStart,stages:timingStages,toolSucceeded,receiptCommitted});
      }
    }
    if (!s.enabled) return;
    if(staleDeferred){
      // Keep business causes and new events; never acknowledge stale chat/facts.
      const inherited=recoverySignals(task,'stale-decision','上一轮材料已变化；合并最新事实后重新判断，已接受操作不得重发',false);
      for(const [index,signal] of inherited.entries()){
        // Repeated deferral keeps source identities stable instead of nesting keys.
        const original=index>0?task.triggers?.[index-1]:undefined;
        const next=original?{...signal,key:original.key}:signal;
        if(!runtime.signals.has(next.key))runtime.signals.set(next.key,next);
      }
      for(const event of task.deferred)if(!runtime.deferred.has(event.key))runtime.deferred.set(event.key,event);
      retainUnreviewedThreats();
      runtime.localDecisionBasis=undefined;
      runtime.inFlight=null;
      runtime.pendingSince=null;
      s.status='waiting';
      host.save('round-workset',{workset:null});
      host.saveWake();
      host.save('completed',{sequence:s.sequence,nextReview:null,durationMs:Date.now()-startedAt,reason:'stale-deferred'});
      return;
    }
    s.lastThought = gameSeconds(snapshot);
    s.lastRevision = snapshot.observation.revision;
    s.nextReview=null;
    const unfinishedTask=task;
    runtime.inFlight=null;
    s.chatCursor = Math.max(s.chatCursor,snapshot.chatCursor);
    s.notificationCursor = Math.max(s.notificationCursor,snapshot.notificationCursor);
    s.status = "waiting";
    if(runtime.recoveryAttempts)host.save('recovery-completed',{attempts:runtime.recoveryAttempts,at:new Date().toISOString()});
    runtime.recoveryAttempts=0;runtime.recoveryAt=null;
    host.save('observation-baseline',snapshot.observation);
    if(yielded){
      for(const signal of recoverySignals(unfinishedTask,'continuation','上一轮达到运行时限，复核已接受回执后自动续办未完成事项；不要重复出兵',false))runtime.signals.set(signal.key,signal);
      for(const event of unfinishedTask.deferred)if(!runtime.deferred.has(event.key))runtime.deferred.set(event.key,event);
      runtime.pendingSince=Date.now();
    }else{
      // Completing unfinished work also retires its prior system reminders.
      for(const r of host.store.reminders(s.roomId,s.lobbySeat).filter(r=>r.id.startsWith('continuation:')))host.save('reminder-cancelled',{id:r.id});
    }
    host.saveWake();
    host.save('chat-handled',reopenChat(handledChat(host.mode.backgroundHandlesChat?[]:snapshot.chat,snapshot.chatPlayer,host.store.latest<ChatHandled>(s.roomId,s.lobbySeat,'chat-handled')??{}),reopenedChat));
    host.save("completed", { sequence:s.sequence,nextReview: s.nextReview,durationMs:Date.now()-startedAt,reason:yielded?'time-budget-yield':'finished' });
    if(!yielded){
      runtime.departureReviews=[...departureCandidates.values()].filter(r=>r.basisRevision===snapshot.observation.revision&&r.basisRevision===runtime.observed?.revision);
      if(runtime.departureReviews.length)host.saveWake();
    }
  }
