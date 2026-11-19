import {commanderModelFactory} from './helpers/model-fixture.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CommanderWorker} from '../packages/ai/src/controller/runtime/commander-worker.js';
import {initialState,type AgentProvider,type ModelDispatchReceipt} from '../packages/ai/src/controller/contracts/types.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {CommanderStore} from '../packages/server/src/commander-store.js';
import {observation} from '../packages/server/src/player-api.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
async function drain(w:CommanderWorker){for(let i=0;w.busy&&i<500;i++)await new Promise(r=>setTimeout(r,2));assert.equal(w.busy,false);}
function fixture(){
 const state=initialState('merge-commander',0,{model:'fake',personality:'schemer'}),store=new AiStore(':memory:'),threads=new CommanderStore();
 const obs=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,state.roomId);
 let failAck=false,calls=0;
 const make=(provider?:AgentProvider,onDirectives:()=>void=()=>{})=>new CommanderWorker({state,expectedPlayer:0,roster:()=>[],store,available:()=>true,onDirectives,provider:commanderModelFactory(()=>provider??{step:async req=>{calls++;await req.beforeSend?.();req.onSend?.(0);return{reply:{tool:'finish',arguments:{memory:{strategy:'已保存的新战略'}},summary:'已整理'},tokens:1};}}),transport:{request:async(path,data)=>{
  if(path==='/tool/observation')return obs;
  if(path!=='/tool/commander/worker')throw Error('Unexpected side effect');
  if(data){if((data as {op:string}).op==='ack'&&failAck)throw Error('ACK offline');return threads.worker(state.roomId,0,data,0);}
  return threads.read(state.roomId,0);
 }}});
 const confirm=async(id:string,text:string)=>{
  const version=threads.read(state.roomId,0).directives.version;
  await threads.send(state.roomId,0,{id,text,references:[]},obs);
  await threads.worker(state.roomId,0,{op:'reply',messageId:id,reply:'请确认',proposal:{baseVersion:version,text,summary:text}},0);
  const proposal=threads.read(state.roomId,0).messages.find(m=>m.replyTo===id)!.proposal!;
  await threads.confirm(state.roomId,0,{proposalId:proposal.id,version},0);
 };
 return{state,store,threads,obs,make,confirm,calls:()=>calls,setFail:(value:boolean)=>{failAck=value;}};
}
test('merged reconciliation retries ACK after restart without another provider call and settles only its committed dispatch',async()=>{
 const f=fixture();let w=f.make();try{
  await f.confirm('first','守住北线');f.setFail(true);w.tick();await drain(w);
  const pending=f.store.latest<ModelDispatchReceipt>(f.state.roomId,0,'provider-dispatch-commander')!;
  assert.equal(pending.status,'pending');assert.equal(pending.outcome,'completed');assert.equal(f.calls(),1);
  assert.equal(f.store.latest(f.state.roomId,0,'commander-call-failed'),null);
  await w.close();w=f.make();f.setFail(false);w.tick();await drain(w);
  assert.equal(f.calls(),1);assert.equal(f.threads.read(f.state.roomId,0).directives.appliedVersion,1);
  const settled=f.store.latest<ModelDispatchReceipt>(f.state.roomId,0,'provider-dispatch-commander')!;
  assert.equal(settled.id,pending.id);assert.equal(settled.status,'settled');assert.equal(f.state.memory.strategy,'已保存的新战略');
 }finally{await w.close();f.store.close();}
});

