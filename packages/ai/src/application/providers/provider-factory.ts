import type { AgentProvider } from '../../controller/contracts/types.js';
import {ProviderError} from '../../controller/contracts/provider-error.js';
import { CodexProvider } from './codex.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import {GeminiProvider,geminiEnvironmentKey,DEFAULT_GEMINI_MODEL} from './gemini.js';

export class RoutingProvider implements AgentProvider {
  constructor(private readonly providers: ReadonlyMap<string, AgentProvider>, private readonly fallback: AgentProvider) {}
  step(request: import('../../controller/contracts/types.js').AgentRequest) {
    const provider=request.provider?this.providers.get(request.provider):this.fallback;
    if(!provider)return Promise.reject(new ProviderError('unknown',undefined,{stage:'prepare-request',reason:'model-not-supported',outcome:'not-sent'}));
    return provider.step(request);
  }
}

/** Build the server provider without exposing credentials to the browser. */
export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): AgentProvider {
  const kind = (env.AI_PROVIDER ?? 'codex').trim().toLowerCase();
  const geminiKey = geminiEnvironmentKey(env);
  const geminiModel = env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  const makeGemini = () => new GeminiProvider({apiKey:geminiKey,defaultModel:geminiModel,env,...(env.AI_PROVIDER_TIMEOUT_MS?{timeoutMs:Number(env.AI_PROVIDER_TIMEOUT_MS)}:{})});
  if (kind === 'codex') {
    const codex = new CodexProvider(env.CODEX_EXECUTABLE ?? 'codex');
    const apiKey = env.OPENAI_API_KEY ?? env.AI_API_KEY;
    if (!apiKey && !geminiKey) return new RoutingProvider(new Map([['codex',codex]]),codex);
    const providers = new Map<string, AgentProvider>([['codex', codex]]);
    if (apiKey) {
      const defaultModel = env.OPENAI_MODEL ?? env.AI_DEFAULT_MODEL;
      const compatible = new OpenAICompatibleProvider({ apiKey, baseUrl: env.OPENAI_BASE_URL ?? env.AI_BASE_URL ?? 'https://api.openai.com/v1', apiStyle: env.AI_API_STYLE === 'chat' ? 'chat' : 'responses', ...(defaultModel ? { defaultModel } : {}) });
      providers.set('openai-compatible', compatible);
      providers.set('deepseek', compatible);
      providers.set('openrouter', compatible);
    }
    if (geminiKey) providers.set('gemini', makeGemini());
    return new RoutingProvider(providers, codex);
  }
  if (kind === 'gemini') {
    if (!geminiKey) throw new Error('GEMINI_API_KEY is required');
    const gemini = makeGemini();
    return new RoutingProvider(new Map([['gemini', gemini]]), gemini);
  }
  if (kind === 'openai' || kind === 'openai-compatible') {
    const apiKey = env.OPENAI_API_KEY ?? env.AI_API_KEY ?? '';
    const baseUrl = env.OPENAI_BASE_URL ?? env.AI_BASE_URL ?? 'https://api.openai.com/v1';
    const responseFormat = env.OPENAI_RESPONSE_FORMAT ?? env.AI_RESPONSE_FORMAT;
    const apiStyle = env.AI_API_STYLE ?? 'responses';
    if (apiStyle !== 'responses' && apiStyle !== 'chat') throw new Error('Invalid AI API style');
    if (responseFormat !== undefined && responseFormat !== 'json_schema' && responseFormat !== 'json_object' && responseFormat !== 'none')
      throw new Error('Invalid OpenAI-compatible response format');
    const timeoutMs = env.AI_PROVIDER_TIMEOUT_MS ? Number(env.AI_PROVIDER_TIMEOUT_MS) : undefined;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000)) throw new Error('Invalid AI provider timeout');
    const defaultModel = env.OPENAI_MODEL ?? env.AI_DEFAULT_MODEL;
    const compatible = new OpenAICompatibleProvider({
      apiKey,
      baseUrl,
      ...(defaultModel ? { defaultModel } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(responseFormat !== undefined ? { responseFormat } : {}),
      apiStyle,
    });
    // Keep the configured provider as the fallback while allowing a seat to
    // explicitly select the same adapter by its stable UI id.
    const providers = new Map<string, AgentProvider>([['openai-compatible', compatible], ['deepseek', compatible], ['openrouter', compatible]]);
    if (geminiKey) providers.set('gemini', makeGemini());
    return new RoutingProvider(providers, compatible);
  }
  throw new Error(`Unsupported AI provider: ${kind}`);
}
