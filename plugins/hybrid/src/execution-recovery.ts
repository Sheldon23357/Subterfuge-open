import type {
  BotModeInput,
  BotModeServices,
} from "@subterfuge/bot-sdk/contracts/bot-mode";
import type {
  AgentRequest,
  AiSnapshot,
} from "@subterfuge/bot-sdk/contracts/types";
import { resolveOutpostReferences } from "@subterfuge/bot-sdk/presentation/outpost-references";
import {
  initialHybridState,
  type HybridState,
  type OperationState,
  type InternalTransferPhase,
} from "./contracts.js";
import {
  reconcileDiplomacy,
  settleDiplomacyMessage,
} from "./diplomacy-execution.js";
import { reconcileStrategy } from "./strategy-freshness.js";
import { compactHybrid } from "./compact.js";
import { reconcileIntents } from "./intents.js";
import {
  reconcileOperations,
  operationActivity,
  mergeOperationProgress,
  acceptOperationReceipt,
} from "./operations.js";
import { finishHybridRound as finish } from "./round-result.js";

export function feedbackRows(feedback: unknown[]) {
  return feedback.filter(
    (
      x,
    ): x is {
      tool: string;
      id: string;
      arguments: Record<string, unknown>;
      result: Record<string, unknown>;
    } =>
      !!x &&
      typeof x === "object" &&
      ["order", "batch", "say"].includes(
        String((x as { tool?: unknown }).tool),
      ),
  );
}
export function awaitingCommander(
  state: BotModeInput["state"],
  directive: HybridState["directive"],
) {
  return (
    !!state.commanderDirectives?.text.trim() &&
    directive?.commanderVersion !== state.commanderDirectives.version
  );
}
function matchesOperation(
  row: ReturnType<typeof feedbackRows>[number],
  operation: OperationState,
  o: AiSnapshot["observation"],
) {
  const actions = row.arguments.actions;
  if (!Array.isArray(actions) || actions.length !== operation.drafts.length)
    return false;
  const key = (a: Record<string, unknown>) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(a).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  try {
    return actions.every(
      (item, i) =>
        item?.tool === "order" &&
        item.arguments &&
        key(
          resolveOutpostReferences(item.arguments.action, o) as Record<
            string,
            unknown
          >,
        ) === key(operation.drafts[i]!.action),
    );
  } catch {
    return false;
  }
}
/** Receipt-only finalization; no snapshot refresh, repair or tactical search. */
export function finalizeRoundOperations(input:BotModeInput,operations:OperationState[]){
 const next=structuredClone(operations),o=input.snapshot.observation;
 for(const row of feedbackRows(input.feedback)){
  if(row.tool!=='batch'||!row.id?.startsWith(`ai-${input.state.lobbySeat}-${input.state.sequence}-`))continue;
  const pending=next.find(p=>(p.id===`operation-${input.state.sequence}`||p.id===`operation-${input.state.sequence}-internal`)
   &&['proposed','review'].includes(p.status)&&!p.receiptIds?.includes(row.id)&&matchesOperation(row,p,o));
  if(pending)acceptOperationReceipt(pending,row,o);
 }
 return reconcileOperations(next,o);
}
export async function refreshHybridSnapshot(
  services: BotModeServices,
  previous: Readonly<AiSnapshot>,
  request: AgentRequest,
): Promise<AiSnapshot> {
  const snapshot = await services.refreshSnapshot!();
  request.signal.throwIfAborted();
  if (
    snapshot.observation.roomId !== previous.observation.roomId ||
    snapshot.observation.view.player !== previous.observation.view.player ||
    snapshot.chatPlayer !== previous.chatPlayer
  )
    throw Error("Hybrid refresh changed identity");
  return snapshot;
}
/** Reconcile durable attempts and actual receipts before admitting new work. */
export async function recoverHybridRound(
  input: BotModeInput,
  request: AgentRequest,
  services: BotModeServices,
) {
  let snapshot = input.snapshot;
  const s = input.state;
  let o = snapshot.observation;
  let saved = structuredClone(
    services.latest<HybridState>("state") ?? initialHybridState(),
  );
  reconcileDiplomacy(saved, o);
  if (reconcileStrategy(o, saved))
    services.record("state", saved as unknown as Record<string, unknown>);
  let operations = reconcileOperations(
    services.latest<{ operations: OperationState[] }>("operations")
      ?.operations ?? [],
    o,
    services.receipt,
  );
  const cut = services.latest<{ cursor: number }>("operation-activity");
  if (
    services.readActivity &&
    o.activityCursor !== undefined &&
    operations.some(
      (p) => !["completed", "ended", "cancelled", "failed"].includes(p.status),
    )
  ) {
    const after = cut?.cursor ?? 0;
    if (after < o.activityCursor) {
      try {
        const history = await operationActivity(
          operations,
          o,
          after,
          services.readActivity,
          services.receipt,
        );
        operations = mergeOperationProgress(
          history.operations,
          services.latest<{ operations: OperationState[] }>("operations")
            ?.operations ?? [],
        );
        services.record("operations", { operations });
        services.record("operation-activity", { cursor: history.cursor });
      } catch (error) {
        services.record("operation-activity-blocked", {
          cursor: after,
          reason: error instanceof Error ? error.message : "结算事实补查失败",
        });
        return {
          finished: finish(
            snapshot,
            "结算事实补查暂时失败；保留未决操作，下轮继续查账。",
          ),
        };
      }
    }
  }
  saved = structuredClone(services.latest<HybridState>("state") ?? saved);
  reconcileDiplomacy(saved, o);
  operations = compactHybrid(saved, operations, snapshot.chatPlayer);
  for (const m of saved.messages.filter((m) => m.status === "unknown")) {
    const attempt = !m.requestId
      ? services.attemptReceipt?.("message-attempt", m.id)
      : undefined;
    if (attempt) m.requestId = attempt.requestId;
    const row = (attempt?.receipt ??
      (m.requestId ? services.receipt?.(m.requestId) : undefined)) as
      | {
          result?: {
            status?: string;
            protocolReceipt?: { effectCommitted?: boolean };
          };
        }
      | undefined;
    if (
      row?.result?.status === "accepted" &&
      row.result.protocolReceipt?.effectCommitted
    )
      settleDiplomacyMessage(saved, m.id, "accepted", o);
    else if (["rejected", "not-executed"].includes(row?.result?.status ?? ""))
      settleDiplomacyMessage(saved, m.id, "failed", o);
  }
  for (const p of operations.filter(
    (p) => p.status === "review" && !p.receiptIds?.length && !p.orders.length,
  )) {
    const evidence = services.attemptReceipt?.("operations", p.id)?.receipt as
      | { result?: { status?: string; reason?: string } }
      | undefined;
    if (evidence?.result?.status === "not-executed") {
      p.status = "cancelled";
      p.finishedAt = o.view.tick;
      p.issues = [evidence.result.reason ?? "实际审计确认方案提交前已作废"];
    }
  }
  let internal = services.latest<InternalTransferPhase>("internal-phase");
  const writes = feedbackRows(input.feedback);
  const freshWrites = writes.filter(
    (row) =>
      !internal?.receiptIds.includes(row.id) &&
      !operations.some((p) => p.receiptIds?.includes(row.id)),
  );
  const rejected =
    freshWrites.length === 1 &&
    freshWrites[0]!.tool === "batch" &&
    Array.isArray(freshWrites[0]!.result.results)
      ? (freshWrites[0]!.result.results as Record<string, unknown>[])
      : [];
  const repairable =
    rejected.length > 0 &&
    rejected.every(
      (r) =>
        r.status === "not-executed" ||
        (r.status === "rejected" &&
          r.outcome === "rejected" &&
          r.code === "REVISION_CONFLICT"),
    ) &&
    rejected.some((r) => r.status === "rejected");
  const repairAttempt = services.latest<{ sequence: number }>("repair-attempt");
  const retry =
    repairable &&
    !(internal?.sequence === s.sequence && !internal.strategyStarted) &&
    repairAttempt?.sequence !== s.sequence &&
    !!services.refreshSnapshot;
  if (retry) {
    services.record("repair-attempt", {
      sequence: s.sequence,
      originalBasis: o.revision,
      reason: "definitely-rejected-revision-conflict",
    });
    snapshot = await refreshHybridSnapshot(services, snapshot, request);
    o = snapshot.observation;
    saved = structuredClone(services.latest<HybridState>("state") ?? saved);
    operations = operations.map((p) =>
      p.id === "operation-" + s.sequence
        ? ({
            ...p,
            status: "review",
            issues: ["原批次确定未生效，当前依据下只修复一次"],
          } as OperationState)
        : p,
    );
  }
  if (writes.length && !retry) {
    for (const row of writes) {
      if (row.tool === "say") {
        const attempt = services.latest<{ id: string; sequence: number }>(
          "message-attempt",
        );
        const m = saved.messages.find((m) => m.id === attempt?.id);
        if (m && attempt?.sequence === s.sequence) {
          m.requestId = row.id;
          settleDiplomacyMessage(
            saved,
            m.id,
            (row.result.status === "accepted" && !row.result.error) ||
              (row.result.accepted === true && row.result.status === "sent") ||
              (row.result.protocolReceipt &&
                (row.result.protocolReceipt as { state?: string }).state ===
                  "applied") ||
              (typeof row.result.message === "object" &&
                row.result.message !== null &&
                (row.result.message as { from?: unknown }).from ===
                  snapshot.chatPlayer)
              ? "accepted"
              : row.result.status === "unknown" ||
                  row.result.outcome === "unknown"
                ? "unknown"
                : "failed",
            o,
          );
        }
      }
      const operationId = "operation-" + row.id?.split("-")[2];
      const pending = operations.find(
        (p) =>
          (p.id === operationId || p.id === operationId + "-internal") &&
          ["proposed", "review"].includes(p.status) &&
          !p.feedbackAfter?.includes(row.id) &&
          !p.receiptIds?.includes(row.id) &&
          (!p.feedbackAfter || matchesOperation(row, p, o)),
      );
      if (pending && row.tool === "batch") {
        const items = Array.isArray(row.result.results)
          ? (row.result.results as Record<string, unknown>[])
          : [];
        if (!acceptOperationReceipt(pending, row, o)) {
          pending.status = "review";
          pending.issues = ["批次回执身份或子项索引不完整，保留核验"];
        }
        if (pending.status === "review")
          pending.issues = ["部分命令未确认成功；按各子项真实回执继续"];
        if (
          pending.phase === "internal" &&
          internal?.sequence === s.sequence &&
          internal.operationId === pending.id
        ) {
          internal = {
            ...internal,
            status: pending.status === "accepted" ? "accepted" : "closed",
            receiptIds: pending.receiptIds ?? [],
          };
          services.record(
            "internal-phase",
            internal as unknown as Record<string, unknown>,
          );
        }
      }
    }
    operations = reconcileOperations(operations, o, services.receipt);
    reconcileIntents(o, saved, operations);
    services.record("state", saved as unknown as Record<string, unknown>);
    services.record("operations", { operations });
    const continueStrategy =
      internal?.sequence === s.sequence &&
      internal.status === "accepted" &&
      !internal.strategyStarted &&
      writes.every((row) => internal!.receiptIds.includes(row.id));
    if (!continueStrategy)
      return {
        finished: finish(
          snapshot,
          "已核对本轮实际回执，持续任务等待事实更新；接受不代表抵达。",
        ),
      };
    if (!services.refreshSnapshot)
      return {
        finished: finish(
          snapshot,
          "内部调兵已接受，等待刷新授权观察后继续战略规划；接受不代表抵达。",
        ),
      };
    snapshot = await refreshHybridSnapshot(services, snapshot, request);
    o = snapshot.observation;
    saved = structuredClone(services.latest<HybridState>("state") ?? saved);
    operations = reconcileOperations(
      services.latest<{ operations: OperationState[] }>("operations")
        ?.operations ?? operations,
      o,
    );
  }
  operations = reconcileOperations(operations, o, services.receipt);
  reconcileIntents(o, saved, operations);
  services.record("state", saved as unknown as Record<string, unknown>);
  services.record("operations", { operations });
  return { snapshot, saved, operations, internal, writes, retry };
}