test('invalid reconciliation remains held after restart until a new player message authorizes fresh analysis',async t=>{
 let now=Date.now(),calls=0;t.mock.method(Date,'now',()=>now);
 const f=fixture(),provider:AgentProvider={step:async req=>{calls++;if(calls===1)return {tokens:0,reply:{tool:'finish',arguments:{memory:null},summary:'格式缺项'}};assert.doesNotMatch(req.prompt,/本次只纠正输出/);return {tokens:0,reply:{tool:'finish',arguments:{memory:{strategy:'集中兵力进攻天火，保留核心据点守备。'}},summary:'已调整战略文字。'}};}};
 let w=f.make(provider);try{
  await f.confirm('attack','集中兵力进攻天火');w.tick();await drain(w);assert.equal(calls,1);
  assert.equal(f.threads.read(f.state.roomId,0).directives.appliedVersion,0);await w.close();
  w=f.make(provider);w.tick();await drain(w);assert.equal(calls,1);
  now+=6000;w.tick();await drain(w);assert.equal(calls,1);assert.equal(f.threads.read(f.state.roomId,0).directives.appliedVersion,0);
  await f.confirm('retry','集中兵力进攻天火');now+=1001;w.tick();await drain(w);assert.equal(calls,2);assert.equal(f.threads.read(f.state.roomId,0).directives.appliedVersion,2);
  assert.equal(f.state.commanderDirectives!.text,'集中兵力进攻天火');assert.equal(f.state.memory.strategy,'集中兵力进攻天火，保留核心据点守备。');
 }finally{await w.close();f.store.close();}
});

test('a newer confirmed version supersedes a held failure of the previous instruction',async t=>{
 let now=Date.now(),calls=0;t.mock.method(Date,'now',()=>now);
 const f=fixture(),provider:AgentProvider={step:async req=>{calls++;if(calls===1)return {tokens:0,reply:{tool:'finish',arguments:{memory:null},summary:'格式缺项'}};assert.doesNotMatch(req.prompt,/上一份回复已完整返回/);assert.match(req.prompt,/转守南线/);return {tokens:0,reply:{tool:'finish',arguments:{memory:{strategy:'转守南线'}},summary:'已调整'}};}};
 const w=f.make(provider);try{
  await f.confirm('first-version','进攻北线');w.tick();await drain(w);
  await f.confirm('second-version','转守南线');now+=6000;w.tick();await drain(w);
  assert.equal(calls,2);assert.equal(f.threads.read(f.state.roomId,0).directives.appliedVersion,2);assert.equal(f.state.memory.strategy,'转守南线');
 }finally{await w.close();f.store.close();}
});
test('recovering an older committed ACK never settles or unholds a newer unknown discussion',async()=>{
 const f=fixture();let w=f.make();try{
  await f.confirm('first','守住北线');f.setFail(true);w.tick();await drain(w);await w.close();
  const unknown:ModelDispatchReceipt={id:'unknown-newer',status:'pending',outcome:'unknown',boundary:'provider-adapter-handoff',mode:'discuss',version:1,messageId:'unanswered'};
  f.store.save(f.state,'provider-dispatch-commander',unknown);
  w=f.make();f.setFail(false);w.tick();await drain(w);
  assert.equal(f.calls(),1);assert.equal(f.threads.read(f.state.roomId,0).directives.appliedVersion,1);
  assert.deepEqual(f.store.latest(f.state.roomId,0,'provider-dispatch-commander'),unknown);
  assert.ok(f.store.latest<{messages:string[]}>(f.state.roomId,0,'commander-model-hold')!.messages.includes('unanswered'));
 }finally{await w.close();f.store.close();}
});
test('a saved receipt for an old directive cannot acknowledge a new directive',async()=>{
 const f=fixture();let w=f.make();try{
  await f.confirm('first','守住北线');f.setFail(true);w.tick();await drain(w);await w.close();
  await f.confirm('second','改守南线');f.setFail(false);w=f.make();w.tick();await drain(w);
  assert.equal(f.calls(),2);assert.equal(f.threads.read(f.state.roomId,0).directives.appliedVersion,2);
  assert.equal(f.store.latest<{version:number}>(f.state.roomId,0,'commander-reconciled')!.version,2);
 }finally{await w.close();f.store.close();}
});
test('same-authority commander memory uses last commit order while retaining the overwritten strategy audit',async()=>{
 const f=fixture();let release!:(x:any)=>void;
 const w=f.make({step:async req=>{await req.beforeSend?.();req.onSend?.(0);return new Promise(r=>{release=r;});}});
 try{
  await f.confirm('first','守住北线');w.tick();for(let i=0;!release&&i<100;i++)await new Promise(r=>setTimeout(r,2));assert.ok(release);
  const external=f.store.load(f.state.roomId,0)!;external.memory={...external.memory,strategy:'独立写入的新战略'};f.store.save(external,'external-memory');
  release({reply:{tool:'finish',arguments:{memory:{strategy:'过时副本'}},summary:'已整理'},tokens:1});await drain(w);
  assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'过时副本');
  assert.equal(f.threads.read(f.state.roomId,0).directives.appliedVersion,1);
  assert.ok(f.store.latest(f.state.roomId,0,'commander-reconciled'));assert.ok(JSON.stringify(f.store.latest(f.state.roomId,0,'memory-overwritten')).includes('独立写入的新战略'));
 }finally{await w.close();f.store.close();}
});

