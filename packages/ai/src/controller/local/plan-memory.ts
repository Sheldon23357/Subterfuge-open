import type { AiSnapshot } from "../contracts/types.js";
import type { BotDecision } from "./bot-planner.js";
import { resolveOutpostReferences } from "../presentation/outpost-references.js";
import { botWriteFeedback } from "./feedback.js";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A selected scout is only advice. Remember it after the matching launch
 * child was accepted, never after a rejected, unknown or untouched child. */
function acceptedScoutTargets(
  decision: BotDecision | undefined,
  feedback: readonly unknown[],
  observation: AiSnapshot["observation"],
): string[] {
  if (decision?.selected.kind !== "scout") return [];
  const accepted = new Set<string>();
  const canonical = (action: Record<string, unknown>) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(action).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  for (const row of botWriteFeedback(feedback)) {
    if (!object(row.arguments) || !object(row.result)) continue;
    const actions =
      row.tool === "batch" && Array.isArray(row.arguments.actions)
        ? row.arguments.actions
        : [{ tool: row.tool, arguments: row.arguments }];
    const receipts =
      row.tool === "batch" && Array.isArray(row.result.results)
        ? row.result.results
        : [
            {
              ...row.result,
              index: 0,
              status:
                row.result.status ??
                (object(row.result.commandReceipt)
                  ? row.result.commandReceipt.status
                  : undefined),
            },
          ];
    for (const receipt of receipts) {
      if (
        !object(receipt) ||
        receipt.status !== "accepted" ||
        !Number.isSafeInteger(receipt.index)
      )
        continue;
      const item = actions[Number(receipt.index)];
      if (
        !object(item) ||
        item.tool !== "order" ||
        !object(item.arguments) ||
        !object(item.arguments.action)
      )
        continue;
      let action: unknown;
      try {
        action = resolveOutpostReferences(item.arguments.action, observation);
      } catch {
        continue;
      }
      if (!object(action)) continue;
      for (const draft of decision.selected.drafts)
        if (
          canonical(action) === canonical(draft.action) &&
          typeof draft.action.destination === "string"
        )
          accepted.add(draft.action.destination);
    }
  }
  return decision.selected.targets.filter((id) => accepted.has(id));
}

/** Preserve strategic memory across independent prelude decisions and receipt-only steps. */
export function botPlanMemory(
  snapshot: AiSnapshot,
  currentDecision: () => BotDecision | undefined,
  feedback: readonly unknown[],
  priorPlan?:Record<string,unknown>,
) {
  const o = snapshot.observation,
    v = o.view;
  let incumbentObjective: string | undefined;
  const scoutedTargets = new Set<string>();
  let savedPlan: Record<string, unknown> | undefined;
  try {
    const note = snapshot.notebook?.find((n) => n.id === "bot-plan");
    const saved = priorPlan??(note ? JSON.parse(note.text) : null);
    if (saved?.format === "bot-plan/1") {
      savedPlan = saved;
      if (
        typeof saved.objective === "string" &&
        Number.isFinite(saved.atTick) &&
        saved.atTick <= v.tick &&
        v.tick - saved.atTick <= 144
      )
        incumbentObjective = saved.objective;
      if (Array.isArray(saved.scoutedTargets))
        for (const id of saved.scoutedTargets)
          if (typeof id === "string" && v.outposts.some((p) => p.id === id))
            scoutedTargets.add(id);
    }
  } catch {
    /* Invalid notes carry no authority and do not become current facts. */
  }
  const planData = () => {
    const decision = currentDecision();
    const independentReview = decision?.policyDiagnostics?.executionPhase === "independent";
    let data = savedPlan;
    if (decision) {
      if (independentReview && savedPlan) {
        data = { ...savedPlan };
        if (decision.selected.drafts.length)
          data.independentReview = {
            atTick: v.tick,
            objective: decision.selected.objective,
            targets: decision.selected.targets,
            basisRevision: decision.basisRevision,
            status: "await-current-facts",
          };
      } else {
        data = {
          format: "bot-plan/1",
          objective: decision.selected.objective,
          targets: decision.selected.targets,
          scoutedTargets: [
            ...new Set([
              ...scoutedTargets,
              ...acceptedScoutTargets(decision, feedback, o),
            ]),
          ],
          atTick: v.tick,
          phase: decision.situation.phase,
          basisRevision: decision.basisRevision,
          status: "await-current-facts",
        };
      }
    }
    return data;
  };
  const planNote = () => {
    const data=planData();
    return data
      ? {
          notebook: {
            set: [
              {
                id: "bot-plan",
                kind: "plan",
                priority: "high",
                text: JSON.stringify(data),
                expiresWorldDay: null,
              },
            ],
          },
        }
      : {};
  };
  return { incumbentObjective, scoutedTargets, planNote, planData };
}
