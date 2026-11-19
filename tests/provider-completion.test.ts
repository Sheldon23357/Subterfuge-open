import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenAICompatibleProvider} from '../packages/ai/src/application/providers/openai-compatible.js';
import {ProviderError,safeSessionDiagnostic} from '../packages/ai/src/controller/contracts/provider-error.js';
const request={model:'synthetic',prompt:'current material',signal:new AbortController().signal};
const content=JSON.stringify({summary:'complete response',tasks:[],cancel:[],reviewOn:[]});
function provider(style:'chat'|'responses',payload:unknown){return new OpenAICompatibleProvider({apiKey:'synthetic-key',baseUrl:'https://example.test/v1',apiStyle:style,fetchImpl:async()=>Response.json(payload)});}
const message=()=>({type:'message',status:'completed',content:[{type:'output_text',text:content}]});

test('chat accepts only stop and records positive completion evidence without changing model output',async()=>{
 const result=await provider('chat',{id:'synthetic-response',choices:[{finish_reason:'stop',message:{content}}]}).step(request);
 assert.deepEqual(result.reply,JSON.parse(content));assert.deepEqual(result.completion,{protocol:'chat',status:'completed',finishReason:'stop',responseId:'synthetic-response'});
 for(const finish of [undefined,null,'length','content_filter','tool_calls','function_call','end_turn','unrecognized']){
  let output=false;
  await assert.rejects(provider('chat',{choices:[{finish_reason:finish,message:{content}}]}).step({...request,onOutput:()=>{output=true;}}),e=>e instanceof ProviderError&&e.code==='invalid-response');
  assert.equal(output,false,'nonterminal text must not be accepted even when its JSON is complete');
 }
});

test('chat rejects tool requests and refusals even with a forged normal finish reason',async()=>{
 for(const extra of [{tool_calls:[{id:'tool-one'}]},{function_call:{name:'lookup'}},{refusal:'cannot comply'},{tool_calls:{name:'not-an-array'}}]){
  await assert.rejects(provider('chat',{choices:[{finish_reason:'stop',message:{content,...extra}}]}).step(request),e=>e instanceof ProviderError&&['unexpected-tool-call','blocked-output'].includes(e.diagnostic?.reason??''));
 }
});

test('Responses requires both response and message to be completed, not just valid JSON text',async()=>{
 const result=await provider('responses',{id:'synthetic-response',status:'completed',output:[{type:'reasoning',summary:[]},message()]}).step(request);
 assert.deepEqual(result.completion,{protocol:'responses',status:'completed',finishReason:'completed',responseId:'synthetic-response'});
 for(const status of [undefined,null,'queued','in_progress','incomplete','failed','cancelled'])await assert.rejects(provider('responses',{status,output:[message()]}).step(request));
 for(const status of [undefined,'in_progress','incomplete'])await assert.rejects(provider('responses',{status:'completed',output:[{...message(),status}]}).step(request));
 for(const extra of [{error:{code:'blocked'}},{incomplete_details:{reason:'content_filter'}},{output:[message(),{type:'function_call',name:'lookup'}]},{output:[{...message(),content:[{type:'refusal',refusal:'blocked'}]}]}])await assert.rejects(provider('responses',{status:'completed',output:[message()],...extra}).step(request));
});

test('completion failures retain safe bounded codes and never retain arbitrary provider values',async()=>{
 const secret='synthetic-key';
 await assert.rejects(provider('chat',{choices:[{finish_reason:secret,message:{content}}]}).step(request),e=>{
  assert.ok(e instanceof ProviderError);const safe=safeSessionDiagnostic(e.diagnostic);assert.equal(safe.reason,'invalid-completion-status');assert.equal(safe.finishReason,undefined);assert.ok(!JSON.stringify(e).includes(secret));return true;
 });
 const result=await provider('chat',{id:secret,choices:[{finish_reason:'stop',message:{content}}]}).step(request);assert.equal(result.completion?.responseId,undefined);
});
