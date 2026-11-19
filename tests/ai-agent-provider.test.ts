import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createSessionProvider} from '../packages/ai/src/application/agent-provider.js';
const request={prompt:'synthetic test',model:'fake',signal:new AbortController().signal};

test('compatible output audit retains malformed JSON before rejection and redacts the credential',async()=>{
 const {OpenAICompatibleProvider}=await import('../packages/ai/src/application/providers/openai-compatible.js');
 const key='synthetic-private-output-key',text='{"summary":"'+key+'", invalid JSON';
 let captured:import('../packages/ai/src/controller/contracts/types.js').ModelOutputAudit|undefined;
 const provider=new OpenAICompatibleProvider({apiKey:key,baseUrl:'https://example.test/v1',apiStyle:'chat',fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]}))});
 await assert.rejects(provider.step({...request,responseSchema:{type:'object'},onOutput:output=>{captured=output;}}),error=>{assert.equal((error as any).diagnostic.reason,'invalid-semantic-json');assert.ok(!JSON.stringify(error).includes(key));return true;});
 assert.deepEqual(captured,{text:text.replaceAll(key,'[redacted]'),characters:text.length,clipped:false});
});

test('private output audit clips explicitly at the parser limit without accepting oversized output',async()=>{
 const {OpenAICompatibleProvider}=await import('../packages/ai/src/application/providers/openai-compatible.js');
 const {MODEL_REPLY_CHAR_LIMIT}=await import('../packages/ai/src/controller/contracts/model-json.js');
 const text='x'.repeat(MODEL_REPLY_CHAR_LIMIT+20);let captured:import('../packages/ai/src/controller/contracts/types.js').ModelOutputAudit|undefined;
 const provider=new OpenAICompatibleProvider({apiKey:'synthetic-key',baseUrl:'https://example.test/v1',apiStyle:'chat',fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:text}}]}))});
 await assert.rejects(provider.step({...request,responseSchema:{type:'object'},onOutput:output=>{captured=output;}}),error=>{assert.equal((error as any).diagnostic.reason,'semantic-output-limit');return true;});
 assert.equal(captured!.text.length,MODEL_REPLY_CHAR_LIMIT);assert.equal(captured!.characters,text.length);assert.equal(captured!.clipped,true);
});
test('session provider rejects arbitrary executables, credentials in URLs, and remote HTTP',()=>{
  for(const config of [{kind:'codex',executable:'/tmp/arbitrary'},{kind:'codex',apiKey:'secret'},{kind:'openai-compatible',model:'fake',apiKey:'secret',baseUrl:'http://example.com/v1'},{kind:'openai-compatible',model:'fake',apiKey:'secret',baseUrl:'https://user:password@example.com/v1'},{kind:'openai-compatible',model:'fake',apiKey:'secret',baseUrl:'https://example.com/v1?key=secret'}])assert.throws(()=>createSessionProvider(config));
});
test('session model adapter does not follow redirects or expose echoed keys in results/errors',async()=>{
  const key='synthetic-test-only-provider-key';let redirects=0,echo=false;
  const target=createServer((_req,res)=>{redirects++;res.end('{}');});target.listen(0,'127.0.0.1');await once(target,'listening');const ta=target.address();if(!ta||typeof ta==='string')throw Error();
  const server=createServer(async(req,res)=>{for await(const _chunk of req){}if(!echo){res.writeHead(302,{location:`http://127.0.0.1:${ta.port}/`});res.end();return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({request:{tool:'finish',arguments:{}},summary:key})}}]}));});server.listen(0,'127.0.0.1');await once(server,'listening');const sa=server.address();if(!sa||typeof sa==='string')throw Error();
  try{const p=createSessionProvider({kind:'openai-compatible',apiKey:key,model:'fake',baseUrl:`http://127.0.0.1:${sa.port}/v1`,apiStyle:'chat'});
    for(const useEcho of [false,true]){echo=useEcho;await assert.rejects(p.current.step(request),error=>{assert.ok(!JSON.stringify(error).includes(key));assert.ok(!String(error).includes(key));return true;});}
    assert.equal(redirects,0);assert.ok(!JSON.stringify(p.summary).includes(key));
  }finally{server.closeAllConnections();target.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>target.close(()=>r()))]);}
});
test('explicit model listing is bounded, filters untrusted IDs and never echoes the key',async()=>{
  const {listSessionProviderModels}=await import('../packages/ai/src/application/agent-provider.js');
  const key='synthetic-list-key';let requests=0,oversize=false;
  const server=createServer((req,res)=>{requests++;assert.equal(req.url,'/v1/models');assert.equal(req.headers.authorization,`Bearer ${key}`);res.setHeader('Content-Type','application/json');res.end(oversize?'x'.repeat(262145):JSON.stringify({data:[{id:'valid/model:1',description:key},{id:key},{id:'bad<script>'},{id:'valid/model:1'},...Array.from({length:510},(_,i)=>({id:`model-${i}`}))]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();if(!a||typeof a==='string')throw Error();
  try{const p=createSessionProvider({kind:'openai-compatible',apiKey:key,model:'fake',baseUrl:`http://127.0.0.1:${a.port}/v1`});assert.equal(requests,0);
    const result=await listSessionProviderModels(p);assert.equal(result.models.length,500);assert.equal(result.models[0],'valid/model:1');assert.ok(!JSON.stringify(result).includes(key));assert.ok(!result.models.includes('bad<script>'));
    oversize=true;await assert.rejects(listSessionProviderModels(p),/Unable to read/);
    assert.deepEqual(await listSessionProviderModels(createSessionProvider({kind:'offline'})),{models:[]});assert.equal(requests,2);
    assert.throws(()=>createSessionProvider({kind:'openai-compatible',apiKey:key,model:'fake',baseUrl:`http://127.0.0.1:${a.port}/v1/${key.replaceAll('-','%2D')}`}));
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('provider discriminants reject arrays rather than string-coercing them',()=>{
  assert.throws(()=>createSessionProvider({kind:['openai-compatible'],model:'fake',baseUrl:'https://example.com/v1',apiKey:'synthetic-key'}));
  assert.throws(()=>createSessionProvider({kind:'openai-compatible',model:'fake',baseUrl:'https://example.com/v1',apiKey:'synthetic-key',responseFormat:['json_schema']}));
});


test('local Codex discovery returns only listed model IDs and tolerates missing or invalid cache',async()=>{
  const {listLocalCodexModels}=await import('../packages/ai/src/application/agent-provider.js');
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'local-model-list-'));
  try{
    assert.deepEqual(await listLocalCodexModels(dir),{models:[]});
    await writeFile(join(dir,'models_cache.json'),JSON.stringify({private:'synthetic-secret',models:[{slug:'test-model',visibility:'list'},{slug:'hidden-model',visibility:'hide'},{slug:'test-model',visibility:'list'},{slug:'bad<script>',visibility:'list'}]}));
    assert.deepEqual(await listLocalCodexModels(dir),{models:['test-model']});
    await writeFile(join(dir,'models_cache.json'),'invalid');assert.deepEqual(await listLocalCodexModels(dir),{models:[]});
  }finally{await rm(dir,{recursive:true,force:true});}
});


test('provider presets resolve only their own environment key at the fixed endpoint',async()=>{
 const {sessionProviderPresets}=await import('../packages/ai/src/application/agent-provider.js');
 const env={GEMINI_API_KEY:'synthetic-gemini-key',DEEPSEEK_API_KEY:'synthetic-deepseek-key',OPENROUTER_API_KEY:'synthetic-openrouter-key',MINIMAX_API_KEY:'synthetic-minimax-key'};
 const catalog=sessionProviderPresets(env);assert.deepEqual(catalog.map(p=>p.id),['gemini','deepseek','openrouter','minimax']);assert.ok(catalog.every(p=>p.hasKey));
 assert.ok(!JSON.stringify(catalog).includes('synthetic-'));
 for(const [preset,key]of [['deepseek',env.DEEPSEEK_API_KEY],['openrouter',env.OPENROUTER_API_KEY],['minimax',env.MINIMAX_API_KEY]] as const){
  const provider=createSessionProvider({kind:'openai-compatible',preset},undefined,env);
  assert.equal(provider.key,key);assert.equal(provider.summary.keySource,'environment');assert.equal(provider.summary.preset,preset);assert.equal(provider.summary.apiStyle,'chat');
  if(preset==='minimax')assert.equal(provider.summary.responseFormat,'json_object');
  assert.ok(!JSON.stringify(provider.summary).includes(key));
  assert.throws(()=>createSessionProvider({kind:'openai-compatible',preset,baseUrl:'https://other.example/v1'},undefined,env));
  assert.throws(()=>createSessionProvider({kind:'openai-compatible',baseUrl:provider.summary.baseUrl,model:'test'},undefined,env));
  const cleared=createSessionProvider({kind:'openai-compatible',preset,apiKey:''},provider,env);assert.equal(cleared.summary.hasKey,false);
 }
 assert.throws(()=>createSessionProvider({kind:'codex',preset:'deepseek'},undefined,env));
 assert.throws(()=>createSessionProvider({kind:'openai-compatible',preset:'unknown'},undefined,env));
 assert.throws(()=>createSessionProvider({kind:'openai-compatible',preset:'deepseek'},undefined,{}));
});


test('official MiniMax structured responses split reasoning without extending unrelated providers',async()=>{
 const {OpenAICompatibleProvider}=await import('../packages/ai/src/application/providers/openai-compatible.js');
 for(const baseUrl of ['https://api.minimax.io/v1','https://example.test/v1']){
  let body:any;
  const provider=new OpenAICompatibleProvider({apiKey:'synthetic-key',baseUrl,apiStyle:'chat',responseFormat:'json_object',fetchImpl:async(_url,init)=>{body=JSON.parse(String(init?.body));return Response.json({choices:[{finish_reason:'stop',message:{reasoning_content:'private reasoning',content:'{"summary":"ok"}'}}]});}});
  const result=await provider.step({...request,model:'MiniMax-M3.1-Flash'});
  assert.equal(body.reasoning_split,baseUrl.includes('api.minimax.io')?true:undefined);
  assert.deepEqual(result.reply,{summary:'ok'});
 }
});

test('malformed JSON records structural evidence without retaining or leaking output text',async()=>{
 const {OpenAICompatibleProvider}=await import('../packages/ai/src/application/providers/openai-compatible.js');
 const {safeSessionDiagnostic}=await import('../packages/ai/src/controller/contracts/provider-error.js');
 const text='plain text with private content';
 const provider=new OpenAICompatibleProvider({apiKey:'synthetic-key',baseUrl:'https://example.test/v1',apiStyle:'chat',fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:text}}]})});
 await assert.rejects(provider.step(request),error=>{
  const diagnostic=safeSessionDiagnostic((error as any).diagnostic);
  assert.deepEqual(diagnostic.outputFormat,{characters:text.length,startsWithObject:false,codeFence:false,reasoningTag:false});
  assert.ok(!JSON.stringify(diagnostic).includes(text));return true;
 });
});


test('JSON syntax diagnostics keep an exact error position without recording content',async()=>{
 const {OpenAICompatibleProvider}=await import('../packages/ai/src/application/providers/openai-compatible.js');
 const {safeSessionDiagnostic}=await import('../packages/ai/src/controller/contracts/provider-error.js');
 const text='{"summary":"private reply", broken}';
 const provider=new OpenAICompatibleProvider({apiKey:'synthetic-key',baseUrl:'https://example.test/v1',apiStyle:'chat',fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:text}}]})});
 await assert.rejects(provider.step(request),error=>{const d=safeSessionDiagnostic((error as any).diagnostic);assert.equal(d.reason,'invalid-semantic-json');assert.equal(d.outputFormat?.jsonErrorOffset,text.indexOf('broken'));assert.ok(!JSON.stringify(d).includes('private reply'));return true;});
});
