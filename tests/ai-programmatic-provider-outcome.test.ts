import {commanderModelFactory} from './helpers/model-fixture.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SeatRunner} from './helpers/scripted-controller.js';
import {AiStore,initialState,type AiSnapshot} from '../packages/ai/src/index.js';
import {ProviderError,classifyProviderFailure} from '../packages/ai/src/controller/contracts/provider-error.js';
import {recoveryDelay} from '../packages/ai/src/controller/runtime/recovery.js';
import {OpenAICompatibleProvider} from '../packages/ai/src/application/providers/openai-compatible.js';
import {ModelCallQueue} from '../packages/ai/src/controller/runtime/model-queue.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
const request=()=>({model:'test',prompt:'No real provider calls',effort:'low' as const,signal:new AbortController().signal});
function fixture(){const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'outcome');const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};return {state:initialState('outcome',0,{model:'fake',personality:'schemer'}),store:new AiStore(':memory:'),gateway:{snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No game writes allowed');}}};}
test('cancelled queue ticket stays unsent, consumes no provider request, and does not recover as a transport failure',async()=>{
 const q=new ModelCallQueue(1),hold=new AbortController();let release!:()=>void;const occupying=q.run(hold.signal,()=>new Promise<void>(r=>{release=r;}));await new Promise<void>(r=>setImmediate(r));
 const abort=new AbortController();let sends=0;const waiting=q.run(abort.signal,async()=>{sends++;});abort.abort();await assert.rejects(waiting,e=>e instanceof ProviderError&&e.code==='cancelled'&&e.outcome==='not-sent'&&recoveryDelay(e,1)===null);release();await occupying;assert.equal(sends,0);assert.equal(q.status.active,0);
});
test('HTTP adapter distinguishes definite 429 rejection from 503 and network unknown outcomes',async()=>{
 for(const status of [429,503]){
  let sends=0;const provider=new OpenAICompatibleProvider({apiKey:'fake',baseUrl:'http://localhost',fetchImpl:async()=>{sends++;return new Response('provider unavailable',{status});}});
  await assert.rejects(provider.step(request()),e=>e instanceof ProviderError&&e.outcome===(status===429?'rejected':'unknown')&&e.retryable===(status===429));assert.equal(sends,1);
 }
 const reset=new OpenAICompatibleProvider({apiKey:'fake',baseUrl:'http://localhost',fetchImpl:async()=>{throw new TypeError('fetch failed ECONNRESET');}});
 await assert.rejects(reset.step(request()),e=>e instanceof ProviderError&&e.outcome==='unknown'&&!e.retryable);
 const malformed=new OpenAICompatibleProvider({apiKey:'fake',baseUrl:'http://localhost',fetchImpl:async()=>new Response('{bad',{status:200})});
 await assert.rejects(malformed.step(request()),e=>e instanceof ProviderError&&e.outcome==='completed'&&e.retryable);
});
test('session API-key redaction preserves minimal retry outcome without retaining raw provider text',async(t)=>{
 const {createSessionProvider}=await import('../packages/ai/src/application/agent-provider.js');let status=429;
 t.mock.method(globalThis,'fetch',async()=>new Response('sensitive-test-key provider response',{status}));
 const provider=createSessionProvider({kind:'openai-compatible',model:'test',apiKey:'sensitive-test-key',baseUrl:'http://localhost'}).current;
 await assert.rejects(provider.step(request()),e=>e instanceof ProviderError&&e.outcome==='rejected'&&e.retryable&&!JSON.stringify(e).includes('sensitive-test-key'));
 status=503;await assert.rejects(provider.step(request()),e=>e instanceof ProviderError&&e.outcome==='unknown'&&!e.retryable&&!JSON.stringify(e).includes('sensitive-test-key'));
});
test('commander unknown model outcome stays held when error delivery fails, including worker restart',async()=>{
 const {CommanderWorker}=await import('../packages/ai/src/controller/runtime/commander-worker.js'),{CommanderStore}=await import('../packages/server/src/commander-store.js');
 const f=fixture(),threads=new CommanderStore(),snapshot=await f.gateway.snapshot();let sends=0;
 await threads.send('outcome',0,{id:'question',text:'当前情况如何？',references:[]},snapshot.observation);
 const make=()=>new CommanderWorker({state:f.state,expectedPlayer:0,roster:()=>[],store:f.store,available:()=>true,onDirectives:()=>{},provider:commanderModelFactory(()=>({step:async()=>{sends++;throw classifyProviderFailure('stream closed ECONNRESET');}})),transport:{request:async(path,data)=>{if(path==='/tool/observation')return snapshot.observation;if(data)throw Error('Error notification transport failed');return threads.read('outcome',0);}}});
 const drain=async(w:InstanceType<typeof CommanderWorker>)=>{for(let i=0;i<100&&w.busy;i++)await new Promise<void>(r=>setImmediate(r));assert.equal(w.busy,false);};let worker=make();
 try{worker.tick();await drain(worker);assert.equal(sends,1);worker.tick(Date.now()+10000);await drain(worker);assert.equal(sends,1);await worker.close();worker=make();worker.tick(Date.now()+20000);await drain(worker);assert.equal(sends,1);assert.equal(threads.read('outcome',0).messages.length,1);}finally{await worker.close();f.store.close();}
});

test('hard process exit after commander handoff restores a durable hold before any restart call',async()=>{
 const {CommanderWorker}=await import('../packages/ai/src/controller/runtime/commander-worker.js');
 const {CommanderStore}=await import('../packages/server/src/commander-store.js');
 const f=fixture(),snapshot=await f.gateway.snapshot(),threads=new CommanderStore();f.store.close();
 await threads.send('outcome',0,{id:'crash-question',text:'当前情况如何？',references:[]},snapshot.observation);
 for(const phase of ['handoff','delivery']){
 const thread=threads.read('outcome',0),dir=mkdtempSync(join(tmpdir(),'commander-dispatch-crash-')),path=join(dir,'seat.sqlite'),marker=join(dir,'sent.txt');
 const url=(relative:string)=>JSON.stringify(new URL(relative,import.meta.url).href);
 const child=`
 import {AiStore,initialState} from ${url('../packages/ai/src/index.js')};
 import {CommanderWorker} from ${url('../packages/ai/src/controller/runtime/commander-worker.js')};
 import {ModelCallQueue} from ${url('../packages/ai/src/controller/runtime/model-queue.js')};
 import {appendFileSync} from 'node:fs';
 const state=initialState('outcome',0,{model:'fake',personality:'schemer'});state.enabled=false;state.status='paused';
 const store=new AiStore(${JSON.stringify(path)}),queue=new ModelCallQueue(1),thread=${JSON.stringify(thread)},snapshot=${JSON.stringify(snapshot)};
 const worker=new CommanderWorker({state,expectedPlayer:0,roster:()=>[],store,available:()=>true,onDirectives:()=>{},
   transport:{request:async(path,data)=>{if(data&&${JSON.stringify(phase)}==='delivery')process.exit(73);return path==='/tool/observation'?snapshot.observation:thread;}},
   provider:()=>({step:r=>queue.run(r.signal,async()=>{appendFileSync(${JSON.stringify(marker)},${JSON.stringify('sent\n')});if(${JSON.stringify(phase)}==='handoff')process.exit(73);return {tokens:0,reply:{request:{tool:'finish',arguments:{memory:null}},summary:'目前没有已确认的新变化。',nextContext:null}};},{beforeSend:r.beforeSend,onStart:r.onSend})})});
 worker.tick();
 `;
 let reopened:AiStore|undefined,worker:InstanceType<typeof CommanderWorker>|undefined;
 try{
   const crashed=spawnSync(process.execPath,['--input-type=module','-e',child],{encoding:'utf8',timeout:10000});
   assert.equal(crashed.status,73,crashed.stderr);assert.equal(readFileSync(marker,'utf8'),'sent\n');
   reopened=new AiStore(path);const state=reopened.load('outcome',0)!;assert.equal(state.enabled,false);
   assert.equal(reopened.latest<any>('outcome',0,'provider-dispatch-commander').status,'pending');
   if(phase==='delivery')assert.equal(reopened.latest<any>('outcome',0,'provider-dispatch-commander').outcome,'completed');
   let sends=0;worker=new CommanderWorker({state,expectedPlayer:0,roster:()=>[],store:reopened,available:()=>true,onDirectives:()=>{},
     transport:{request:async path=>path==='/tool/observation'?snapshot.observation:thread},provider:commanderModelFactory(()=>({step:async()=>{sends++;throw Error('must not retry');}}))});
   for(const now of [Date.now(),Date.now()+600000]){worker.tick(now);for(let i=0;i<100&&worker.busy;i++)await new Promise<void>(r=>setImmediate(r));assert.equal(worker.busy,false);}
   assert.equal(sends,0);assert.deepEqual(reopened.latest<any>('outcome',0,'commander-model-hold').messages,['crash-question']);
   assert.equal(readFileSync(marker,'utf8'),'sent\n');
 }finally{await worker?.close();reopened?.close();rmSync(dir,{recursive:true,force:true});}
 }
});
