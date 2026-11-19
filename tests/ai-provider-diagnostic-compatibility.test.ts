import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionProvider} from '../packages/ai/src/application/agent-provider.js';
import {ProviderError,safeSessionDiagnostic} from '../packages/ai/src/controller/contracts/provider-error.js';
const key='test-secret-never-retained';
const request={model:'test',prompt:'private prompt',responseSchema:{type:'object'},signal:new AbortController().signal};
test('session preserves HTTP, JSON, semantic shape and truncation evidence without upstream text',async t=>{
 let status=429,body=key;
 t.mock.method(globalThis,'fetch',async()=>new Response(body,{status}));
 const p=createSessionProvider({kind:'openai-compatible',model:'test',apiKey:key,baseUrl:'http://localhost',apiStyle:'chat'}).current;
 const failure=async(reason:string,checks:Record<string,unknown>={})=>{
  await assert.rejects(p.step(request),e=>{
   assert.ok(e instanceof ProviderError);assert.equal(e.diagnostic?.reason,reason);
   for(const [k,v] of Object.entries(checks))assert.equal((e.diagnostic as any)[k],v);
   assert.ok(!JSON.stringify(e).includes(key));assert.ok(!String(e).includes(key));return true;
  });
 };
 await failure('rate-limit',{stage:'provider-http',httpStatus:429,outcome:'rejected'});
 status=503;await failure('provider-unavailable',{httpStatus:503,outcome:'unknown'});
 status=200;await failure('invalid-json',{outputBytes:Buffer.byteLength(body),outcome:'completed'});
 body=JSON.stringify({choices:[{message:{content:'{'+key},finish_reason:'stop'}]});
 await failure('invalid-semantic-json',{finishReason:'stop',truncated:false,contentCharacters:key.length+1});
 body=JSON.stringify({choices:[{finish_reason:'stop',message:{content:'[]'}}]});await failure('invalid-semantic-object');
 body=JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'length'}]});await failure('truncated-output',{finishReason:'length',truncated:true});
 body=JSON.stringify({choices:[{finish_reason:'stop',message:{content:'x'.repeat(55001)}}]});await failure('semantic-output-limit',{contentCharacters:55001});
 body=JSON.stringify({choices:[{finish_reason:'stop',message:{}}]});await failure('missing-message-content');
 body=JSON.stringify({choices:[{finish_reason:'stop',message:{content:{text:key}}}]});await failure('invalid-text-content');
 body=JSON.stringify({choices:[{message:{content:'{}'},finish_reason:key}]});await failure('invalid-completion-status');
});

test('Responses truncation is identified and arbitrary diagnostic strings and nested causes are excluded',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]})));
 const p=createSessionProvider({kind:'openai-compatible',model:'test',apiKey:key,baseUrl:'http://localhost'}).current;
 await assert.rejects(p.step(request),e=>e instanceof ProviderError&&e.diagnostic?.reason==='truncated-output'&&e.diagnostic.finishReason==='max_output_tokens');
 const safe=safeSessionDiagnostic({stage:key,reason:key,finishReason:key,outcome:'completed',httpStatus:429,contentCharacters:12,outputBytes:-1,cause:{message:key} as any,process:{pid:123}});
 assert.deepEqual(safe,{stage:'redacted-provider',outcome:'completed',httpStatus:429,contentCharacters:12});
});
