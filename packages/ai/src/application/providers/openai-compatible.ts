import { ProviderError, classifyProviderFailure } from '../../controller/contracts/provider-error.js';
import {EMPTY_MODEL_SCHEMA,parseModelJson,SemanticReplyParseError,MODEL_REPLY_CHAR_LIMIT} from '../../controller/contracts/model-json.js';
import {providerCallTimeout} from '../../controller/contracts/provider-timeout.js';
import type { AgentProvider, AgentRequest, ModelResult } from '../../controller/contracts/types.js';

export interface OpenAICompatibleOptions {
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  timeoutMs?: number;
  responseFormat?: 'json_schema' | 'json_object' | 'none';
  apiStyle?: 'chat' | 'responses';
  fetchImpl?: typeof fetch;
}

function endpoint(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}
function responsesEndpoint(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/responses$/i.test(trimmed)) return trimmed;
  // DeepSeek documents Responses at https://api.deepseek.com/responses,
  // while its Chat Completions endpoint commonly uses /v1.
  if (/^https?:\/\/api\.deepseek\.com\/v1$/i.test(trimmed)) return trimmed.slice(0, -3) + '/responses';
  return `${trimmed}/responses`;
}

function contentOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value.filter((part): part is { type?: unknown; text?: unknown } => !!part && typeof part === 'object')
      .filter(part => part.type === undefined || part.type === 'text')
      .map(part => typeof part.text === 'string' ? part.text : '').join('');
    if (text) return text;
  }
  throw new Error('Provider response did not contain text content');
}

