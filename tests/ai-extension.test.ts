import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {BotPluginCatalog} from '../packages/ai/src/application/plugin-catalog.js';
import {join,resolve} from 'node:path';
import {BotModeRegistry,type BotModeDefinition,type AiSettings,type AgentProvider} from '../packages/ai/src/extension.js';
import {AgentRuntime,startAgentConsole,parseAgentConfig} from '../packages/ai/src/runtime.js';
import {hybridDefinition} from '../plugins/hybrid/src/api.js';
import {exampleRegistry,factoryPolicy,customHybrid} from '../examples/ai-extension/strategies.js';
import {exampleModel} from '../examples/ai-extension/model.js';
import {protocolHarness} from './player-protocol-test-helpers.js';
import {createPlayerProtocolApi} from '../packages/server/src/player-protocol-api.js';
import {PlayerProtocolCoordinator} from '../packages/server/src/player-protocol-coordinator.js';
import {SerialExecutor} from '../packages/server/src/player-access.js';
import {ChatStore} from '../packages/server/src/chat.js';
import {CommanderStore} from '../packages/server/src/commander-store.js';
import type {RuntimeEntry} from '../packages/ai/src/application/runtime-entry.js';

const settings=(mode='factory-policy',strategyConfig?:unknown):AiSettings=>({mode,model:'',provider:'offline',personality:'schemer',...(strategyConfig===undefined?{}:{strategyConfig})});
test('source registry validates registered definitions, isolates seat instances and rejects shared factories',()=>{
 const registry=exampleRegistry(),resolveMode=registry.resolver(),a={},b={};
 assert.notEqual(resolveMode(settings(),a),resolveMode(settings(),b));
 assert.equal(resolveMode(settings(),a),resolveMode(settings(),a));
 assert.equal(resolveMode({model:'',personality:'schemer'}).id,'hybrid');
 assert.throws(()=>resolveMode(settings('missing')),/Unknown bot mode/);
 assert.throws(()=>resolveMode(settings('factory-policy',{unexpected:true})),/does not accept/);
 assert.throws(()=>registry.register(factoryPolicy),/sealed/);
 const singleton=factoryPolicy.create(undefined),shared=new BotModeRegistry([{...factoryPolicy,create:()=>singleton}]).resolver();
 shared(settings(),a);assert.throws(()=>shared(settings(),b),/shared bot mode/);
 assert.throws(()=>new BotModeRegistry([factoryPolicy,factoryPolicy]),/Duplicate/);
});

test('strategy-specific validated configuration reaches a new instance without replacing another seat',()=>{
 const definition:BotModeDefinition={...factoryPolicy,validateConfig:config=>{if(typeof config!=='number')throw Error('Expected number');},create:config=>({...factoryPolicy.create(undefined),diagnostics:()=>({value:config})})};
 const get=new BotModeRegistry([definition]).resolver(),a={},b={},one=get(settings('factory-policy',1),a),two=get(settings('factory-policy',1),b);
 assert.notEqual(get(settings('factory-policy',2),a),one);assert.equal(get(settings('factory-policy',1),b),two);
});

async function host(t:TestContext,mode:string,provider:AgentProvider=exampleModel,modes=exampleRegistry(),useModel=false){
 const cleanups:(()=>void)[]=[];
 const h=protocolHarness({after:(cleanup:()=>void)=>cleanups.push(cleanup)} as unknown as TestContext);h.elapsed+=31_000;
 const grant=h.grant(0,['observe','events.read','commands.write','control.lease','chat.send','commander.worker']);
 const chat=new ChatStore(join(h.dir,'chat.json'));await chat.load();
 const commander=new CommanderStore(join(h.dir,'commander.json'));await commander.load();
 const coordinator=new PlayerProtocolCoordinator(h.repository,{roomId:()=> 'fixture-room',load:()=>h.store.load()!.room});
 await coordinator.bindDomains(chat,commander);coordinator.refreshWorld();
 const server=createPlayerProtocolApi({repository:h.repository,roomId:'fixture-room',serial:new SerialExecutor(),load:()=>h.store.load()!,commit:(room,revision)=>{const next=h.store.commit(room,revision);coordinator.refreshWorld();return next;},chat:()=>chat,commander,capabilities:()=>coordinator.capabilities(),snapshot:player=>coordinator.snapshot(player),instructionsVersion:player=>coordinator.instructionsVersion(player)});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const config=parseAgentConfig({storeDirectory:join(h.dir,'private-ai'),seats:[{id:'sample',serverUrl:`http://127.0.0.1:${address.port}`,roomId:'fixture-room',lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:h.store.load()!.room.state.economy.players.length,tokenEnv:'TEST_TOKEN',settings:{...settings(mode),...(useModel||['model-policy','late-model'].includes(mode)?{provider:'fixture',model:'fixture'}:{})}}]});
 const runtime=new AgentRuntime(config,provider,{TEST_TOKEN:grant.token},{modes});
 t.after(async()=>{await runtime.shutdown();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));for(const cleanup of cleanups)cleanup();});
 return {h,runtime,config};
}

