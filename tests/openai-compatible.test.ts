import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../packages/ai/src/application/providers/openai-compatible.js';
import { createProviderFromEnv } from '../packages/ai/src/application/providers/provider-factory.js';
import {modelResponseSchema} from '../plugins/hybrid/src/model-wire.js';
import {intentSchemaFor} from '../plugins/hybrid/src/intent-protocol.js';

const signal = new AbortController().signal;

test('compact task schemas are sent once in structured mode and the MiniMax JSON-object prompt',async()=>{
 const posts=Array.from({length:80},(_,i)=>'OUTPOST-'+i);
 const schema=modelResponseSchema(intentSchemaFor('strategy',posts),{friendlyPosts:posts.slice(0,5)});
 assert.ok(schema.$defs);
 for(const responseFormat of ['json_schema','json_object'] as const){
  let body:any;
  const provider=new OpenAICompatibleProvider({apiKey:'test-key',baseUrl:'https://api.minimaxi.com/v1',apiStyle:'chat',responseFormat,
   fetchImpl:async(_input,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'',tasks:[],cancel:[],reviewOn:[]})}}]}),{status:200});}});
  const result=await provider.step({model:'MiniMax-M3.1-Flash',effort:'low',prompt:'本轮材料',responseSchema:schema,signal});
  assert.deepEqual(result.reply,{summary:'',tasks:[],cancel:[],reviewOn:[]});
  assert.equal(body.reasoning_effort,'low');
  if(responseFormat==='json_schema'){
   assert.equal(body.messages[0].content,'本轮材料');
   assert.deepEqual(body.response_format.json_schema.schema,schema);
  }else{
   assert.deepEqual(body.response_format,{type:'json_object'});
   assert.equal(body.messages[0].content,'本轮材料\nRequired output JSON Schema:\n'+JSON.stringify(schema));
  }
 }
});

test('MiniMax M3.1 Flash forwards configured reasoning effort only to its documented Chat endpoint',async()=>{
 for(const [baseUrl,model,expected] of [['https://api.minimaxi.com/v1','MiniMax-M3.1-Flash','low'],['https://api.minimax.cn/v1','MiniMax-M3.1-Flash','low'],['https://api.minimax.io/v1','MiniMax-M3.1-Flash','low'],['https://example.test/v1','MiniMax-M3.1-Flash',undefined],['https://api.minimaxi.com/v1','MiniMax-M3',undefined]] as const){
  let body:Record<string,unknown>={};
  const provider=new OpenAICompatibleProvider({apiKey:'test-key',baseUrl,apiStyle:'chat',fetchImpl:async(_input,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({request:{tool:'finish',arguments:{}},summary:'等待'})}}]}),{status:200});}});
  await provider.step({model,effort:'low',prompt:'test',signal});assert.equal(body.reasoning_effort,expected);
 }
});

test('OpenAI-compatible provider sends the game prompt and parses the protocol envelope', async () => {
  let request: RequestInit | undefined;
  let url = '';
  const provider = new OpenAICompatibleProvider({
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    apiStyle: 'chat',
    fetchImpl: async (input, init) => {
      url = String(input);
      request = init;
      return new Response(JSON.stringify({
        choices: [{ finish_reason:'stop', message: { content: JSON.stringify({ request: { tool: 'finish', arguments: {}}, summary: '等待' }) } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await provider.step({ model: 'test-model', prompt: 'private game prompt', effort: 'low', signal });
  assert.equal(url, 'https://example.test/v1/chat/completions');
  assert.equal(request?.method, 'POST');
  assert.equal((request?.headers as Record<string, string>).authorization, 'Bearer test-key');
  const body = JSON.parse(String(request?.body));
  assert.equal(body.model, 'test-model');
  assert.equal(body.messages[0].content, 'private game prompt');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal((result.reply.request as {tool:string}).tool, 'finish');
  assert.equal(result.tokens, 16);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4 });
});

test('OpenAI-compatible provider enables JSON object mode when selected', async () => {
  let body: any;
  const provider = new OpenAICompatibleProvider({
    apiKey: 'test-key', baseUrl: 'https://example.test/v1', apiStyle: 'chat', responseFormat: 'json_object',
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({request:{tool:'order',arguments:{action:{kind:'hold'}}},summary:'等待'})}}]}),{status:200});
    },
  });
  const result = await provider.step({model:'test-model',prompt:'json output',signal});
  assert.equal(body.response_format.type,'json_object');
  assert.deepEqual((result.reply.request as {arguments:unknown}).arguments,{action:{kind:'hold'}});
});

test('provider factory selects OpenAI-compatible provider without exposing the key', () => {
  const provider = createProviderFromEnv({
    AI_PROVIDER: 'openai-compatible',
    OPENAI_API_KEY: 'secret',
    OPENAI_BASE_URL: 'http://localhost:9000/v1',
    OPENAI_MODEL: 'local-model',
  });
  assert.equal(provider.constructor.name, 'RoutingProvider');
});

test('Gemini can still be selected through an explicitly configured compatibility endpoint', async () => {
  let url = '';
  let body: any;
  const adapter = new OpenAICompatibleProvider({
    apiKey: 'secret',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-4-argon',
    apiStyle: 'chat',
    fetchImpl: async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason:'stop', message: { content: JSON.stringify({ request: { tool: 'finish', arguments: {} }, summary: 'ok' }) } }], usage: { prompt_tokens: 8, completion_tokens: 3 } }), { status: 200 });
    },
  });
  const result = await adapter.step({ model: '', prompt: 'probe', signal });
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(body.model, 'gemini-4-argon');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal((result.reply.request as {tool:string}).tool, 'finish');
});

test('Responses style parses output_text and uses the JSON Schema envelope', async () => {
  let url = '';
  let body: any;
  const provider = new OpenAICompatibleProvider({
    apiKey: 'test-key', baseUrl: 'https://api.deepseek.com/v1', apiStyle: 'responses',
    fetchImpl: async (input, init) => {
      url = String(input); body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ status:'completed', output: [{ type: 'message', status:'completed', content: [{ type: 'output_text', text: JSON.stringify({ request: { tool: 'finish', arguments: {} }, summary: 'ok' }) }] }], usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } } }), { status: 200 });
    },
  });
  const result = await provider.step({ model: 'deepseek-flash', prompt: 'probe', signal });
  assert.equal(url, 'https://api.deepseek.com/responses');
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.name, 'subterfuge_response');
  assert.equal((result.reply.request as {tool:string}).tool, 'finish');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 });
});
