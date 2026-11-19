import {settleHybridContractReceipts} from './server-contracts.js';
import {makeBrief} from './brief.js';
import {liveOperations} from './live-operations.js';
import type { BotMode } from "@subterfuge/bot-sdk/contracts/bot-mode";
import { buildLocalModeContext } from "@subterfuge/bot-sdk/contracts/local-mode-context";
import type { BotDecision } from "@subterfuge/bot-sdk/analysis/tactical-planner";
import { hybridCommanderPrompt } from "./commander.js";
import { HybridBackground } from "./background.js";
import { guardHybridExecution } from "./execution-guard.js";
import { runHybridForeground } from "./foreground.js";
import { awaitingCommander, feedbackRows,finalizeRoundOperations } from "./execution-recovery.js";
import type {
  HybridState,
  OperationState,
  TacticalFeedback,
  InternalTransferPhase,
} from "./contracts.js";
import { operationGuidance, constraints } from "./operations.js";
import { hybridHasModel } from './model-availability.js';
import { botStep,botNeedsAnalysis } from '@subterfuge/bot-sdk/local/bot-step';
import { finishHybridRound } from './round-result.js';
import { communicateHybrid } from './communication.js';
import { botPlanMemory } from '@subterfuge/bot-sdk/local/plan-memory';
import type {BotModeInput,BotModeServices} from '@subterfuge/bot-sdk/contracts/bot-mode';
import type {AgentRequest} from '@subterfuge/bot-sdk/contracts/types';
import {resolveBotSettings} from '@subterfuge/bot-sdk/contracts';

function hasGuidedWork(latest:BotModeServices['latest']):boolean {
  const saved=latest<HybridState>('state');
  return !!saved?.directive||!!saved?.intents?.some(t=>!['completed','cancelled','expired'].includes(t.status))
    ||!!saved?.messages.some(m=>['pending','unknown'].includes(m.status))
    ||!!latest<{operations:OperationState[]}>('operations')?.operations.some(o=>!['completed','ended','failed','cancelled','expired'].includes(o.status));
}

async function runHybrid(input:BotModeInput,request:AgentRequest,services:BotModeServices,options:HybridModeOptions){
  // Retain previously accepted constraints, intents and operation recovery
  // when a model is disabled. Only an unconstrained seat uses the local core.
  if(hybridHasModel(input.state.settings)||hasGuidedWork(services.latest)||input.snapshot.observation.diplomacy?.agreements.some(a=>a.status==='active')||services.latest<HybridState>('state')?.contractCommands?.some(c=>['pending','unknown'].includes(c.status)))
    return runHybridForeground(input,request,services,options.planner);
  if(input.state.commanderDirectives?.text.trim())
    return Promise.resolve(finishHybridRound(input.snapshot,'未配置模型，无法解析新的自然语言指挥官指令；保留现状并就绪。'));
  const result=await (options.localPlanner??botStep)(request,input.state,input.snapshot,input.routes,input.feedback,decision=>{
    services.record('decision',{sequence:input.state.sequence,decision});services.markAssessed();
  },services.latest<{sequence:number;decision:BotDecision}>('decision'),progress=>services.record('search-progress',{progress}),['hybrid-review','bot-review']);
  const previous=services.latest<{sequence:number;decision:BotDecision}>('decision');
  const plan=botPlanMemory(input.snapshot,()=>previous?.sequence===input.state.sequence?previous.decision:undefined,input.feedback,
    services.latest<{plan:Record<string,unknown>}>('local-plan')?.plan).planData();
  if(plan)services.record('local-plan',{plan});
  return result;
}

