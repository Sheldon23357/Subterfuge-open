import {
  recoverHybridRound,
  awaitingCommander,
  refreshHybridSnapshot as refreshSnapshot,
} from "./execution-recovery.js";
import {
  hybridResult as result,
  finishHybridRound as finish,
} from "./round-result.js";
import type {
  BotModeInput,
  BotModeServices,
} from "@subterfuge/bot-sdk/contracts/bot-mode";
import type {
  AgentRequest,
  AgentResult,
} from "@subterfuge/bot-sdk/contracts/types";
import { presentOutpostNames } from "@subterfuge/bot-sdk/presentation/outpost-references";
import { computeBot } from "@subterfuge/bot-sdk/analysis/tactical-worker";
import type { BotDecision } from "@subterfuge/bot-sdk/analysis/tactical-planner";
import {proposalDecision} from './tactical-material.js';
import { attackRoutes } from "@subterfuge/bot-sdk/prediction";
import { resolveBotSettings } from "@subterfuge/bot-sdk/contracts";
import {
  reconcileIntents,
  configurationCandidates,
  intentBindings,
  fleetIntentDraft,
} from "./intents.js";
import { diplomacyNeeds } from "./diplomacy-pressure.js";
import {
  basisOf,
  type HybridState,
  type OperationState,
  type TacticalFeedback,
} from "./contracts.js";
import {
  reconcileOperations,
  operationGuidance,
  mergeOperationProgress,
} from "./operations.js";
import { validateTacticalProposal } from "./tactical-validation.js";
import { commanderProtectedFleets,commanderPlanIssue } from './commander-commitments.js';
import { botPlanMemory } from '@subterfuge/bot-sdk/local/plan-memory';
import {contractCommandStep} from './server-contracts.js';
export async function runHybridForeground(
  input: BotModeInput,
  request: AgentRequest,
  services: BotModeServices,
  planner:typeof computeBot=computeBot,
): Promise<AgentResult> {
  await request.beforeSend?.();
  request.signal.throwIfAborted();
  const prior=services.latest<{sequence:number;decision:BotDecision}>('decision');
  const remembered=botPlanMemory(input.snapshot,()=>prior?.sequence===input.state.sequence?prior.decision:undefined,input.feedback,
    services.latest<{plan:Record<string,unknown>}>('local-plan')?.plan??{format:'bot-plan/1'}).planData();
  if(remembered)services.record('local-plan',{plan:remembered});
  const recovered = await recoverHybridRound(input, request, services);
  if ("finished" in recovered) return recovered.finished;
  const s = input.state;
  let { snapshot, saved, operations, internal } = recovered;
  const { writes, retry } = recovered;
  let o = snapshot.observation;
  if (snapshot.executionLedger?.pending.length)
    return finish(snapshot, "未决写入由现有账本查账，禁止重发。");
  const directive = saved.directive;
  const cv = s.commanderDirectives?.version ?? 0;
  const planIssue=commanderPlanIssue(saved,o);
  if(planIssue)return finish(snapshot,planIssue+'；保留现状，等待后台重新整理并就绪。');
  if (awaitingCommander(s, directive))
    return finish(
      snapshot,
      "正在将已确认指挥官意图转为战略约束；本轮保持现状并就绪。",
    );
  const fleetCommands: NonNullable<ReturnType<typeof fleetIntentDraft>>[] = [],
    excluded = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const next = fleetIntentDraft(o, saved, operations, excluded, 'commander');
    if (!next) break;
    fleetCommands.push(next);
    excluded.add(next.task.id);
  }
  services.record("state", saved as unknown as Record<string, unknown>);
  if (fleetCommands.length) {
    const operation: OperationState = {
      id: "operation-" + s.sequence,
      phase: "fleet-intent",
      objective: fleetCommands
        .map((c) => c.task.spec.kind + ":" + c.task.id)
        .join("+"),
      basis: basisOf(o, cv),
      strategyVersion: directive?.version ?? 0,
      status: "proposed",
      intentBindings: fleetCommands.map((c) => ({
        id: c.task.id,
        version: c.task.version,
      })),
      drafts: fleetCommands.map((c) => c.draft),
      feedbackAfter: writes.map((r) => r.id),
      orders: [],
      fleets: [],
      issues: [],
    };
    operations = operations
      .filter((p) => p.id !== operation.id)
      .concat(operation);
    services.record("operations", { operations });
    return result(
      "batch",
      {
        actions: fleetCommands.map((c) => ({
          tool: "order",
          arguments: { action: c.draft.action },
        })),
      },
      "执行舰队返航意图；按实际回执跟踪",
    );
  }
  const contract=contractCommandStep(saved,o,services,cv);
  if(contract)return contract;
  const policy = resolveBotSettings(s.settings.bot),
    started = performance.now();
  const memory=botPlanMemory(snapshot,()=>undefined,[],services.latest<{plan:Record<string,unknown>}>('local-plan')?.plan??{format:'bot-plan/1'});
  const guidance = operationGuidance(
    o,
    directive,
    operations,
    s.sequence,
    saved,
  );
  const skipInternal = internal?.sequence === s.sequence;
  if (
    skipInternal &&
    internal &&
    internal.status === "accepted" &&
    !internal.strategyStarted
  ) {
    internal = { ...internal, strategyStarted: true };
    services.record(
      "internal-phase",
      internal as unknown as Record<string, unknown>,
    );
  }
  const protectedFleetIds = [
    ...commanderProtectedFleets(o,saved,operations),
    ...(skipInternal && internal
      ? operations
          .filter((p) => p.id === internal?.operationId)
          .flatMap((p) => [...p.orders, ...p.fleets])
      : []),
    ...(saved.intents ?? []).flatMap((t) =>
      "fleetId" in t.spec && !["cancelled", "expired"].includes(t.status)
        ? [t.spec.fleetId]
        : [],
    ),
  ];
  const phases = {
    internalTransfers: !skipInternal,
    preludeIndependent: !skipInternal,
    protectedFleetIds,
  };
  let routes =
    input.routes?.roomId === o.roomId &&
    input.routes.revision === o.revision &&
    input.routes.observedTick === o.view.tick
      ? input.routes
      : attackRoutes(o, { attackTicks: 144, localTicks: 144, holdTicks: 24 });
  let decision: BotDecision;
  const preludeCandidates = skipInternal
    ? []
    : configurationCandidates(o, routes, saved, operations);
  services.record("state", saved as unknown as Record<string, unknown>);
  const previousSearch = retry
    ? services.latest<{ sequence: number; decision: BotDecision }>("search")
    : undefined;
  try {
    decision =
      previousSearch?.sequence === s.sequence
        ? previousSearch.decision
        : await planner(o, routes, {
            ...phases,
            onProgress:progress=>services.record('search-progress',{progress}),
            preludeCandidates,
            settings: policy,
            scoutedTargets:[...memory.scoutedTargets],
            ...(memory.incumbentObjective?{incumbentObjective:memory.incumbentObjective}:{}),
            ...(guidance ? { guidance } : {}),
            maxElapsedMs: policy.maxElapsedMs,
            maxSimulations: policy.maxSimulations,
            forecastCacheRound:s.sequence,
            signal: request.signal,
          });
  } catch (error) {
    if (request.signal.aborted) throw error;
    services.record("search-failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return finish(snapshot, "计算未形成完整方案，保留现有行动并下轮复查。");
  }
  services.record("search", { sequence: s.sequence, decision });
  if(previousSearch?.sequence!==s.sequence)services.markAssessed();
  const before = o;
  let repaired = false;
  if (services.refreshSnapshot) {
    snapshot = await refreshSnapshot(services, snapshot, request);
    o = snapshot.observation;
    saved = services.latest<HybridState>("state") ?? saved;
    if (
      retry ||
      before.revision !== o.revision ||
      before.view.tick !== o.view.tick ||
      before.secondsSinceLastTick !== o.secondsSinceLastTick
    ) {
      if (!decision.selected.drafts.length)
        return finish(snapshot, "本轮搜索未选择行动；后续按当前事实复查。");
      routes = attackRoutes(o, {
        attackTicks: 144,
        localTicks: 144,
        holdTicks: 24,
      });
      const searchBasis = {
          revision: decision.basisRevision,
          tick: decision.observedTick,
        },
        validationStarted = performance.now();
      const currentGuidance = operationGuidance(
        o,
        saved.directive,
        reconcileOperations(operations, o),
        s.sequence,
        saved,
      );
      try {
        decision = await validateTacticalProposal(decision, o, routes, {
          ...(currentGuidance ? { guidance: currentGuidance } : {}),
          protectedFleetIds,
          signal: request.signal,
          forecastCacheRound:s.sequence,
        });
        repaired = true;
        services.record("validation", {
          searchBasis,
          basis: basisOf(o, cv),
          decision,
          elapsedMs: performance.now() - validationStarted,
        });
      } catch (error) {
        if (request.signal.aborted) throw error;
        services.record("validation-failed", {
          searchBasis,
          basis: basisOf(o, cv),
          reason: error instanceof Error ? error.message : String(error),
        });
        return finish(
          snapshot,
          "当前方案复核未完成，保留现有行动并尽快复查。",
        );
      }
    }
  }
  saved = structuredClone(services.latest<HybridState>("state") ?? saved);
  operations = reconcileOperations(
    mergeOperationProgress(
      operations,
      services.latest<{ operations: OperationState[] }>("operations")
        ?.operations ?? [],
    ),
    o,
    services.receipt,
  );
  const feedback: TacticalFeedback = {
    basis: basisOf(o, cv),
    strategyVersion: saved.directive?.version ?? 0,
    coverage: decision.coverage,
    objects: [
      ...o.view.outposts
        .filter((p) => p.owner === o.view.player)
        .map((p) => ({
          id: p.id,
          kind: "outpost",
          available: p.drillers ?? null,
          status: decision.assessments.some((a) =>
            a.candidate.drafts.some((d) => d.action.source === p.id),
          )
            ? "assessed"
            : "observed-awaiting-search",
        })),
      ...o.view.fleets
        .filter((f) => f.owner === o.view.player)
        .map((f) => ({
          id: f.id,
          kind: "fleet",
          available: f.drillers,
          status: decision.assessments.some((a) =>
            a.candidate.drafts.some((d) => d.action.fleetId === f.id),
          )
            ? "assessed"
            : "observed-awaiting-search",
        })),
    ],
    proposals: decision.assessments.map((a) => ({
      id: a.candidate.id,
      objective: a.candidate.objective,
      actor: String(a.candidate.drafts[0]?.action.source ?? "campaign"),
      drafts: a.candidate.drafts,
      dependencies: a.candidate.targets,
      basis: basisOf(o, cv),
      strategyVersion: saved.directive?.version ?? 0,
      utility: a.score?.utility ?? null,
      decision: proposalDecision(a),
      status: a.status,
    })),
    selected: decision.selected.objective,
    selectedProposalId: decision.selected.id,
    limitations: decision.assumptions,
    diplomacyNeeds: diplomacyNeeds(o, decision, saved, operations),
  };
  services.record("feedback", feedback as unknown as Record<string, unknown>);
  services.record("decision", {
    sequence:s.sequence,
    decision,
    repaired,
    elapsedMs: performance.now() - started,
  });
  const plan=botPlanMemory(snapshot,()=>decision,[],services.latest<{plan:Record<string,unknown>}>('local-plan')?.plan??{format:'bot-plan/1'}).planData();
  if(plan)services.record('local-plan',{plan});
  if (!decision.selected.drafts.length)
    return finish(
      snapshot,
      "本轮没有已验证且更优的行动，维持现状。",
    );
  const internalSelected =
    decision.policyDiagnostics?.executionPhase === "independent";
  const operation: OperationState = {
    id: "operation-" + s.sequence + (internalSelected ? "-internal" : ""),
    phase: internalSelected ? "internal" : "strategy",
    feedbackAfter: writes.map((row) => row.id),
    objective: decision.selected.objective,
    basis: basisOf(o, cv),
    strategyVersion: saved.directive?.version ?? 0,
    status: "proposed",
    intentBindings: intentBindings(saved, decision.selected),
    drafts: decision.selected.drafts,
    orders: [],
    fleets: [],
    issues: [],
  };
  operations = operations.filter((p) => p.id !== operation.id);
  operations.push(operation);
  services.record("operations", { operations });
  if (internalSelected) {
    internal = {
      sequence: s.sequence,
      operationId: operation.id,
      status: "proposed",
      strategyStarted: false,
      receiptIds: [],
    };
    services.record(
      "internal-phase",
      internal as unknown as Record<string, unknown>,
    );
  }
  return {
    ...result(
      "batch",
      {
        actions: decision.selected.drafts.map((d) => ({
          tool: "order",
          arguments: {
            action: presentOutpostNames(d.action, o.outpostNames ?? {}),
          },
        })),
      },
      "分层协同：" + decision.selected.objective + "；条件推演不代表实际战果。",
    ),
    executionObservation: o,
  };
}
