import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {AiStore,initialState,type AiSnapshot,type AgentRequest} from '../packages/ai/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {codexArguments,providerCallTimeout} from '../packages/ai/src/application/providers/codex.js';
import {OpenAICompatibleProvider} from '../packages/ai/src/application/providers/openai-compatible.js';
import {validateSettings} from '../packages/ai/src/controller/contracts/types.js';

test('a seat can disable inherited Fast without changing model or reasoning effort',()=>{
 const previous=process.env.AI_CODEX_SERVICE_TIER;
 process.env.AI_CODEX_SERVICE_TIER='fast';
 try{
  const args=codexArguments('test','gpt-6.1-sol','medium','default');
  assert.ok(!args.includes('fast_mode')&&!args.includes('service_tier="fast"'));
  assert.ok(args.includes('gpt-6.1-sol')&&args.includes('model_reasoning_effort="medium"'));
  assert.ok(codexArguments('test','gpt-6-luna','high').includes('fast_mode'));
  assert.equal(validateSettings({model:'gpt-6-luna',personality:'sentinel',reasoningEffort:'high',serviceTier:'fast'}).serviceTier,'fast');
  assert.throws(()=>validateSettings({model:'test',personality:'sentinel',serviceTier:'invalid'}));
 }finally{if(previous===undefined)delete process.env.AI_CODEX_SERVICE_TIER;else process.env.AI_CODEX_SERVICE_TIER=previous;}
});

test('Codex fast tier is explicit and preserves low reasoning and isolated config',()=>{
 const args=codexArguments('test','gpt-6-astra','low','fast');
 assert.ok(args.includes('service_tier="fast"'));
 assert.ok(args.includes('fast_mode'));
 assert.ok(args.includes('model_reasoning_effort="low"'));
 assert.ok(args.includes('--ignore-user-config'));
 assert.throws(()=>codexArguments('test','model','low','unsupported'),/AI_CODEX_SERVICE_TIER/);
});

test('seat medium effort reaches the model request without changing other seat defaults',async()=>{
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const snapshot:AiSnapshot={observation:observation({state:createFleetScenario(cfg),scheduled:[]},0,'medium-test'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const store=new AiStore(':memory:'),state=initialState('medium-test',0,{model:'test',personality:'sentinel',reasoningEffort:'medium',serviceTier:'default'});
 const efforts:string[]=[];
 const runner=new SeatRunner(state,store,{snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No writes');}},{step:async request=>{efforts.push(request.effort??'missing');assert.equal(request.serviceTier,'default');return {tokens:1,reply:{tool:'finish',arguments:{},summary:'完成'}};}});
 try{await runner.poll(0);assert.deepEqual(efforts,['medium']);assert.ok(codexArguments('test','model',state.settings.reasoningEffort,'fast').includes('model_reasoning_effort="medium"'));}finally{store.close();}
});

test('low effort and time allowance remain independent without changing provider defaults',()=>{
 assert.equal(providerCallTimeout('low',300000),300000);
 assert.equal(providerCallTimeout('low'),120000);
 assert.equal(providerCallTimeout('high'),300000);
});

for(const apiStyle of ['chat','responses'] as const)test(`generic ${apiStyle} adapter does not invent unsupported reasoning parameters`,async()=>{
 let body:Record<string,unknown>|undefined;
 const provider=new OpenAICompatibleProvider({apiKey:'offline-test-only',baseUrl:'https://example.test/v1',apiStyle,fetchImpl:async(_,init)=>{
  body=JSON.parse(String(init?.body));
  const text=JSON.stringify({request:{tool:'finish',arguments:{}},summary:'结束'});
  return new Response(JSON.stringify(apiStyle==='chat'?{choices:[{finish_reason:'stop',message:{content:text}}],usage:{prompt_tokens:1,completion_tokens:1}}:{status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text}]}],usage:{input_tokens:1,output_tokens:1}}),{status:200});
 }});
 await provider.step({model:'unsupported-test-model',prompt:'离线协议测试',effort:'low',timeoutMs:300000,signal:new AbortController().signal});
 assert.ok(body);assert.equal('reasoning' in body,false);assert.equal('reasoning_effort' in body,false);
 assert.equal('timeoutMs' in body,false);
});
