import type {
  AgentResult,
  AiSnapshot,
} from "@subterfuge/bot-sdk/contracts/types";
export const hybridResult = (
  tool: string,
  args: Record<string, unknown>,
  summary: string,
): AgentResult => ({
  tokens: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
  usageKnown: {
    provenance: "synthetic",
    input: true,
    output: true,
    cached: true,
  },
  reply: { tool, arguments: args, summary },
});
export function finishHybridRound(snapshot: Readonly<AiSnapshot>, summary: string) {
  return hybridResult("finish", {
    reminders: {
      cancel: (snapshot.reminders ?? []).filter(r=>['hybrid-review','bot-review'].includes(r.id)).map(r=>r.id),
      set: [],
    },
  }, summary);
}
