import type {ErrorDiagnostic} from '../../../../contracts/src/index.js';
export type ProviderFailure='timeout'|'transient'|'invalid-response'|'authentication'|'quota'|'unavailable'|'native-tool'|'cancelled'|'unknown';
const descriptions:Record<ProviderFailure,string>={timeout:'模型回复超时，请恢复 AI 后重试。',transient:'模型服务暂时不可用，请稍后恢复 AI。','invalid-response':'模型回复格式不符合游戏协议，请恢复 AI 后重试。',authentication:'模型登录已失效，请完成本机登录后恢复 AI。',quota:'模型额度不足，请检查账号额度后恢复 AI。',unavailable:'模型执行器未能启动，请检查本机安装。','native-tool':'模型尝试调用游戏协议之外的工具，本轮已停止。',cancelled:'AI 已停止。',unknown:'模型调用失败，未获得可用回复，请恢复 AI 后重试。'};
export class ProviderError extends Error {
  constructor(readonly code:ProviderFailure,readonly timeoutSource?:'provider-call'|'round-deadline',readonly diagnostic?:ProviderDiagnostic){super(descriptions[code]);}
  /** Model-only recovery; this never authorizes replaying a game write. */
  get recoverableModelFailure(){return ['timeout','transient','invalid-response'].includes(this.code)||this.code==='unknown'&&this.diagnostic?.stage==='process-exit'&&this.diagnostic.reason==='no-recognized-provider-signal';}
  get outcome(){return this.diagnostic?.outcome??'unknown';}
  get retryable(){return ['timeout','transient','invalid-response'].includes(this.code)&&(this.outcome==='not-sent'||this.outcome==='rejected'||this.outcome==='completed'&&this.code==='invalid-response');}
}
/** Inspect diagnostics in memory only. Never return raw account/path/request text. */
export function classifyProviderFailure(text:string):ProviderError {
  const classified=(code:ProviderFailure,reason:string)=>new ProviderError(code,undefined,{stage:'provider-output',reason});
  if(/quota|usage limit|insufficient_quota|credit balance/i.test(text))return classified('quota','usage-or-quota-limit');
  if(/unauthorized|authentication|not logged|sign.?in|401|token.*expired/i.test(text))return classified('authentication','login-or-token-rejected');
  if(/429|rate.limit/i.test(text))return classified('transient','rate-limit');
  if(/502|503|overload|temporar/i.test(text))return classified('transient','provider-unavailable');
  if(/stream.*(error|closed|disconnect|ended|interrupt)|SSE.*(?:error|closed|disconnect)/i.test(text))return classified('transient','stream-interrupted');
  if(/connection|network|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(text))return classified('transient','provider-network');
  if(/(?:unsupported|unknown|not.found|does not exist).*model|model.*(?:unsupported|not supported|not.found|does not exist)/i.test(text))return classified('unknown','model-not-supported');
  if(/context.{0,30}(?:length|window|limit)|maximum.{0,20}tokens/i.test(text))return classified('unknown','context-limit');
  if(/unexpected argument|unknown (?:option|flag)|unrecognized (?:option|flag)/i.test(text))return classified('unknown','unsupported-cli-option');
  if(/permission denied|EACCES|EPERM/i.test(text))return classified('unknown','executor-permission-denied');
  return classified('unknown','no-recognized-provider-signal');
}
export interface ProviderDiagnostic {
  /** Transport evidence, never inferred from HTTP 5xx or a transient label. */
  outcome?:'not-sent'|'rejected'|'completed'|'unknown';
  stage:string;reason?:string;durationMs?:number;exitCode?:number|null;exitSignal?:string|null;
  outputFormat?:{jsonErrorOffset?:number;characters:number;startsWithObject:boolean;codeFence:boolean;reasoningTag:boolean};
  outputBytes?:number;contentCharacters?:number;finishReason?:string;truncated?:boolean;timeoutMs?:number;httpStatus?:number;cause?:ErrorDiagnostic;
  evidence?:import('./provider-evidence.js').ProviderEvidenceSummary;
  process?:{pid?:number;spawnMs?:number;exitMs?:number;closeMs?:number;stopRequestedMs?:number;stopReason?:'provider-timeout'|'round-deadline'|'cancelled'|'output-limit'|'rate-limit';timeoutLagMs?:number;stdinError?:ErrorDiagnostic;killError?:ErrorDiagnostic};
}
/** Session API boundary: copy only adapter-generated codes and measurements.
 * Arbitrary upstream text, process details and nested causes never cross it. */
export function safeSessionDiagnostic(d?:ProviderDiagnostic):ProviderDiagnostic {
 const stages=['prepare-request','provider-http','parse-response','provider-transport','provider-output'];
 const reasons=['invalid-json','missing-message-content','invalid-agent-envelope','invalid-semantic-json','invalid-semantic-object','semantic-output-limit','invalid-text-content','truncated-output','missing-completion-status','invalid-completion-status','unexpected-tool-call','blocked-output','region-unavailable','usage-or-quota-limit','login-or-token-rejected','rate-limit','provider-unavailable','stream-interrupted','provider-network','model-not-supported','context-limit','no-recognized-provider-signal'];
 const result:ProviderDiagnostic={stage:d&&stages.includes(d.stage)?d.stage:'redacted-provider',outcome:d&&['not-sent','rejected','completed','unknown'].includes(d.outcome??'')?(d.outcome??'unknown'):'unknown'};
 if(d?.reason&&(reasons.includes(d.reason)||/^http-[1-5]\d{2}$/.test(d.reason)))result.reason=d.reason;
 for(const key of ['httpStatus','outputBytes','contentCharacters','durationMs','timeoutMs'] as const){
  const n=d?.[key];if(typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&(key!=='httpStatus'||n>=100&&n<=599))result[key]=n;
 }
 if(d?.finishReason&&['stop','length','content_filter','tool_calls','function_call','max_output_tokens','end_turn','completed','incomplete','failed','cancelled','in_progress','queued'].includes(d.finishReason))result.finishReason=d.finishReason;
 if(d?.outputFormat){const f=d.outputFormat;if(Number.isSafeInteger(f.characters)&&f.characters>=0&&[f.startsWithObject,f.codeFence,f.reasoningTag].every(v=>typeof v==='boolean'))result.outputFormat={...(f.jsonErrorOffset!==undefined&&Number.isSafeInteger(f.jsonErrorOffset)&&f.jsonErrorOffset>=0?{jsonErrorOffset:f.jsonErrorOffset}:{}),characters:f.characters,startsWithObject:f.startsWithObject,codeFence:f.codeFence,reasoningTag:f.reasoningTag};}
 if(typeof d?.truncated==='boolean')result.truncated=d.truncated;
 return result;
}