test('registered source policy runs through the real console, shared executor and authoritative receipt',async t=>{
 const {h,runtime}=await host(t,'factory-policy');
 assert.equal(runtime.status()[0]!.enabled,false);
 const consoleServer=await startAgentConsole(runtime,{webRoot:resolve('packages/client/agent-console-public'),port:0,provider:'offline',connectionMode:'configured'});
 t.after(()=>consoleServer.close());
 const page=await fetch(consoleServer.url),cookie=page.headers.get('set-cookie')!.split(';')[0]!;
 const boot=await fetch(new URL('/api/agent/bootstrap',consoleServer.url),{headers:{Cookie:cookie,'X-Agent-Console':'1'}}),{csrf}=await boot.json() as {csrf:string};
 const read=await fetch(new URL('/api/agent/config',consoleServer.url),{headers:{Cookie:cookie,'X-Agent-CSRF':csrf}});
 const configuration=await read.json() as {strategies:{id:string}[]};assert.deepEqual(configuration.strategies.map(s=>s.id),['hybrid','factory-policy','custom-hybrid']);
 await runtime.runOne('sample');
 assert.equal(runtime.status()[0]!.status,'paused');assert.equal(runtime.status()[0]!.error,null);
 assert.equal(h.store.load()!.room.state.commands.filter(c=>c.action.kind==='set-shields').length,1);
 const logs=runtime.consoleLogs('sample').entries;assert.ok(logs.some(row=>row.kind==='tool-result'));
 assert.ok(logs.every(row=>!JSON.stringify(row).includes('TEST_TOKEN')));
 const live=runtime.debugRead('sample','live') as {strategyDetails?:unknown};assert.ok(live.strategyDetails);
});

test('model-led policy receives admitted raw JSON and submits only through the shared executor',async t=>{
 let calls=0;
 const modelPolicy:BotModeDefinition={...factoryPolicy,id:'model-policy',label:'模型策略测试',capabilities:{model:true,commander:false},create:()=>{
  const base=factoryPolicy.create(undefined);
  return {...base,id:'model-policy',recordPrefix:'mode-model-policy',usesModelProvider:true,prepare:input=>{
   const prepared=base.prepare(input);
   return {...prepared,run:async(request,services)=>{
    assert.ok(services.model);
    const result=await services.model.step({...request,prompt:'Return the requested JSON.',responseSchema:{type:'object',additionalProperties:false,properties:{summary:{type:'string'}},required:['summary']}});
    assert.deepEqual(result.reply,{summary:'admitted'});
    return prepared.run(request,services);
   }};
  }};
 }};
 const {h,runtime}=await host(t,'model-policy',{step:async request=>{await request.beforeSend?.();request.signal.throwIfAborted();calls++;return {reply:{summary:'admitted'},tokens:3,usage:{inputTokens:2,outputTokens:1},usageKnown:{provenance:'reported',input:true,output:true,cached:false}};}},new BotModeRegistry([hybridDefinition,modelPolicy]));
 await runtime.runOne('sample');assert.equal(calls,1);assert.equal(runtime.status()[0]!.error,null);
 assert.equal(runtime.status()[0]!.calls,1);assert.equal(runtime.status()[0]!.tokens,3);
 assert.equal(h.store.load()!.room.state.commands.filter(c=>c.action.kind==='set-shields').length,1);
 const callsPage=runtime.debugRead('sample','calls') as {entries:unknown[]};assert.equal(callsPage.entries.length,1);
});

