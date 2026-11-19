import {CodexProvider} from './providers/codex.js';
import {readBoundedResponse} from './bounded-response.js';
import {OpenAICompatibleProvider} from './providers/openai-compatible.js';
import {GeminiProvider,geminiEnvironmentKey,DEFAULT_GEMINI_MODEL,GEMINI_NATIVE_BASE_URL,readGeminiResponse} from './providers/gemini.js';
import {ProviderError,safeSessionDiagnostic} from '../controller/contracts/provider-error.js';
import type {AgentProvider} from '../controller/contracts/types.js';
import {readFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {AGENT_PROVIDER_PRESETS,type AgentProviderPreset} from '../../../contracts/src/index.js';
const presetKeyNames={gemini:'GEMINI_API_KEY',deepseek:'DEEPSEEK_API_KEY',openrouter:'OPENROUTER_API_KEY',minimax:'MINIMAX_API_KEY'} as const;
export function sessionProviderPresets(env:NodeJS.ProcessEnv=process.env){return Object.entries(AGENT_PROVIDER_PRESETS).map(([id,preset])=>({id,...preset,...(id==='gemini'?{model:env.GEMINI_MODEL?.trim()||DEFAULT_GEMINI_MODEL}:{}),hasKey:id==='gemini'?!!geminiEnvironmentKey(env):!!env[presetKeyNames[id as AgentProviderPreset]]?.trim()}));}
export type SessionProviderSummary=import('../../../contracts/src/index.js').ConsoleProvider;
export interface SessionProvider {key?:string;current:AgentProvider;summary:SessionProviderSummary}
/** No file/env mutation. Keys exist only inside this adapter's session closure. */
export function createSessionProvider(raw:unknown,previous?:SessionProvider,env:NodeJS.ProcessEnv=process.env):SessionProvider {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid provider configuration');
  const c={...raw} as Record<string,unknown>;
  if(Object.keys(c).some(k=>!['kind','preset','model','apiKey','baseUrl','apiStyle','responseFormat','timeoutMs'].includes(k))||typeof c.kind!=='string'||!['offline','codex','gemini','openai-compatible'].includes(c.kind))throw Error('Invalid provider configuration');
  if(c.kind==='gemini'){
    if(c.preset!==undefined&&c.preset!=='gemini'||['apiKey','baseUrl','apiStyle','responseFormat'].some(k=>c[k]!==undefined))throw Error('Native Gemini uses the official endpoint and environment key');
    if(c.model!==undefined&&(typeof c.model!=='string'||c.model.length>100||/[\x00-\x1f\x7f]/.test(c.model)))throw Error('Invalid provider model');
    if(c.timeoutMs!==undefined&&(!Number.isSafeInteger(c.timeoutMs)||Number(c.timeoutMs)<1000||Number(c.timeoutMs)>600000))throw Error('Invalid provider timeout');
    const key=geminiEnvironmentKey(env),model=(typeof c.model==='string'?c.model.trim():'')||env.GEMINI_MODEL?.trim()||DEFAULT_GEMINI_MODEL;
    if(!/^(?:models\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model)||key&&model.includes(key))throw Error('Invalid provider model');
    const timeoutMs=c.timeoutMs as number|undefined;
    const summary:SessionProviderSummary={kind:'gemini',preset:'gemini',model,hasKey:!!key,keySource:'environment',...(timeoutMs!==undefined?{timeoutMs}:{})};
    if(!key)return {summary,current:{step:async()=>{throw new ProviderError('authentication',undefined,{stage:'prepare-request',reason:'login-or-token-rejected',outcome:'not-sent'});}}};
    const provider=new GeminiProvider({apiKey:key,defaultModel:model,env,...(timeoutMs!==undefined?{timeoutMs}:{})});
    return {key,summary,current:{step:async request=>{try{return await provider.step(request);}catch(error){throw new ProviderError(error instanceof ProviderError?error.code:'unknown',error instanceof ProviderError?error.timeoutSource:undefined,safeSessionDiagnostic(error instanceof ProviderError?error.diagnostic:undefined));}}}};
  }
  let preset:AgentProviderPreset|undefined;
  if(c.preset!==undefined){
    if(c.kind!=='openai-compatible'||c.preset==='gemini'||typeof c.preset!=='string'||!Object.hasOwn(AGENT_PROVIDER_PRESETS,c.preset))throw Error('Invalid provider preset');
    preset=c.preset as AgentProviderPreset;const definition=AGENT_PROVIDER_PRESETS[preset];
    if(c.baseUrl!==undefined&&(typeof c.baseUrl!=='string'||new URL(c.baseUrl).href!==new URL(definition.baseUrl).href))throw Error('Preset key cannot be sent to another endpoint');
    c.baseUrl=definition.baseUrl;c.model??=definition.model;c.apiStyle??=definition.apiStyle;c.responseFormat??=definition.responseFormat;
  }
  if(c.model!==undefined&&(typeof c.model!=='string'||c.model.length>100||/[\x00-\x1f\x7f]/.test(c.model)))throw Error('Invalid provider model');
  const model=typeof c.model==='string'?c.model.trim():'';
  if(c.timeoutMs!==undefined&&(!Number.isSafeInteger(c.timeoutMs)||Number(c.timeoutMs)<1000||Number(c.timeoutMs)>600000))throw Error('Invalid provider timeout');
  const timeoutMs=c.timeoutMs as number|undefined;
  if(c.kind!=='openai-compatible'&&['apiKey','baseUrl','apiStyle','responseFormat'].some(k=>c[k]!==undefined))throw Error('Provider does not accept API credentials or endpoint');
  if(c.kind==='offline')return {summary:{kind:'offline',model:'',hasKey:false},current:{step:async()=>{throw Error('未配置模型；hybrid 应使用本地战术决策，不调用模型。');}}};
  if(c.kind==='codex')return {summary:{kind:'codex',model,hasKey:false,...(timeoutMs!==undefined?{timeoutMs}:{})},current:new CodexProvider('codex',timeoutMs)};
  if(!model||typeof c.baseUrl!=='string'||c.baseUrl.length>2048||/[\x00-\x20\x7f]/.test(c.baseUrl))throw Error('API provider requires model and endpoint');
  const url=new URL(c.baseUrl);
  const previousMatches=previous?.summary.kind==='openai-compatible'&&previous.summary.baseUrl===url.href;
  const environmentKey=preset?env[presetKeyNames[preset]]:undefined;
  const key=c.apiKey===undefined?(previousMatches?previous.key:environmentKey):c.apiKey;
  const keySource=c.apiKey===undefined?(previousMatches?previous.summary.keySource:'environment'):'session';
  if(typeof key!=='string'||key.length>8192||/[\r\n\0]/.test(key)||key!==''&&!key.trim())throw Error('API provider requires a session key for this endpoint');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||key!==''&&(c.baseUrl.includes(key)||decodeURIComponent(url.pathname).includes(key)||model.includes(key)))throw Error('Invalid provider endpoint');
  if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Remote provider requires HTTPS');
  const apiStyle=c.apiStyle??'responses',responseFormat=c.responseFormat??'json_schema';
  if(apiStyle!=='chat'&&apiStyle!=='responses'||typeof responseFormat!=='string'||!['json_schema','json_object','none'].includes(responseFormat))throw Error('Invalid provider protocol');
  const summary:SessionProviderSummary={kind:'openai-compatible',model,baseUrl:url.href,apiStyle,responseFormat:responseFormat as 'json_schema'|'json_object'|'none',hasKey:key.length>0,...(preset?{preset}:{}),...(keySource?{keySource}:{}),...(timeoutMs!==undefined?{timeoutMs}:{})};
  if(!key)return {key:'',summary,current:{step:async()=>{throw new ProviderError('authentication');}}};
  const provider=new OpenAICompatibleProvider({apiKey:key,baseUrl:url.href,defaultModel:model,apiStyle,responseFormat:summary.responseFormat!,...(timeoutMs!==undefined?{timeoutMs}:{}),fetchImpl:(input,init)=>fetch(input,{...init,redirect:'error'})});
  return {key,summary,current:{step:async request=>{
    try{const result=await provider.step(request);if(JSON.stringify(result).includes(key))throw new ProviderError('invalid-response');return result;}
    catch(error){throw new ProviderError(error instanceof ProviderError?error.code:'unknown',error instanceof ProviderError?error.timeoutSource:undefined,safeSessionDiagnostic(error instanceof ProviderError?error.diagnostic:undefined));}
  }}};
}
/** Local CLI model catalog only; never starts a model or returns account data. */
export async function listLocalCodexModels(directory=process.env.CODEX_HOME??join(homedir(),'.codex')):Promise<{models:string[]}>{
  try{
    const path=join(directory,'models_cache.json');
    if((await stat(path)).size>1048576)return {models:[]};
    const cache=JSON.parse(await readFile(path,'utf8'));
    if(!Array.isArray(cache.models))return {models:[]};
    const ids=cache.models.flatMap((m:{visibility?:unknown;slug?:unknown})=>m?.visibility==='list'&&typeof m.slug==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(m.slug)?[m.slug]:[]);
    return {models:[...new Set<string>(ids)].slice(0,100)};
  }catch{return {models:[]};}
}
/** Console discovery; never called by a model turn. */
export async function listSessionProviderModels(provider:SessionProvider):Promise<{models:string[]}> {
  if(provider.summary.kind==='codex')return listLocalCodexModels();
  if(provider.summary.kind==='gemini'){
    if(!provider.key)throw Error('Configure GEMINI_API_KEY or GOOGLE_API_KEY first');
    try{
      const models:string[]=[];let token='';
      for(let page=0;page<10;page++){
        const url=new URL(GEMINI_NATIVE_BASE_URL+'/models');url.searchParams.set('pageSize','1000');if(token)url.searchParams.set('pageToken',token);
        const response=await fetch(url,{headers:{'x-goog-api-key':provider.key},redirect:'error',signal:AbortSignal.timeout(10000)});
        if(!response.ok){await response.body?.cancel();throw Error();}
        const data=JSON.parse(await readGeminiResponse(response));if(!Array.isArray(data.models))throw Error();
        for(const m of data.models)if(m?.supportedGenerationMethods?.includes('generateContent')&&typeof m.name==='string'&&/^models\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(m.name)&&!m.name.includes(provider.key))models.push(m.name.slice(7));
        if(models.length>=500||!data.nextPageToken)return {models:[...new Set(models)].slice(0,500)};
        if(typeof data.nextPageToken!=='string'||data.nextPageToken.length>8192)throw Error();token=data.nextPageToken;
      }
      return {models:[...new Set(models)].slice(0,500)};
    }catch{throw Error('Unable to read the configured Gemini model list');}
  }
  if(provider.summary.kind!=='openai-compatible')return {models:[]};
  if(!provider.key||!provider.summary.baseUrl)throw Error('Configure the provider session key first');
  const key=provider.key;
  try{
    const response=await fetch(provider.summary.baseUrl.replace(/\/+$/,'')+'/models',{headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(10000)});
    const sizeLimit=provider.summary.preset==='openrouter'?2097152:262144;
    if(!response.ok||Number(response.headers.get('content-length')??0)>sizeLimit||!response.body){await response.body?.cancel();throw Error();}
    const data=JSON.parse(await readBoundedResponse(response,sizeLimit)) as {data?:{id?:unknown}[]};
    if(!Array.isArray(data.data))throw Error();
    const ids=data.data.flatMap(item=>typeof item?.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(item.id)&&!item.id.includes(key)?[item.id]:[]);
    return {models:[...new Set(ids)].slice(0,500)};
  }catch{throw Error('Unable to read the configured provider model list');}
}
