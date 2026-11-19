import { botPlanMemory } from "./plan-memory.js";
import { botWriteFeedback, acceptedInternalWrites } from "./feedback.js";
export { botNeedsAnalysis, botWriteFeedback } from "./feedback.js";
import type { AttackRoutes } from "../../../../contracts/src/index.js";
import { resolveBotSettings } from "../../../../contracts/src/index.js";
import { TICK_SECONDS } from "../../../../rules/src/index.js";
import type {
  AgentRequest,
  AgentResult,
  AiState,
  AiSnapshot,
  DecisionTask,
} from "../contracts/types.js";
import type { BotDecision } from "./bot-planner.js";
import { computeBot } from "./bot-worker.js";
import { presentOutpostNames } from "../presentation/outpost-references.js";
import type { BuiltPrompt } from "../contracts/decision-context.js";
import { buildLocalModeContext } from "../contracts/local-mode-context.js";

export function buildBotContext(
  state: AiState,
  snapshot: AiSnapshot,
): BuiltPrompt {
  return buildLocalModeContext(
    state,
    snapshot,
    "本地战术决策直接读取授权结构化观察，无模型提示词",
  );
}

/** Receipt acknowledgement is not a new strategic assessment. Reuse the
 * existing wake queue for military causes until an actual search. */
export function botMilitarySignals(task: DecisionTask | undefined) {
  return (
    task?.triggers?.filter(
      (signal) => signal.category === "military",
    ) ?? []
  );
}
/** Stateless turn adapter: authoritative same-round receipts suppress replay,
 * including after a process restart. No hidden mutable provider memory. */
export async function botStep(
  request: AgentRequest,
  state: AiState,
  snapshot: AiSnapshot,
  routes: AttackRoutes | undefined,
  feedback: unknown[],
  audit: (decision: BotDecision) => void,
  lastDecision?: { sequence: number; decision: BotDecision },
  onProgress?:import('../analysis/tactical-planner.js').BotPlannerOptions['onProgress'],
  reviewReminders:readonly string[]=['bot-review'],
): Promise<AgentResult> {
  if (request.commanderMode) throw Error("本地战术规划 不提供自然语言指挥官会话");
  if (state.commanderDirectives?.text.trim())
    throw Error("本地战术规划 无法执行自由文本指挥官指令；请先明确处理现有指令");
  await request.beforeSend?.();
  request.signal.throwIfAborted();
  const o = snapshot.observation,
    v = o.view,
    now = v.tick + o.secondsSinceLastTick / TICK_SECONDS,
    policy = resolveBotSettings(state.settings.bot);
  const militaryReview = botMilitarySignals(snapshot.task).length > 0;
  const { incumbentObjective, scoutedTargets, planNote } = botPlanMemory(
    snapshot,
    () =>
      lastDecision?.sequence === state.sequence
        ? lastDecision.decision
        : undefined,
    feedback,
  );
  const finish = (summary: string): AgentResult => ({
    tokens: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    usageKnown: {
      provenance: "synthetic",
      input: true,
      output: true,
      cached: true,
    },
    reply: {
      tool: "finish",
      summary,
      arguments: {
        memory: { strategy: summary.slice(0, 1000) },
        ...planNote(),
        reminders: {
          complete: (snapshot.reminders ?? [])
            .filter(
              (r) =>
                r.atSeconds <= now * TICK_SECONDS &&
                !reviewReminders.includes(r.id) && r.id!=="bot-activity",
            )
            .map((r) => r.id),
          cancel: (snapshot.reminders ?? []).filter(r=>reviewReminders.includes(r.id)||r.id==="bot-activity").map(r=>r.id),
          set: [],
        },
      },
    },
  });
  // Any write attempt in this round is acknowledged, not retried with a new
  // identity. The runner reconciles unknown outcomes before reaching here.
  const writes = botWriteFeedback(feedback);
  const internalAcknowledged =
    writes.length > 0 &&
    lastDecision?.sequence === state.sequence &&
    lastDecision.decision.policyDiagnostics?.executionPhase === "independent" &&
    acceptedInternalWrites(writes);
  if (writes.length && !internalAcknowledged) {
    const last = writes[writes.length - 1]!;
    return finish(
      `第${now.toFixed(2)}日：已处理本轮操作回执，等待实际结算；${typeof last.summary === "string" ? last.summary : "后续依据当前事实复查"}。接受不代表已抵达。`,
    );
  }
  if (snapshot.executionLedger?.pending.length)
    return finish("存在未决操作，先由执行账本核实，不重复提交。");
  if (!routes) throw Error("本地战术规划 缺少当前版本航程");
  // Only the already recorded independent phase can continue after its
  // receipts. Rejected/accepted commands are never reissued by this path.
  const protectedFleetIds =
    internalAcknowledged && !militaryReview
      ? v.fleets
          .filter(
            (f) =>
              f.owner === v.player &&
              f.state === "waiting" &&
              lastDecision!.decision.selected.drafts.some(
                (d) =>
                  d.action.kind === "launch" &&
                  d.action.source === f.source &&
                  d.action.destination === f.destination?.id,
              ),
          )
          .map((f) => f.id)
      : [];
  const decision = await computeBot(o, routes, {
    ...(onProgress?{onProgress}:{}),
    settings: policy,
    forecastCacheRound:state.sequence,
    signal: request.signal,
    skipInternal: internalAcknowledged,
    protectedFleetIds,
    scoutedTargets: [...scoutedTargets],
    ...(incumbentObjective ? { incumbentObjective } : {}),
  });
  audit(decision);
  lastDecision = { sequence: state.sequence, decision };
  request.signal.throwIfAborted();
  const mining = decision.mining,
    holding = mining
      ? `现有${mining.mineCount}矿、库存${mining.balance}，按当前库存失矿一次扣${mining.oneLossCost}；可见压力下参考守备缺口${mining.totalLocalShortfall === null ? "未知" : Math.ceil(mining.totalLocalShortfall)}兵（估算，非战果）。`
      : "";
  if (!decision.selected.drafts.length)
    return finish(
      `第${now.toFixed(2)}日：阶段${decision.situation.phase}，维持已有行动。${holding}比较${decision.coverage.evaluated}项方案，${decision.coverage.simulations}次模拟；${decision.coverage.complete ? "候选检查完成" : "计算范围有限"}。`,
    );
  const actions = decision.selected.drafts.map((d) => ({
    tool: "order",
    arguments: { action: presentOutpostNames(d.action, o.outpostNames ?? {}) },
  }));
  return {
    tokens: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    usageKnown: {
      provenance: "synthetic",
      input: true,
      output: true,
      cached: true,
    },
    reply: {
      tool: "batch",
      arguments: { actions },
      summary: `${decision.policyDiagnostics?.executionPhase === "independent" ? "本地内部调动" : "本地战术方案"} ${decision.selected.objective}：${decision.selected.reasons.join("；")}。${holding}${decision.coverage.simulations}次条件核验，不代表实际战果。`,
    },
  };
}
