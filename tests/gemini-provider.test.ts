import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GeminiProvider} from '../packages/ai/src/application/providers/gemini.js';
import {createSessionProvider,listSessionProviderModels,sessionProviderPresets} from '../packages/ai/src/application/agent-provider.js';
import {createProviderFromEnv} from '../packages/ai/src/application/providers/provider-factory.js';
import {ProviderError} from '../packages/ai/src/controller/contracts/provider-error.js';
import {intentSchemaFor} from '../plugins/hybrid/src/intent-protocol.js';
import {geminiGenerationSchema} from '../packages/ai/src/application/providers/gemini-schema.js';
const key='synthetic-gemini-test-key';
const request=()=>({prompt:'synthetic test',model:'gemini-4-argon',signal:new AbortController().signal,responseSchema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}});
const envelope=(text='{"ok":true}',extra:Record<string,unknown>={})=>({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}],...extra});

test('native Gemini sends generateContent, API-key header and a generation projection without changing the host schema',async()=>{
 let called=0;
 const r={...request(),effort:'low' as const,responseSchema:intentSchemaFor('strategy',['ALPHA'])};
 const p=new GeminiProvider({apiKey:key,fetchImpl:async(url,init)=>{
  called++;assert.equal(String(url),'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent');
  assert.equal(new Headers(init?.headers).get('x-goog-api-key'),key);assert.ok(!String(url).includes(key));assert.equal(init?.redirect,'error');
  const body=JSON.parse(String(init?.body));assert.deepEqual(body.generationConfig.responseJsonSchema,geminiGenerationSchema(r.responseSchema));assert.equal(body.generationConfig.responseMimeType,'application/json');assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,'LOW');assert.equal(body.contents[0].parts[0].text,r.prompt);assert.ok(body.systemInstruction.parts[0].text.includes('授权名称'));
  return Response.json(envelope('{"summary":"ok","tasks":{"upsert":[],"cancel":[]},"reviewOn":[]}',{usageMetadata:{promptTokenCount:10,candidatesTokenCount:4,thoughtsTokenCount:6,totalTokenCount:20,cachedContentTokenCount:3}}));
 }});
 const result=await p.step(r);assert.equal(called,1);assert.deepEqual(result.reply,{summary:'ok',tasks:{upsert:[],cancel:[]},reviewOn:[]});assert.deepEqual(result.usage,{inputTokens:10,outputTokens:10,cachedInputTokens:3});assert.equal(result.tokens,20);assert.equal(result.usageKnown?.output,true);
});

test('Gemini projection keeps JSON types and action enums while leaving capacity and reference validation to the unchanged host contract',()=>{
 const schema={type:'object',required:['tasks'],properties:{tasks:{type:'array',maxItems:12,items:{type:'object',required:['kind','until'],properties:{kind:{type:'string',enum:['capture','transfer']},target:{type:'string',enum:['ALPHA','BETA']},until:{type:'number',exclusiveMinimum:10,maximum:10000000},drillers:{anyOf:[{type:'integer',minimum:1},{type:'null'}]}},anyOf:[{properties:{kind:{enum:['capture']}},required:['target']}]}}}};
 const original=structuredClone(schema),wire=geminiGenerationSchema(schema) as any;
 assert.deepEqual(schema,original);assert.equal(wire.properties.tasks.maxItems,undefined);
 assert.deepEqual(wire.properties.tasks.items.properties.kind.enum,['capture','transfer']);
 assert.equal(wire.properties.tasks.items.properties.target.enum,undefined);
 assert.equal(wire.properties.tasks.items.properties.until.exclusiveMinimum,undefined);
 assert.equal(wire.properties.tasks.items.anyOf,undefined);
 assert.deepEqual(wire.properties.tasks.items.properties.drillers.anyOf.map((s:any)=>s.type),['integer','null']);
 assert.ok(wire.properties.tasks.description.includes('maxItems=12'));
 assert.ok(wire.properties.tasks.items.properties.target.description.includes('ALPHA'));
 assert.ok(wire.properties.tasks.items.properties.target.description.includes('BETA'));
 assert.ok(wire.properties.tasks.items.description.includes('动作参数条件'));
});

test('native response excludes thought parts and preserves unknown token measurements',async()=>{
 const p=new GeminiProvider({apiKey:key,fetchImpl:async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'private reasoning'},{text:'{"ok":'},{text:'true}'}]}}]})});
 const r=await p.step(request());assert.deepEqual(r.reply,{ok:true});assert.equal(r.usageKnown?.input,false);assert.equal(r.usageKnown?.output,false);assert.ok(!JSON.stringify(r).includes('private reasoning'));
});

test('native commander calls keep the common commander envelope parser',async()=>{
 const p=new GeminiProvider({apiKey:key,fetchImpl:async()=>Response.json(envelope(JSON.stringify({request:{tool:'finish',arguments:{memory:null}},summary:'收到',nextContext:null})))});
 const result=await p.step({model:'gemini-4-argon',prompt:'test',signal:new AbortController().signal,commanderMode:'discuss'});
 assert.deepEqual(result.reply,{request:{tool:'finish',arguments:{memory:null}},summary:'收到',nextContext:null});
});