test('custom hybrid example retains official capabilities and completes a real paused round',async t=>{
 const {runtime}=await host(t,'custom-hybrid');
 const instance=customHybrid.create(undefined);assert.equal(instance.supportsCommander,true);assert.deepEqual(instance.analysisWindows,{attackTicks:144,localTicks:144});
 await runtime.runOne('sample');assert.equal(runtime.status()[0]!.status,'paused');assert.equal(runtime.status()[0]!.error,null);
 assert.ok(runtime.consoleLogs('sample').entries.some(row=>row.kind==='tool-result'));
});

test('custom hybrid uses its injected prompt and deterministic model through shared background auditing',async t=>{
 let prompt='';const {runtime}=await host(t,'custom-hybrid',{step:async request=>{prompt=request.prompt;return exampleModel.step(request);}},exampleRegistry(),true);
 await runtime.runOne('sample');
 const status=runtime.status()[0]!;assert.equal(status.error,null);assert.equal(status.status,'paused');assert.ok(status.calls>0);
 const page=runtime.debugRead('sample','calls') as {entries:{callRef:number;lane:string}[]};assert.ok(page.entries.length>0);
 const content=runtime.debugRead('sample','content',{ref:String(page.entries[0]!.callRef),kind:'prompt',limit:'32768'}) as {available:boolean;reason:string};
 assert.match(prompt,/本示例优先解释守住工厂与扩大产能/);assert.equal(content.available,true);
});

test('strategy switching preserves namespaced records and rejects pending writes and unsupported confirmed requirements',async t=>{
 const {runtime}=await host(t,'factory-policy');await runtime.runOne('sample');
 const entry=(runtime as unknown as {entries:Map<string,RuntimeEntry>}).entries.get('sample')!;
 const old=entry.store.latest('fixture-room',0,'mode-factory-policy-last-choice');assert.ok(old);
 runtime.updateSettings('sample',settings('custom-hybrid'));
 assert.deepEqual(entry.store.latest('fixture-room',0,'mode-factory-policy-last-choice'),old);
 const receiptState=entry.store.latest<Record<string,unknown>>('fixture-room',0,'receipt-observation-state')!;
 entry.store.save(entry.runner.state,'receipt-observation-state',{...receiptState,pendingWrites:['unconfirmed-synthetic-command']});
 assert.throws(()=>runtime.updateSettings('sample',settings()),/pending writes/);
 assert.equal(entry.runner.state.settings.mode,'custom-hybrid');
 entry.store.save(entry.runner.state,'receipt-observation-state',receiptState);
 entry.runner.state.commanderDirectives={version:1,text:'守住已有矿场'};
 assert.throws(()=>runtime.updateSettings('sample',settings()),/指挥官/);
 assert.equal(entry.runner.state.settings.mode,'custom-hybrid');
});

test('a paused model-led round cannot publish a late reply or execute an order',async t=>{
 let started!:()=>void,release!:(value:import('../packages/ai/src/extension.js').ModelResult<unknown>)=>void;
 const entered=new Promise<void>(done=>{started=done;}),result=new Promise<import('../packages/ai/src/extension.js').ModelResult<unknown>>(done=>{release=done;});
 const definition:BotModeDefinition={...factoryPolicy,id:'late-model',label:'暂停测试',capabilities:{model:true,commander:false},create:()=>{
  const base=factoryPolicy.create(undefined);return {...base,id:'late-model',recordPrefix:'mode-late-model',usesModelProvider:true,prepare:input=>{
   const prepared=base.prepare(input);return {...prepared,run:async(request,services)=>{await services.model.step({...request,responseSchema:{type:'object',properties:{},additionalProperties:false}});services.record('published',{late:true});return prepared.run(request,services);}};
  }};
 }};
 const {runtime,h}=await host(t,'late-model',{step:async()=>{started();return result;}},new BotModeRegistry([hybridDefinition,definition]));
 const entry=(runtime as unknown as {entries:Map<string,RuntimeEntry>}).entries.get('sample')!;
 const running=runtime.runOne('sample');await entered;
 const paused=runtime.pause('sample');release({reply:{},tokens:2});await Promise.all([running,paused]);
 assert.equal(h.store.load()!.room.state.commands.filter(c=>c.action.kind==='set-shields').length,0);
 assert.equal(entry.store.latest('fixture-room',0,'mode-late-model-published'),null);
 assert.equal(runtime.status()[0]!.status,'paused');
});