test('server-applied ACK with lost response is recovered and the committed pending dispatch is settled',async()=>{
 const f=fixture();let w=f.make();try{
  await f.confirm('first','守住北线');f.setFail(true);w.tick();await drain(w);await w.close();
  // The server applied the ACK before the connection was lost; the local
  // journal still has a committed strategy with an unsettled dispatch.
  await f.threads.worker(f.state.roomId,0,{op:'ack',version:1,reply:'已同步'},0);
  w=f.make();f.setFail(false);w.tick();await drain(w);
  assert.equal(f.calls(),1);
  assert.equal(f.store.latest<ModelDispatchReceipt>(f.state.roomId,0,'provider-dispatch-commander')!.status,'settled');
 }finally{await w.close();f.store.close();}
});

test('refresh of new authority preserves the latest durable private memory',async()=>{
 const f=fixture(),w=f.make();try{
  f.state.memory.strategy='旧共享副本';f.store.save(f.state);await f.confirm('first','守北线');
  const fresh=f.store.load(f.state.roomId,0)!;fresh.memory.strategy='其他写入者的新战略';f.store.save(fresh,'external-memory');
  await w.refresh();assert.equal(f.state.memory.strategy,'其他写入者的新战略');
  assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'其他写入者的新战略');
  assert.equal(f.state.commanderDirectives!.version,1);
 }finally{await w.close();f.store.close();}
});
test('refresh refuses older remote authority than durable authority and never advances shared authority on failed CAS',async()=>{
 const f=fixture(),w=f.make();try{
  f.store.save(f.state);await f.confirm('first','守北线');
  const original=f.store.save.bind(f.store);let raced=false;
  f.store.save=(state,kind,details,basis)=>{
   if(kind==='commander-directives'&&!raced){raced=true;const fresh=f.store.load(state.roomId,0)!;fresh.memory.strategy='CAS 胜出的新记忆';fresh.commanderDirectives={version:2,text:'更新指令'};original(fresh,'external-authority');}
   return original(state,kind,details,basis);
  };
  await assert.rejects(w.refresh(),/LOCAL_BASIS_CHANGED/);
  assert.equal(f.state.commanderDirectives,undefined);
  assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'CAS 胜出的新记忆');
  await assert.rejects(w.refresh(),/Stale commander authority/);
  assert.equal(f.store.load(f.state.roomId,0)!.commanderDirectives!.version,2);
 }finally{await w.close();f.store.close();}
});
test('heartbeat authority refresh preserves external memory but cannot rebase an already sent model response',async()=>{
 const f=fixture();let release!:(x:any)=>void;
 const w=f.make({step:async req=>{await req.beforeSend?.();req.onSend?.(0);return new Promise(r=>{release=r;});}});
 try{
  await f.confirm('first','守北线');w.tick();for(let i=0;!release&&i<100;i++)await new Promise(r=>setTimeout(r,2));assert.ok(release);
  const fresh=f.store.load(f.state.roomId,0)!;fresh.memory.strategy='并行新记忆';f.store.save(fresh,'external-memory');
  await f.confirm('second','守南线');await w.refresh();
  release({reply:{tool:'finish',arguments:{memory:{strategy:'旧请求过时结果'}},summary:'已整理'},tokens:1});await drain(w);
  assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'并行新记忆');assert.equal(f.state.commanderDirectives!.version,2);
  assert.equal(f.store.latest(f.state.roomId,0,'commander-reconciled'),null);
  assert.equal(f.threads.read(f.state.roomId,0).directives.appliedVersion,0);
 }finally{await w.close();f.store.close();}
});
test('failure and restart hold diagnostics preserve durable memory and authority rather than the stale worker object',async()=>{
 const f=fixture();let reject!:(x:Error)=>void;
 let w=f.make({step:async req=>{await req.beforeSend?.();req.onSend?.(0);return new Promise((_resolve,r)=>{reject=r;});}});
 try{
  await f.confirm('first','守北线');w.tick();for(let i=0;!reject&&i<100;i++)await new Promise(r=>setTimeout(r,2));assert.ok(reject);
  const fresh=f.store.load(f.state.roomId,0)!;fresh.memory.strategy='失败时也必须保留';f.store.save(fresh,'external-memory');
  reject(Error('unknown transport outcome'));await drain(w);
  assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'失败时也必须保留');
  await w.close();w=f.make();assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'失败时也必须保留');
  assert.equal(f.store.latest<ModelDispatchReceipt>(f.state.roomId,0,'provider-dispatch-commander')!.status,'pending');
 }finally{await w.close();f.store.close();}
});