/** Adapter for OpenAI Chat Completions compatible endpoints. */
export class OpenAICompatibleProvider implements AgentProvider {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: OpenAICompatibleOptions) {
    if (!options.apiKey.trim()) throw new Error('OpenAI-compatible API key is required');
    if (!options.baseUrl.trim()) throw new Error('OpenAI-compatible base URL is required');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async step(request: AgentRequest): Promise<ModelResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? providerCallTimeout(request.effort, request.timeoutMs));
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true });
    let dispatched=false,received=false;
    try {
      if (request.signal.aborted) throw new ProviderError('cancelled');
      const format = this.options.responseFormat ?? 'json_schema';
      const style = this.options.apiStyle ?? 'responses';
      const body: Record<string, unknown> = { model: request.model || this.options.defaultModel };
      // MiniMax defaults M3.1 Flash to max reasoning when this is omitted.
      // Scope the extension to its documented model and official endpoints.
      if(style==='chat'&&body.model==='MiniMax-M3.1-Flash'
        &&['api.minimaxi.com','api.minimax.cn','api.minimax.io'].includes(new URL(this.options.baseUrl).hostname)
        &&request.effort)body.reasoning_effort=request.effort;
      if(style==='chat'&&/^MiniMax-M[23]/.test(String(body.model))&&['api.minimaxi.com','api.minimax.cn','api.minimax.io'].includes(new URL(this.options.baseUrl).hostname))body.reasoning_split=true;
      // JSON-object/text endpoints do not transport a schema. Semantic callers
      // still need the complete output contract, including nested task fields.
      const prompt=request.responseSchema&&format!=='json_schema'?request.prompt+'\nRequired output JSON Schema:\n'+JSON.stringify(request.responseSchema):request.prompt;
      if (style === 'responses') body.input = prompt;
      else body.messages = [{ role: 'user', content: prompt }];
      if (!body.model || typeof body.model !== 'string') throw new ProviderError('unknown', undefined, { stage: 'prepare-request', reason: 'model-not-supported' });
      if (style === 'responses') {
        body.text = format === 'json_schema'
          ? { format: { type: 'json_schema', name: 'subterfuge_response', schema: request.responseSchema??EMPTY_MODEL_SCHEMA } }
          : format === 'json_object' ? { format: { type: 'json_object' } } : { format: { type: 'text' } };
      } else if (format === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'subterfuge_response', strict: !request.responseSchema, schema: request.responseSchema??EMPTY_MODEL_SCHEMA } };
      else if (format === 'json_object') body.response_format = { type: 'json_object' };
      dispatched=true;
      const response = await this.fetchImpl(style === 'responses' ? responsesEndpoint(this.options.baseUrl) : endpoint(this.options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();received=true;
      if (!response.ok) {
        const classified = classifyProviderFailure(`${response.status} ${raw.slice(0, 1000)}`);
        throw new ProviderError(classified.code, undefined, { stage: 'provider-http', reason: classified.diagnostic?.reason??`http-${response.status}`, httpStatus: response.status,outcome:[400,401,403,404,422,429].includes(response.status)?'rejected':'unknown' });
      }
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { throw new ProviderError('invalid-response', undefined, { stage: 'parse-response', reason: 'invalid-json',outputBytes:Buffer.byteLength(raw) }); }
      const envelope=payload as {id?:unknown;status?:unknown;error?:unknown;choices?:{finish_reason?:unknown;message?:{tool_calls?:unknown;function_call?:unknown;refusal?:unknown}}[];incomplete_details?:{reason?:unknown}|null}|null;
      const finish=style==='chat'?envelope?.choices?.[0]?.finish_reason:envelope?.incomplete_details?.reason;
      const status=style==='responses'?envelope?.status:finish;
      const terminal=finish??status;
      const finishReason=typeof terminal==='string'&&['stop','length','content_filter','tool_calls','function_call','max_output_tokens','end_turn','completed','incomplete','failed','cancelled','in_progress','queued'].includes(terminal)?terminal:undefined;
      const evidence={outputBytes:Buffer.byteLength(raw),...(finishReason?{finishReason}:{}),truncated:finishReason==='length'||finishReason==='max_output_tokens'};
      if(evidence.truncated)throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:'truncated-output',...evidence});
      if(style==='chat'){
        const message=envelope?.choices?.[0]?.message;
        if(finish!=='stop')throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:finish==null?'missing-completion-status':finish==='content_filter'?'blocked-output':'invalid-completion-status',...evidence});
        if(message?.tool_calls!=null&&(!Array.isArray(message.tool_calls)||message.tool_calls.length>0)||message?.function_call!=null)
          throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:'unexpected-tool-call',...evidence});
        if(message?.refusal)throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:'blocked-output',...evidence});
      }else if(status!=='completed'||envelope?.error!=null||envelope?.incomplete_details!=null){
        throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:status==null?'missing-completion-status':'invalid-completion-status',...evidence});
      }
      let content: unknown;
      if (style === 'responses') {
        const output = (payload as { output?: unknown[] })?.output;
        if(Array.isArray(output)&&output.some(item=>!item||typeof item!=='object'||!['message','reasoning'].includes(String((item as {type?:unknown}).type))))
          throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:'unexpected-tool-call',...evidence});
        const message = Array.isArray(output)?output.find((item): item is { type?: unknown; status?:unknown; content?: unknown[] } => !!item && typeof item === 'object' && (item as { type?: unknown }).type === 'message'):undefined;
        if(message?.status!=='completed')throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:message?.status==null?'missing-completion-status':'invalid-completion-status',...evidence});
        if(message.content?.some(item=>!!item&&typeof item==='object'&&(item as {type?:unknown}).type==='refusal'))
          throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:'blocked-output',...evidence});
        const part = Array.isArray(message?.content)?message.content.find((item): item is { type?: unknown; text?: unknown } => !!item && typeof item === 'object' && (item as { type?: unknown }).type === 'output_text'):undefined;
        content = part?.text;
      } else {
        const choice = (payload as { choices?: unknown[] })?.choices?.[0] as { message?: { content?: unknown } } | undefined;
        content = choice?.message?.content;
      }
      if (content === undefined) throw new ProviderError('invalid-response', undefined, { stage: 'parse-response', reason: 'missing-message-content',...evidence });
      let text:string;
      try{text=contentOf(content);}catch{throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:'invalid-text-content',...evidence});}
      const details={...evidence,contentCharacters:text.length};
      if(request.onOutput){
        const redacted=text.replaceAll(this.options.apiKey,'[redacted]');
        request.onOutput({text:redacted.slice(0,MODEL_REPLY_CHAR_LIMIT),characters:text.length,clipped:redacted.length>MODEL_REPLY_CHAR_LIMIT});
      }
      let reply;
      try { reply = parseModelJson(text); }
      catch(error) { throw new ProviderError('invalid-response', undefined, { stage: 'parse-response', reason: error instanceof SemanticReplyParseError?error.reason:'invalid-agent-envelope',...details,outputFormat:{...(error instanceof SemanticReplyParseError&&error.offset!==undefined?{jsonErrorOffset:error.offset}:{}),characters:text.length,startsWithObject:/^\s*\{/.test(text),codeFence:/^\s*```/.test(text),reasoningTag:/^\s*<think>/.test(text)}}); }
      const usage = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown }; input_tokens_details?: { cached_tokens?: unknown } } }).usage;
      const input=style==='responses'?usage?.input_tokens:usage?.prompt_tokens;
      const output=style==='responses'?usage?.output_tokens:usage?.completion_tokens;
      const valid=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
      const inputKnown=valid(input),outputKnown=valid(output);
      // Keep the legacy aggregate contract, while explicitly recording missing measurements.
      const inputTokens=inputKnown?input:0,outputTokens=outputKnown?output:0;
      const cached=style==='responses'?usage?.input_tokens_details?.cached_tokens:usage?.prompt_tokens_details?.cached_tokens;
      const cachedKnown=inputKnown&&valid(cached)&&cached<=inputTokens;
      const id=envelope?.id;
      const completion:NonNullable<ModelResult['completion']>={protocol:style,status:'completed',finishReason:style==='chat'?'stop':'completed',...(typeof id==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(id)&&!id.includes(this.options.apiKey)?{responseId:id}:{})};
      return {reply,completion,tokens:inputTokens+outputTokens,usage:{inputTokens,outputTokens,...(cachedKnown?{cachedInputTokens:cached}:{})},usageKnown:{provenance:'reported',input:inputKnown,output:outputKnown,cached:cachedKnown}};
    } catch (error) {
      const outcome=!dispatched?'not-sent':received?'completed':'unknown';
      if (error instanceof ProviderError) throw new ProviderError(error.code,error.timeoutSource,{...error.diagnostic,outcome:error.diagnostic?.outcome??outcome,stage:error.diagnostic?.stage??'provider-transport'});
      if (request.signal.aborted) throw new ProviderError('cancelled',undefined,{stage:'provider-transport',outcome});
      if (error instanceof DOMException && error.name === 'AbortError') throw new ProviderError('timeout', 'provider-call',{stage:'provider-transport',outcome});
      const classified = classifyProviderFailure(error instanceof Error ? error.message : String(error));
      throw new ProviderError(classified.code, classified.timeoutSource, {...classified.diagnostic,stage:classified.diagnostic?.stage??'provider-transport',outcome});
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', abort);
    }
  }
}
