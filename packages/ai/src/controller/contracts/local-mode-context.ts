import type { AiState, AiSnapshot } from "./types.js";
import { memoryContextMetrics, type BuiltPrompt } from "./decision-context.js";
import { RECEIPT_MEASUREMENT } from "../presentation/prompt-receipt-breakdown.js";

/** Local policies consume structured facts; this record serves diagnostics only. */
export function buildLocalModeContext(
  state: Readonly<AiState>,
  snapshot: Readonly<AiSnapshot>,
  reason: string,
): BuiltPrompt {
  return {
    prompt: "",
    promptContext: { unit: "characters", total: 0, sections: {} },
    promptTools: {
      unit: "characters",
      measurement: RECEIPT_MEASUREMENT,
      guide: {},
      results: { history: {}, feedback: {}, total: {} },
      sourceCharacters: { guide: 0, history: 0, feedback: 0 },
    },
    contextSelection: {
      mode: "task",
      goal: null,
      reason,
      entities: [],
      evidence: [],
      basisRevision: snapshot.observation.revision,
      outposts: {
        total: snapshot.observation.view.outposts.length,
        selected: snapshot.observation.view.outposts.length,
      },
      receipts: { full: 0, indexed: 0 },
    },
    memoryContext: memoryContextMetrics(state, snapshot),
  };
}