test('saved ACK recovery with real runner notification preserves external durable memory and authority',async()=>{
 const {SeatRunner}=await import('../packages/ai/src/reference.js');
 const f=fixture();let w=f.make();try{
  await f.confirm('first','守北线');f.setFail(true);w.tick();await drain(w);await w.close();
  const external=f.store.load(f.state.roomId,0)!;external.memory.strategy='ACK 前的新记忆';f.store.save(external,'external-memory');
  const runner=new SeatRunner(f.state,f.store,{snapshot:async()=>({observation:f.obs,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2}),request:async()=>{throw Error('No game writes');}},{step:async()=>{throw Error('No decision model');}});
  w=f.make(undefined,()=>runner.requestMemoryReview());f.setFail(false);w.tick();await drain(w);
  assert.equal(f.calls(),1);assert.equal(f.threads.read(f.state.roomId,0).directives.appliedVersion,1);
  assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'ACK 前的新记忆');
  assert.equal(f.store.latest<ModelDispatchReceipt>(f.state.roomId,0,'provider-dispatch-commander')!.status,'settled');
 }finally{await w.close();f.store.close();}
});
test('discarding a response on external authority CAS does not roll durable authority backward during settlement',async()=>{
 const f=fixture();let release!:(x:any)=>void;
 const w=f.make({step:async req=>{await req.beforeSend?.();req.onSend?.(0);return new Promise(r=>{release=r;});}});
 try{
  await f.confirm('first','守北线');w.tick();for(let i=0;!release&&i<100;i++)await new Promise(r=>setTimeout(r,2));assert.ok(release);
  const external=f.store.load(f.state.roomId,0)!;external.commanderDirectives={version:2,text:'其他写入者新权威'};external.memory.strategy='其他写入者新记忆';f.store.save(external,'external-authority');
  release({reply:{tool:'finish',arguments:{memory:{strategy:'旧结果'}},summary:'已整理'},tokens:1});await drain(w);
  assert.equal(f.store.load(f.state.roomId,0)!.commanderDirectives!.version,2);
  assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'其他写入者新记忆');
  assert.equal(f.store.latest(f.state.roomId,0,'commander-reconciled'),null);
 }finally{await w.close();f.store.close();}
});

