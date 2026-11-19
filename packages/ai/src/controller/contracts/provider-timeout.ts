import type {AgentRequest} from './types.js';
export function providerCallTimeout(effort:AgentRequest['effort'],timeoutMs?:number) {
  return timeoutMs??(effort==='high'?300_000:120_000);
}