test('folder plugin uses authenticated console validation and the authoritative shared executor',async t=>{
 const registry=new BotModeRegistry([hybridDefinition]);
 const {h,runtime}=await host(t,'hybrid',exampleModel,registry);
 const source=join(h.dir,'folder-plugin');await mkdir(source);
 await writeFile(join(source,'bot-plugin.json'),JSON.stringify({apiVersion:1,id:'folder-policy',name:'Folder policy',version:'1.0.0',entry:'index.ts'}));
 await writeFile(join(source,'index.ts'),`import {buildLocalModeContext} from '@subterfuge/ai';
 export default {id:'folder-policy',label:'Folder policy',capabilities:{model:false,commander:false},validateConfig:c=>{if(c!==undefined)throw Error('No configuration');},create:()=>({
 id:'folder-policy',recordPrefix:'mode-folder-policy',usesModelProvider:false,supportsCommander:false,automaticEventCoalesceMs:undefined,retainSignals:s=>s,needsAnalysis:()=>false,afterAction:()=>({tokens:0,reply:{tool:'finish',arguments:{},summary:'Done'}}),
 prepare:input=>({context:buildLocalModeContext(input.state,input.snapshot,'Folder policy'),run:async()=>{const o=input.snapshot.observation,p=o.view.outposts.find(p=>p.owner===o.view.player&&p.type==='factory'&&p.shieldsEnabled);return {tokens:0,executionObservation:o,reply:p?{tool:'order',arguments:{action:{kind:'set-shields',outpostId:o.outpostNames[p.id],enabled:false}},summary:'Factory'}:{tool:'finish',arguments:{},summary:'Done'}};}})
 })};`);
 const catalog=new BotPluginCatalog(join(h.dir,'plugins'),registry);await catalog.load();
 const server=await startAgentConsole(runtime,{plugins:catalog,webRoot:resolve('packages/client/agent-console-public'),port:0,provider:'offline',connectionMode:'configured'});t.after(()=>server.close());
 const page=await fetch(server.url),cookie=page.headers.get('set-cookie')!.split(';')[0]!;
 const boot=await fetch(new URL('/api/agent/bootstrap',server.url),{headers:{Cookie:cookie,'X-Agent-Console':'1'}}).then(r=>r.json()) as {csrf:string};
 const post=async(path:string,data:unknown,csrf=boot.csrf)=>fetch(new URL('/api/agent/'+path,server.url),{method:'POST',headers:{Cookie:cookie,Origin:new URL(server.url).origin,'X-Agent-CSRF':csrf,'Content-Type':'application/json'},body:JSON.stringify(data)});
 assert.equal((await post('plugins/install',{directory:source,trusted:true},'bad-csrf')).status,403);
 assert.equal((await post('plugins/install',{directory:source,trusted:false})).status,400);
 assert.equal((await post('plugins/install',{directory:source,trusted:true})).status,200);
 const before=h.store.load()!.room.state.commands.length;
 const checked=await post('plugins/validate',{id:'folder-policy',seat:'sample'});assert.equal(checked.status,200);assert.equal((await checked.json()).valid,true);
 assert.equal(h.store.load()!.room.state.commands.length,before,'Validation cannot issue a game order');
 assert.equal((await post('plugins/validate',{id:'folder-policy',seat:5})).status,400);
 assert.equal((await post('configuration',{id:'sample',settings:settings('folder-policy')})).status,200);
 assert.equal((await post('plugins/install',{directory:source,trusted:true,replace:true})).status,400,'Selected plugins cannot be replaced');
 h.elapsed+=31_000;await runtime.runOne('sample');assert.equal(runtime.status()[0]!.error,null,JSON.stringify(runtime.consoleLogs('sample').entries));
 assert.equal(h.store.load()!.room.state.commands.filter(c=>c.action.kind==='set-shields').length,1);
 assert.ok(runtime.consoleLogs('sample').entries.some(row=>row.kind==='tool-result'));
});