test('refresh notifies once when durable authority is already newer than the shared runtime',async()=>{
 const f=fixture();let wakes=0;const w=f.make(undefined,()=>{wakes++;});try{
  f.store.save(f.state);await f.confirm('first','守北线');
  const external=f.store.load(f.state.roomId,0)!;external.commanderDirectives={version:1,text:'守北线'};external.memory.strategy='已由另一写入者更新';f.store.save(external,'external-authority');
  await w.refresh();await w.refresh();assert.equal(wakes,1);
  assert.equal(f.state.commanderDirectives!.version,1);assert.equal(f.state.memory.strategy,'已由另一写入者更新');
 }finally{await w.close();f.store.close();}
});

for(const window of ['snapshot-return','started-journal-return'] as const){
 test(`commander atomic prompt basis rejects ${window} interposition before provider send`,async t=>{
  const f=fixture();let sends=0,injected=false,views=0;
  f.state.memory.strategy='OLD_PROMPT_SENTINEL';f.store.save(f.state);
  const originalView=f.store.localDecisionView.bind(f.store),originalEvents=f.store.saveEvents.bind(f.store);
  const externalWrite=()=>{injected=true;const latest=f.store.load(f.state.roomId,0)!;latest.memory={...latest.memory,strategy:'FRESH_DURABLE_SENTINEL'};originalEvents(latest,[{kind:'independent-writer',details:null}]);};
  if(window==='snapshot-return')t.mock.method(f.store,'localDecisionView',(...args:Parameters<AiStore['localDecisionView']>)=>{
   const result=originalView(...args);
   // First snapshot is refresh authority, second is the model prompt snapshot.
   if(++views===2)externalWrite();
   return result;
  });
  else t.mock.method(f.store,'saveEvents',(...args:Parameters<AiStore['saveEvents']>)=>{
   const result=originalEvents(...args);
   if(!injected&&args[1].some(event=>event.kind==='commander-call-started'))externalWrite();
   return result;
  });
  const w=f.make({step:async req=>{
   assert.equal(typeof req.beforeSend,'function');assert.equal(typeof req.onSend,'function');
   await req.beforeSend!();req.onSend!(0);sends++;
   return{reply:{tool:'finish',arguments:{memory:{strategy:'MODEL_FROM_STALE_PROMPT'}},summary:'已整理'},tokens:1};
  }});
  try{
   await f.confirm('first','守北线');w.tick();await drain(w);
   assert.equal(injected,true);assert.equal(sends,0,'stale prompt must not reach provider send even with production admission hooks');
   assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'FRESH_DURABLE_SENTINEL');
   assert.equal(f.threads.read(f.state.roomId,0).directives.appliedVersion,0);
   assert.equal(f.store.latest(f.state.roomId,0,'commander-reconciled'),null);
   assert.equal(f.store.latest<{sent:boolean}>(f.state.roomId,0,'queued-stale-before-send')!.sent,false);
  }finally{await w.close();f.store.close();}
 });
}

test('empty commander seat initialization cannot overwrite a competing private writer before prompt capture',async t=>{
 const f=fixture(),save=f.store.save.bind(f.store);let raced=false;const w=f.make();
 try{
  await f.threads.send(f.state.roomId,0,{id:'initial-question',text:'现在如何？',references:[]},f.obs);
  assert.equal(f.store.load(f.state.roomId,0),null);
  t.mock.method(f.store,'save',(...args:Parameters<AiStore['save']>)=>{
   if(args[1]==='state'&&!raced){raced=true;const fresh=structuredClone(f.state);fresh.memory.strategy='CONCURRENT_INITIALIZER';save(fresh,'independent-initializer');}
   return save(...args);
  });
  w.tick();await drain(w);assert.equal(raced,true);assert.equal(f.calls(),0);
  assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'CONCURRENT_INITIALIZER');
  assert.equal(f.store.latest(f.state.roomId,0,'commander-call-started'),null);
 }finally{await w.close();f.store.close();}
});
