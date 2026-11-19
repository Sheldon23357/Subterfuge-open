/** Operational UTF-16 character ceiling, based on the 2026-10-23 AI06 replay:
 * 38,306–41,662 permanent and up to 68,800 with the two captured read workloads.
 * 200,000 leaves room for the notebook cap and several independent current reads.
 * This is not a provider token-window guarantee. Never clip, index for recall
 * or evict an active result to fit; reject the unsent request with exact counts. */
export const CONTEXT_HARD_CHARACTERS=200000;
export class ContextBudgetError extends Error {
  constructor(public readonly characters:number,public readonly sections:Record<string,number>){
    super(`上下文预算不足：完整必要内容共 ${characters} 字符，上限 ${CONTEXT_HARD_CHARACTERS}；未发送模型请求。`);
    this.name='ContextBudgetError';
  }
}