export interface HybridModeOptions {
 id?:string;
 briefPrompt?:typeof import('./prompts.js').hybridBriefPrompt;
 commanderPrompt?:NonNullable<BotMode['commanderPrompt']>;
 buildBrief?:typeof import('./brief.js').makeBrief;
 planner?:typeof import('@subterfuge/bot-sdk/analysis/tactical-worker').computeBot;
 localPlanner?:typeof botStep;
}
/** Components are fixed at composition time and shared only when explicitly supplied. */
export function createHybridMode(options:HybridModeOptions={}):BotMode {return {
  reviewReminders:['hybrid-review','bot-review'],
  commanderContextLimit:60_000,
  commanderReconciliationReceipt:'本次完成战略文字整理；后台执行意图是否已发布，请看分层协同中的任务状态，尚不代表出兵。',
  analysisWindows:{attackTicks:144,localTicks:144},
  deferStaleUntilNextTick:true,
  afterAction: (input,latest,record)=>{
    const operations=latest<{operations:OperationState[]}>('operations')?.operations;
    if(operations)record('operations',{operations:finalizeRoundOperations(input,operations)});
    const result=finishHybridRound(input.snapshot,'本轮行动已处理，后续行动留待下一轮。');
    const previous=latest<{sequence:number;decision:BotDecision}>('decision');
    const memory=botPlanMemory(input.snapshot,()=>previous?.sequence===input.state.sequence?previous.decision:undefined,input.feedback,
      latest<{plan:Record<string,unknown>}>('local-plan')?.plan);
    Object.assign(result.reply.arguments as object,memory.planNote());
    return result;
  },
  tacticalReviewAfterTicks:settings=>resolveBotSettings(settings.bot).reviewIntervalTicks-1,
  communicate: communicateHybrid,
  onReceipt: settleHybridContractReceipts,
  backgroundHandlesChat: true,
  commanderPrompt: options.commanderPrompt??hybridCommanderPrompt,
  id: options.id??"hybrid",
  recordPrefix: "mode-"+(options.id??"hybrid"),
  usesModelProvider: true,
  supportsCommander: true,
  serverBatch: true,
  automaticEventCoalesceMs: 1000,
  createBackground: (services) => new HybridBackground(services,undefined,options.buildBrief??((...args)=>makeBrief(args[0],args[1],args[2],args[3],args[4],args[5],options.briefPrompt))),
  retainSignals: (signals) =>
    signals.filter((s) => s.category === "military"),
  needsAnalysis: (feedback, context) =>
    context&&!hybridHasModel(context.state.settings)&&!hasGuidedWork(context.latest)
      &&!context.state.commanderDirectives?.text.trim()
      ?botNeedsAnalysis(feedback)
      :
    !(
      context &&
      awaitingCommander(
        context.state,
        context.latest<HybridState>("state")?.directive ?? null,
      )
    ) && feedbackRows([...feedback]).length === 0,
  diagnostics: (input) => {
    const decision = input.latest<{ decision: BotDecision }>(
        "decision",
      )?.decision,
      state = input.latest<HybridState>("state") ?? null,
      operations =
        input.latest<{ operations: OperationState[] }>("operations")
          ?.operations ?? [],
      o = input.observation;
    const guidance = o
      ? operationGuidance(
          o,
          state?.directive ?? null,
          operations,
          0,
          state ?? undefined,
        )
      : undefined;
    const chosen=decision?.assessments.find(a=>a.candidate.id===decision.selected.id);
    return {
      live:liveOperations(o,input.latest),
      botDecision:decision?{observedTick:decision.observedTick,current:o?.revision===decision.basisRevision,phase:decision.situation.phase,
        kind:decision.selected.kind,targets:decision.selected.targets,operations:decision.selected.drafts.length,reasons:decision.selected.reasons,
        coverage:decision.coverage,risk:decision.risk,unknowns:[...new Set([...(chosen?.score?.unknowns??[]),...(chosen?.stress?.unknowns??[])])],assumptions:decision.assumptions}:undefined,
      outpostDefense: decision?.risk
        ? {
            observedTick: decision.observedTick,
            current: o?.revision === decision.basisRevision,
            ...decision.risk,
          }
        : undefined,
      hybrid: {
        diplomacy:o?.diplomacy??null,
        state,
        feedback: input.latest<TacticalFeedback>("feedback") ?? null,
        operations,
        internalPhase:
          input.latest<InternalTransferPhase>("internal-phase") ?? null,
        guidance: o
          ? {
              observedTick: o.view.tick,
              worldDay: o.view.tick + o.secondsSinceLastTick / 600,
              ...(guidance ?? constraints(null, o, state ?? undefined)),
              objectives: guidance?.objectives ?? [],
              attackDefenseFactors: guidance?.attackDefenseFactors ?? [],
            }
          : null,
      },
    };
  },
  beforeExecute: guardHybridExecution,
  prepare: (input) => ({
    context: buildLocalModeContext(
      input.state,
      input.snapshot,
      "异步战略指导下的本地协同规划",
    ),
    run: (request, services) =>
      services.local(request, (admitted) =>
        runHybrid(input,admitted,services,options),
      ),
  }),
 };}
export const hybridMode=createHybridMode();
export function defineHybridMode(options:HybridModeOptions={},label='分层协同'):import('@subterfuge/bot-sdk/contracts/bot-mode').BotModeDefinition {
 return {id:options.id??'hybrid',label,capabilities:{model:true,commander:true,tacticalSettings:true,personalitySettings:true},validateConfig:config=>{if(config!==undefined)throw Error('Hybrid does not accept strategyConfig');},create:()=>createHybridMode(options)};
}
export const hybridDefinition=defineHybridMode();
