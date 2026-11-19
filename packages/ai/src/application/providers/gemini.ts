import {readBoundedResponse} from '../bounded-response.js';
import type {AgentProvider,AgentRequest,ModelResult} from '../../controller/contracts/types.js';
import {ProviderError,classifyProviderFailure} from '../../controller/contracts/provider-error.js';
import {EMPTY_MODEL_SCHEMA,parseModelJson,SemanticReplyParseError} from '../../controller/contracts/model-json.js';
import {providerCallTimeout} from '../../controller/contracts/provider-timeout.js';
import {configureProviderProxy} from './provider-proxy.js';
import {geminiGenerationSchema,geminiSchemaInstruction} from './gemini-schema.js';
export const GEMINI_NATIVE_BASE_URL='https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL='gemini-4-argon';
export const geminiEnvironmentKey=(env:NodeJS.ProcessEnv=process.env)=>env.GEMINI_API_KEY?.trim()||env.GOOGLE_API_KEY?.trim()||'';
export interface GeminiOptions {apiKey:string;defaultModel?:string;timeoutMs?:number;fetchImpl?:typeof fetch;env?:NodeJS.ProcessEnv}
const validCount=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
export async function readGeminiResponse(response:Response):Promise<string>{
 return readBoundedResponse(response,2097152,(kind,bytes)=>new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:kind==='missing'?'missing-message-content':'semantic-output-limit',...(kind==='limit'?{outputBytes:bytes}:{})}));
}
export class GeminiProvider implements AgentProvider {
 private readonly fetchImpl:typeof fetch;
 constructor(private readonly options:GeminiOptions){
  if(!options.apiKey.trim()||options.apiKey.length>8192||/[\r\n\0]/.test(options.apiKey))throw Error('Gemini API key is required');
  if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1000||options.timeoutMs>600000))throw Error('Invalid Gemini provider timeout');
  if(!options.fetchImpl)configureProviderProxy(options.env);
  this.fetchImpl=options.fetchImpl??fetch;
 }
 async step(request:AgentRequest):Promise<ModelResult>{
  const controller=new AbortController(),abort=()=>controller.abort(request.signal.reason);
  request.signal.addEventListener('abort',abort,{once:true});
  const timeoutMs=this.options.timeoutMs??providerCallTimeout(request.effort,request.timeoutMs);
  const timer=setTimeout(()=>controller.abort(),timeoutMs);let dispatched=false,received=false;
  try{
   if(request.signal.aborted)throw new ProviderError('cancelled');
   const model=(request.model||this.options.defaultModel||DEFAULT_GEMINI_MODEL).replace(/^models\//,'');
   if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model))throw new ProviderError('unknown',undefined,{stage:'prepare-request',reason:'model-not-supported'});
   const generationConfig:Record<string,unknown>={responseMimeType:'application/json',responseJsonSchema:geminiGenerationSchema(request.responseSchema??EMPTY_MODEL_SCHEMA)};
   // Argon documents low/medium/high; do not invent thinking-token budgets for other models.
   if(/^gemini-4-argon(?:-|$)/.test(model)&&['low','medium','high'].includes(request.effort??''))generationConfig.thinkingConfig={thinkingLevel:request.effort!.toUpperCase()};
   dispatched=true;
   const response=await this.fetchImpl(`${GEMINI_NATIVE_BASE_URL}/models/${model}:generateContent`,{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-goog-api-key':this.options.apiKey},body:JSON.stringify({systemInstruction:{parts:[{text:geminiSchemaInstruction}]},contents:[{role:'user',parts:[{text:request.prompt}]}],generationConfig}),signal:controller.signal});
   const raw=await readGeminiResponse(response);received=true;
   if(!response.ok){
    const failure=response.status===401||response.status===403?new ProviderError('authentication',undefined,{stage:'provider-http',reason:'login-or-token-rejected'}):classifyProviderFailure(`${response.status} ${raw.slice(0,1000)}`);
    const region=/location|region|country/i.test(raw)&&/not supported|unavailable|not available/i.test(raw);
    throw new ProviderError(failure.code,undefined,{stage:'provider-http',reason:region?'region-unavailable':failure.diagnostic?.reason??`http-${response.status}`,httpStatus:response.status,outcome:response.status<500&&response.status!==408?'rejected':'unknown'});
   }
   let data:any;try{data=JSON.parse(raw);}catch{throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:'invalid-json',outputBytes:Buffer.byteLength(raw)});}
   const candidate=data?.candidates?.[0],finish=candidate?.finishReason;
   const finishReason=finish==='STOP'?'stop':finish==='MAX_TOKENS'?'length':typeof finish==='string'?'content_filter':undefined;
   const evidence={outputBytes:Buffer.byteLength(raw),...(finishReason?{finishReason}:{}),truncated:finish==='MAX_TOKENS'};
   if(evidence.truncated)throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:'truncated-output',...evidence});
   if(data?.promptFeedback?.blockReason||finish&&finish!=='STOP')throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:'blocked-output',...evidence});
   const parts=candidate?.content?.parts;
   if(!Array.isArray(parts)||parts.some((p:any)=>p?.functionCall))throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:'missing-message-content',...evidence});
   const text=parts.filter((p:any)=>p&&p.thought!==true&&typeof p.text==='string').map((p:any)=>p.text).join('');
   if(!text.trim())throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:'missing-message-content',...evidence});
   if(text.includes(this.options.apiKey))throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:'invalid-text-content',...evidence});
   let reply;try{reply=parseModelJson(text);}catch(error){throw new ProviderError('invalid-response',undefined,{stage:'parse-response',reason:error instanceof SemanticReplyParseError?error.reason:'invalid-agent-envelope',...evidence,contentCharacters:text.length});}
   const u=data?.usageMetadata,input=u?.promptTokenCount;
   const output=validCount(u?.totalTokenCount)&&validCount(input)&&u.totalTokenCount>=input?u.totalTokenCount-input:validCount(u?.candidatesTokenCount)&&validCount(u?.thoughtsTokenCount)?u.candidatesTokenCount+u.thoughtsTokenCount:undefined;
   const inputKnown=validCount(input),outputKnown=validCount(output),cached=u?.cachedContentTokenCount,cachedKnown=inputKnown&&validCount(cached)&&cached<=input;
   const inputTokens=inputKnown?input:0,outputTokens=outputKnown?output:0;
   return {reply,tokens:inputTokens+outputTokens,usage:{inputTokens,outputTokens,...(cachedKnown?{cachedInputTokens:cached}:{})},usageKnown:{provenance:'reported',input:inputKnown,output:outputKnown,cached:cachedKnown}};
  }catch(error){
   const outcome=!dispatched?'not-sent':received?'completed':'unknown';
   if(error instanceof ProviderError)throw new ProviderError(error.code,error.timeoutSource,{...error.diagnostic,stage:error.diagnostic?.stage??'provider-transport',outcome:error.diagnostic?.outcome??outcome});
   if(request.signal.aborted)throw new ProviderError('cancelled',undefined,{stage:'provider-transport',outcome});
   if(controller.signal.aborted)throw new ProviderError('timeout','provider-call',{stage:'provider-transport',outcome});
   const failure=classifyProviderFailure(error instanceof Error?error.message:String(error));throw new ProviderError(failure.code,undefined,{...failure.diagnostic,stage:'provider-transport',outcome});
  }finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);}
 }
}