for(const [name,payload,reason] of [
 ['truncated',{candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{"ok":true}'}]}}]},'truncated-output'],
 ['blocked',{promptFeedback:{blockReason:'SAFETY'}},'blocked-output'],
 ['empty',{candidates:[{finishReason:'STOP',content:{parts:[]}}]},'missing-message-content'],
 ['invalid-json',envelope('not json'),'invalid-semantic-json'],
 ['non-object',envelope('[]'),'invalid-semantic-object'],
 ['echoed-key',envelope(JSON.stringify({key})),'invalid-text-content'],
] as const)test(`native Gemini rejects ${name} without publishing a semantic result`,async()=>{
 const p=new GeminiProvider({apiKey:key,fetchImpl:async()=>Response.json(payload)});
 await assert.rejects(p.step(request()),e=>{assert.ok(e instanceof ProviderError);assert.equal(e.diagnostic?.reason,reason);assert.ok(!JSON.stringify(e).includes(key));return true;});
});

test('native HTTP failures retain safe authentication, rate and region diagnostics',async()=>{
 for(const [status,message,code,reason] of [[401,'bad key','authentication','login-or-token-rejected'],[429,'rate limit','transient','rate-limit'],[400,'User location is not supported for API use.','unknown','region-unavailable']] as const){
  const p=new GeminiProvider({apiKey:key,fetchImpl:async()=>Response.json({error:{message:message+' '+key}},{status})});
  await assert.rejects(p.step(request()),e=>{assert.ok(e instanceof ProviderError);assert.equal(e.code,code);assert.equal(e.diagnostic?.httpStatus,status);assert.equal(e.diagnostic?.reason,reason);assert.ok(!JSON.stringify(e).includes(key));return true;});
 }
});

test('native cancellation aborts transport and pre-cancelled calls are not sent',async()=>{
 const controller=new AbortController();let calls=0;
 const p=new GeminiProvider({apiKey:key,fetchImpl:async(_url,init)=>{calls++;return new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')));controller.abort();});}});
 await assert.rejects(p.step({...request(),signal:controller.signal}),e=>e instanceof ProviderError&&e.code==='cancelled'&&e.outcome==='unknown');
 await assert.rejects(p.step({...request(),signal:controller.signal}),e=>e instanceof ProviderError&&e.code==='cancelled'&&e.outcome==='not-sent');assert.equal(calls,1);
});

test('native call timeout aborts transport and reports its timeout source',async()=>{
 const p=new GeminiProvider({apiKey:key,fetchImpl:async(_url,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError')));})});
 await assert.rejects(p.step({...request(),timeoutMs:5}),e=>e instanceof ProviderError&&e.code==='timeout'&&e.timeoutSource==='provider-call'&&e.outcome==='unknown');
});

test('native response body limit rejects oversized output before JSON publication',async()=>{
 const p=new GeminiProvider({apiKey:key,fetchImpl:async()=>new Response('x'.repeat(2097153))});
 await assert.rejects(p.step(request()),e=>e instanceof ProviderError&&e.diagnostic?.reason==='semantic-output-limit');
});

test('native session resolves environment keys without accepting an endpoint or browser key',async()=>{
 const env={GEMINI_API_KEY:key,GOOGLE_API_KEY:'fallback',GEMINI_MODEL:'gemini-4-argon'};
 const p=createSessionProvider({kind:'gemini'},undefined,env);assert.equal(p.key,key);assert.equal(p.summary.kind,'gemini');assert.equal(p.summary.keySource,'environment');assert.equal(p.summary.model,'gemini-4-argon');assert.ok(!JSON.stringify(p.summary).includes(key));
 assert.equal(createSessionProvider({kind:'gemini'},undefined,{GOOGLE_API_KEY:key}).key,key);
 for(const args of [{apiKey:key},{baseUrl:'https://other.test'},{preset:'deepseek'},{apiStyle:'chat'}])assert.throws(()=>createSessionProvider({kind:'gemini',...args},undefined,env));
 const missing=createSessionProvider({kind:'gemini'},undefined,{});assert.equal(missing.summary.hasKey,false);await assert.rejects(missing.current.step(request()),e=>e instanceof ProviderError&&e.code==='authentication');
 assert.equal(sessionProviderPresets(env).find(x=>x.id==='gemini')?.hasKey,true);
 assert.equal(createProviderFromEnv({AI_PROVIDER:'gemini',GEMINI_API_KEY:key}).constructor.name,'RoutingProvider');
 assert.throws(()=>createProviderFromEnv({AI_PROVIDER:'gemini'}),/GEMINI_API_KEY/);
});

test('environment factory routes Gemini to the native adapter',async t=>{
 t.mock.method(globalThis,'fetch',async(url:unknown,init?:RequestInit)=>{
  assert.ok(String(url).endsWith('/models/gemini-4-argon:generateContent'));assert.equal(new Headers(init?.headers).get('x-goog-api-key'),key);
  return Response.json(envelope());
 });
 const p=createProviderFromEnv({AI_PROVIDER:'gemini',GEMINI_API_KEY:key});
 assert.deepEqual((await p.step(request())).reply,{ok:true});
});

test('native model discovery uses key header, pagination and generateContent capability filtering',async t=>{
 const p=createSessionProvider({kind:'gemini'},undefined,{GEMINI_API_KEY:key});let calls=0;
 t.mock.method(globalThis,'fetch',async(url:unknown,init?:RequestInit)=>{
  const u=new URL(String(url));calls++;assert.equal(new Headers(init?.headers).get('x-goog-api-key'),key);assert.equal(u.hostname,'generativelanguage.googleapis.com');assert.ok(!String(url).includes(key));
  if(calls===1)return Response.json({models:[{name:'models/gemini-4-argon',supportedGenerationMethods:['generateContent']},{name:'models/embedding',supportedGenerationMethods:['embedContent']}],nextPageToken:'page2'});
  assert.equal(u.searchParams.get('pageToken'),'page2');return Response.json({models:[{name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent']},{name:'models/'+key,supportedGenerationMethods:['generateContent']}]});
 });
 assert.deepEqual(await listSessionProviderModels(p),{models:['gemini-4-argon','gemini-3.8-flash']});assert.equal(calls,2);
});
