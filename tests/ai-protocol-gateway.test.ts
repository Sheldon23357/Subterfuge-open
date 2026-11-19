import {AgentRuntime,SeatRunner} from './helpers/scripted-controller.js';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {join} from 'node:path';
import {readFileSync,readdirSync} from 'node:fs';
import {protocolHarness} from './player-protocol-test-helpers.js';
import {createPlayerProtocolApi} from '../packages/server/src/player-protocol-api.js';
import {PlayerProtocolCoordinator} from '../packages/server/src/player-protocol-coordinator.js';
import {SerialExecutor} from '../packages/server/src/player-access.js';
import {ChatStore} from '../packages/server/src/chat.js';
import {CommanderStore} from '../packages/server/src/commander-store.js';
import {ProtocolPlayerGateway} from '../packages/ai/src/controller/transport/protocol-gateway.js';
import {MemoryProtocolClientStore,PlayerProtocolClient} from '../packages/player-sdk/src/index.js';import {agentStoreKey} from '../packages/ai/src/reference.js';import {AiStore,initialState} from '../packages/ai/src/index.js';
import {parseAgentConfig,type AgentSeatConfig} from '../packages/ai/src/controller/contracts/agent-config.js';
import type {AgentProvider} from '../packages/ai/src/controller/contracts/types.js';
import type {PlayerObservation} from '../packages/contracts/src/index.js';
import {advanceFleetScenario} from '../packages/engine/src/index.js';
import {advanceRoom} from '../packages/server/src/planning.js';
const syntheticModelSecret='SYNTHETIC_MODEL_SECRET_NEVER_TRANSMIT_123456';
async function setup(t:TestContext){
  const h=protocolHarness(t);h.elapsed+=31000;
  const grant=h.grant(0,['observe','events.read','commands.write','control.lease','chat.send','commander.worker']);
  const chat=new ChatStore(join(h.dir,'chat.json'));await chat.load();const commander=new CommanderStore(join(h.dir,'commander.json'));await commander.load();
  const coordinator=new PlayerProtocolCoordinator(h.repository,{roomId:()=> 'fixture-room',load:()=>h.store.load()!.room});await coordinator.bindDomains(chat,commander);coordinator.refreshWorld();
  const server=createPlayerProtocolApi({repository:h.repository,roomId:'fixture-room',serial:new SerialExecutor(),load:()=>h.store.load()!,commit:(room,revision)=>{const next=h.store.commit(room,revision);coordinator.refreshWorld();return next;},chat:()=>chat,commander,capabilities:()=>coordinator.capabilities(),snapshot:player=>coordinator.snapshot(player),instructionsVersion:player=>coordinator.instructionsVersion(player)});
  const requests:{path:string;body:string;authorization:string}[]=[];server.on('request',req=>{const row={path:req.url??'',body:'',authorization:String(req.headers.authorization??'')};requests.push(row);req.on('data',chunk=>{row.body+=String(chunk);});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const config:AgentSeatConfig={id:'seat0',serverUrl:`http://127.0.0.1:${address.port}`,roomId:'fixture-room',lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:h.store.load()!.room.state.economy.players.length,tokenEnv:'EXECUTOR_TOKEN',settings:{model:'synthetic-test-model',personality:'schemer'}};
  const gateway=new ProtocolPlayerGateway(config,grant.token,new MemoryProtocolClientStore());
  return{h,chat,commander,coordinator,server,config,grant,gateway,requests};
}
test('Official v2 adapter uses scoped SDK for observation, game write, chat and readiness without any v1 network traffic',async t=>{
  const x=await setup(t);await x.gateway.checkIdentity();assert.equal(x.gateway.writable,false);const before=await x.gateway.snapshot(0,0);assert.equal(before.observation.view.player,0);
  await x.gateway.acquire();const after=await x.gateway.request('/tool/order',{revision:before.observation.revision,order:{id:'official-test-order',action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}}) as PlayerObservation;
  assert.notEqual(after.revision,before.observation.revision);assert.equal(x.h.store.load()!.room.state.commands.length,1);
  await x.gateway.request('/tool/chat',{id:'official-test-chat',to:null,text:'Synthetic integration test message.'});assert.equal(x.chat.listForSeat(0).length,1);
  const ready=await x.gateway.snapshot(0,0),readinessStart=x.requests.length;await x.gateway.request('/tool/control/ready',{ready:false});await x.gateway.request('/tool/control/ready',{ready:true,revision:ready.observation.revision,chatCursor:ready.chatCursor});
  assert.deepEqual(x.requests.slice(readinessStart).map(r=>r.path),['/player/v2/commands','/player/v2/commands'],'readiness uses the observer cut without fetching events, snapshots or activity again');
  await x.gateway.release();assert.ok(x.requests.every(r=>r.path.startsWith('/player/v2/')));assert.ok(x.requests.some(r=>r.path==='/player/v2/commands'));assert.equal(x.gateway.writable,false);
});
test('Synchronized local snapshots require no foreground requests and install world, chat and Commander changes',async t=>{
  const x=await setup(t);await x.gateway.checkIdentity();await x.gateway.acquire();
  x.gateway.programmaticAutoAdvance=true;
  const first=await x.gateway.snapshot(0,0),count=()=>x.requests.filter(r=>r.path.startsWith('/player/v2/sync?')).length;
  const initial=count();await x.gateway.snapshot(0,0);await x.gateway.snapshot(0,0);assert.equal(count(),initial);
  first.observation.view.outposts.length=0;
  assert.ok((await x.gateway.snapshot(0,0)).observation.view.outposts.length>0,'returned documents must be detached');
  await x.chat.sendFromSeat(1,{id:'cached-chat-change',to:0,text:'Synthetic cache invalidation'},x.config.chatCount,0);
  await x.gateway.waitForChange();const chat=await x.gateway.snapshot(0,0);assert.ok(chat.chat.some(m=>m.text==='Synthetic cache invalidation'));assert.equal(count(),initial+1);
  await x.commander.send('fixture-room',0,{id:'cached-commander-change',text:'Synthetic work',references:[]},chat.observation);
  const thread=await x.gateway.discussionTransport.request('/tool/commander/worker') as import('../packages/contracts/src/index.js').CommanderThread;
  assert.ok(thread.messages.some(m=>m.id==='cached-commander-change'));assert.equal(count(),initial+1,'Commander polling does not install a foreground snapshot');
  const before=await x.gateway.snapshot(chat.chatCursor,chat.notificationCursor);
  const changed=await x.gateway.request('/tool/order',{revision:before.observation.revision,order:{id:'cached-world-change',action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}}) as PlayerObservation;
  assert.notEqual(changed.revision,before.observation.revision);assert.ok(count()>initial+1);
  x.gateway.programmaticAutoAdvance=false;const previous=count();await x.gateway.snapshot(0,0);await x.gateway.snapshot(0,0);assert.equal(count(),previous,'a verified unchanged remote turn cut is reusable too');
  await x.gateway.release();
});
test('foreground reads remain local while the independent live synchronization request is stalled',async t=>{
 const x=await setup(t);let block=false,entered!:()=>void,release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});t.after(()=>release());
 const requests:string[]=[];
 const gateway=new ProtocolPlayerGateway(x.config,x.grant.token,new MemoryProtocolClientStore(),{fetch:async(input,init)=>{
  const path=new URL(String(input)).pathname;requests.push(path);if(block&&path==='/player/v2/sync'){entered();await gate;}return fetch(input,init);
 }});
 await gateway.acquire();const initial=await gateway.snapshot(0,0);block=true;
 const pending=gateway.waitForChange();await started;const count=requests.length;
 const read=await gateway.snapshot(0,0);assert.equal(read.observation.revision,initial.observation.revision);
 assert.equal(requests.length,count,'normal foreground reads issue no HTTP request');
 const startedAt=performance.now();for(let i=0;i<50;i++)await gateway.snapshot(0,0);
 t.diagnostic(JSON.stringify({fixture:'local-live-cut',reads:50,durationMs:performance.now()-startedAt,httpRequests:requests.length-count}));assert.equal(requests.length,count);
 release();await pending;await gateway.release();
});

test('Official v2 runtime actually calls fake provider after explicit start, restarts paused, and never transmits model key',async t=>{
  const x=await setup(t),config=parseAgentConfig({storeDirectory:join(x.h.dir,'ai-private'),seats:[x.config]});let calls=0;const fake:AgentProvider={step:async()=>{calls++;return{reply:{tool:'finish',arguments:{},summary:'synthetic finish'},tokens:0};}};
  const environment={EXECUTOR_TOKEN:x.grant.token,OPENAI_API_KEY:syntheticModelSecret};let runtime=new AgentRuntime(config,fake,environment);
  try{
    assert.equal(runtime.status()[0]!.enabled,false);assert.equal(calls,0);await runtime.runOne('seat0');assert.equal(calls,1);assert.equal(runtime.status()[0]!.status,'paused');
    assert.ok(!x.requests.some(r=>r.path.startsWith('/player/v2/queries/')));assert.ok(x.requests.every(r=>r.path.startsWith('/player/v2/')));assert.ok(!JSON.stringify(x.requests).includes(syntheticModelSecret));
    await runtime.shutdown();runtime=new AgentRuntime(config,fake,environment);assert.equal(runtime.status()[0]!.enabled,false);assert.equal(runtime.status()[0]!.calls,0);assert.equal(calls,1);
    assert.equal(agentStoreKey(x.config),agentStoreKey({...x.config}));
    const filenames=readdirSync(config.storeDirectory).filter(name=>name.endsWith('.sqlite'));assert.equal(filenames.length,1);assert.ok(!readFileSync(join(config.storeDirectory,filenames[0]!)).includes(Buffer.from(syntheticModelSecret)));
  }finally{await runtime.shutdown();}
});
test('Configuration rejects obsolete protocol selectors and requires v2 capabilities',async t=>{
  const x=await setup(t);assert.throws(()=>parseAgentConfig({storeDirectory:x.h.dir,seats:[{...x.config,protocol:'auto'}] as any}),/protocol/);
  const host=createPlayerProtocolApi({repository:x.h.repository,roomId:'fixture-room',serial:new SerialExecutor(),load:()=>x.h.store.load()!,commit:(room,revision)=>x.h.store.commit(room,revision)});host.listen(0,'127.0.0.1');await once(host,'listening');const address=host.address();assert.ok(address&&typeof address==='object');const requests:string[]=[];host.on('request',req=>requests.push(req.url??''));
  try{const gateway=new ProtocolPlayerGateway({...x.config,serverUrl:`http://127.0.0.1:${address.port}`},x.grant.token,new MemoryProtocolClientStore());await assert.rejects(gateway.acquire(),/stale-observation|PROTOCOL_INCOMPATIBLE/);assert.ok(requests.every(path=>path.startsWith('/player/v2/')));assert.equal(gateway.writable,false);}finally{host.closeAllConnections();await new Promise<void>(resolve=>host.close(()=>resolve()));}
});
test('Official Commander transport uses durable worker scope while gameplay stays paused',async t=>{
  const x=await setup(t);await x.gateway.checkIdentity();await x.commander.send('fixture-room',0,{id:'sdk-private-message',text:'Synthetic discussion request',references:[]},(await x.gateway.snapshot(0,0)).observation);
  const before=await x.gateway.discussionTransport.request('/tool/commander/worker') as import('../packages/contracts/src/index.js').CommanderThread;assert.equal(before.messages[0]!.id,'sdk-private-message');
  const result=await x.gateway.discussionTransport.request('/tool/commander/worker',{op:'reply',messageId:'sdk-private-message',reply:'Synthetic scoped reply.'}) as import('../packages/contracts/src/index.js').CommanderThread;
  assert.ok(result.messages.some(message=>message.replyTo==='sdk-private-message'));assert.equal(x.gateway.writable,false);assert.equal(x.h.store.load()!.room.state.commands.length,0);assert.ok(x.requests.some(request=>request.path==='/player/v2/commander/worker'));
  const operations=Object.values(x.gateway.client.state.outbox);assert.equal(operations.length,1);assert.equal(operations[0]!.request.kind,'commander-worker');assert.equal(operations[0]!.state,'settled');
});
test('same-tick Commander-installed snapshots preserve the turn completion signature',async t=>{
 const x=await setup(t);await x.gateway.acquire();
 const before=await x.gateway.snapshot(0,0);const signature=x.gateway.readinessSignature;assert.ok(signature);
 await x.gateway.request('/tool/control/ready',{ready:true,revision:before.observation.revision,chatCursor:before.chatCursor});
 await x.chat.sendFromSeat(1,{id:'ready-cache-change',to:0,text:'New facts for the runner'},x.config.chatCount,0);
 await x.gateway.discussionTransport.request('/tool/observation');
 assert.equal(x.gateway.readinessSignature,signature,'transport ingestion does not reopen a completed tick');
 const after=await x.gateway.snapshot(0,0);assert.equal(x.gateway.readinessSignature,signature);assert.ok(x.gateway.readinessSignature);
 await x.gateway.request('/tool/control/ready',{ready:true,revision:after.observation.revision,chatCursor:after.chatCursor});
 assert.equal(x.h.repository.readyPlayers('fixture-room',100).find(s=>s.player===0)?.ready,true);
});

test('Official tick completion accepts later same-tick chat without consuming it',async t=>{
  const x=await setup(t);await x.gateway.checkIdentity();await x.gateway.acquire();const decision=await x.gateway.snapshot(0,0);
  await x.chat.sendFromSeat(1,{id:'new-chat-after-decision',to:0,text:'Synthetic later information'},x.config.chatCount,0);
  const completed=await x.gateway.request('/tool/control/ready',{ready:true,tick:decision.observation.view.tick,revision:decision.observation.revision,chatCursor:decision.chatCursor}) as {ready:boolean};assert.equal(completed.ready,true);assert.equal(x.h.repository.readyPlayers('fixture-room',100)[0]!.ready,true);
  const consumed=await x.gateway.snapshot(decision.chatCursor,decision.notificationCursor);const next=await x.gateway.request('/tool/control/ready',{ready:true,revision:consumed.observation.revision,chatCursor:consumed.chatCursor}) as {ready:boolean};assert.equal(next.ready,true);await x.gateway.release();
});

test('event hints distinguish ordinary same-tick changes, background messages and the next tick',async t=>{
 const x=await setup(t);await x.gateway.acquire();await x.gateway.snapshot(0,0);
 x.h.apply(x.h.command('ordinary-change',{payload:{action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}}));x.coordinator.refreshWorld();
 const ordinary=await x.gateway.waitForChange();assert.equal(ordinary?.tick,100);assert.equal(ordinary?.background,false);
 await x.chat.sendFromSeat(1,{id:'background-hint',to:0,text:'offer'},x.config.chatCount,0);
 const chat=await x.gateway.waitForChange();assert.equal(chat?.background,true);
 const head=x.h.store.load()!;x.h.store.commit(advanceRoom(head.room,101),head.revision);x.coordinator.refreshWorld();
 const next=await x.gateway.waitForChange();assert.equal(next?.tick,101);assert.equal(next?.background,false);
 await x.gateway.release();
});

test('event wait wakes on a committed incoming message without installing the foreground cursor',async t=>{
  const x=await setup(t);await x.gateway.acquire();await x.gateway.snapshot(0,0);
  const cursor=x.gateway.client.state.cursor!;
  const waiting=x.gateway.client.waitForEvents(cursor,1000);
  await new Promise(resolve=>setTimeout(resolve,30));
  await x.gateway.renew(); // A waiting read must not occupy the room executor.
  await x.chat.sendFromSeat(1,{id:'wake-message',to:0,text:'event wake'},x.config.chatCount,0);
  const page=await waiting;assert.ok(page.events.some(e=>e.type==='chat.added'||e.type==='chat.changed'));
  assert.equal(x.gateway.client.state.cursor,cursor,'wake hints never install or consume the decision cut');
  await x.gateway.release();
});

test('restored nonzero Commander version can report observed readiness without authorizing old-version orders',async t=>{
 const x=await setup(t);await x.gateway.checkIdentity();const first=await x.gateway.snapshot(0,0);
 await x.commander.send('fixture-room',0,{id:'confirmed-before-restart',text:'Protect home',references:[]},first.observation);
 x.commander.workerSync('fixture-room',0,{op:'reply',messageId:'confirmed-before-restart',reply:'Proposed constraint',proposal:{baseVersion:0,text:'Protect home',summary:'Fixture directive'}},0);
 const proposal=x.commander.read('fixture-room',0).messages.find(m=>m.proposal)?.proposal;assert.ok(proposal);
 x.commander.confirmSync('fixture-room',0,{proposalId:proposal.id,version:0},0);
 await x.gateway.acquire();const snapshot=await x.gateway.snapshot(0,0);assert.equal(x.gateway.commanderVersion,0);
 await x.gateway.request('/tool/control/ready',{ready:false});
 const ready=await x.gateway.request('/tool/control/ready',{ready:true,revision:snapshot.observation.revision,chatCursor:snapshot.chatCursor}) as {ready:boolean};assert.equal(ready.ready,true);
 assert.equal(x.gateway.commanderVersion,0,'readiness cannot promote the version used by strategic writes');
 await assert.rejects(x.gateway.request('/tool/order',{revision:snapshot.observation.revision,order:{id:'old-commander-order',action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}}),(error:unknown)=>(error as {code?:string}).code==='INSTRUCTIONS_CHANGED');
 assert.equal(x.h.store.load()!.room.state.commands.length,0);await x.gateway.release();
});
test('runner automatically reconciles a committed order after followup recovery without resubmitting it',async t=>{
 const x=await setup(t);let committed=false,unavailable=true,calls=0,source='';
 const gateway=new ProtocolPlayerGateway(x.config,x.grant.token,new MemoryProtocolClientStore(),{fetch:async(input,init)=>{
  if(committed&&unavailable&&new URL(String(input)).pathname==='/player/v2/sync')throw Error('synthetic followup failure');
  const response=await fetch(input,init);if(String(input).endsWith('/commands')&&JSON.parse(String(init?.body)).kind==='order')committed=(await response.clone().json()).state==='applied';return response;
 }});
 const state=initialState('fixture-room',0,x.config.settings),store=new AiStore(':memory:');state.enabled=true;
 const runner=new SeatRunner(state,store,gateway,{step:async()=>({tokens:0,reply:++calls===1?{tool:'order',arguments:{action:{kind:'set-shields',outpostId:source,enabled:false}},summary:'synthetic order'}:{tool:'finish',arguments:{},summary:'recovered'}})});
 try{
  await gateway.acquire();source=(await gateway.snapshot(0,0)).observation.outpostNames!['蓝方工厂']!;assert.ok(source);
  await runner.poll(0,true);assert.equal(runner.recovering,true,JSON.stringify({calls,committed,status:state.status,error:store.latest('fixture-room',0,'error')}));assert.equal(state.enabled,true);assert.equal(gateway.writable,false);
  const retry=store.latest<any>('fixture-room',0,'error').recovery;assert.ok(retry);
  unavailable=false;await runner.poll(Date.parse(retry.at)+1,true);
  assert.equal(state.status,'waiting');assert.equal(state.enabled,true);assert.equal(gateway.writable,true);assert.equal(calls,2);
  assert.equal(x.h.store.load()!.room.state.commands.length,1);
 }finally{runner.pause();store.close();await gateway.release();}
});

test('An acknowledged game write fences new writes until a followup snapshot recovers without replay',async t=>{
  const x=await setup(t);let committed=false,unavailable=true;const gateway=new ProtocolPlayerGateway(x.config,x.grant.token,new MemoryProtocolClientStore(),{fetch:async(input,init)=>{
    if(committed&&unavailable&&new URL(String(input)).pathname==='/player/v2/sync')throw Error('synthetic snapshot disconnect');const response=await fetch(input,init);if(String(input).endsWith('/commands')&&JSON.parse(String(init?.body)).kind==='order')committed=true;return response;
  }});
  await gateway.acquire();const observation=(await gateway.snapshot(0,0)).observation;
  const command={revision:observation.revision,order:{id:'committed-followup-lost',action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}};
  await assert.rejects(gateway.request('/tool/order',command),(error:unknown)=>{const failure=error as {diagnostic?:{outcome?:string}};return failure.diagnostic?.outcome==='unknown';});
  assert.equal(gateway.writable,false);assert.equal(x.h.store.load()!.room.state.commands.length,1);assert.equal(Object.values(gateway.client.state.outbox)[0]!.receipt?.state,'applied');
  await assert.rejects(gateway.request('/tool/order',{...command,order:{...command.order,id:'must-not-replace'}}));assert.equal(x.h.store.load()!.room.state.commands.length,1);
  assert.ok(gateway.expiresAt>Date.now(),'the owned lease remains available for renewal');
  await assert.rejects(gateway.snapshot(0,0),(error:any)=>error.diagnostic?.failure==='accepted-write-followup-failed'&&!!error.diagnostic.cause);
  unavailable=false;await gateway.snapshot(0,0);assert.equal(gateway.writable,true);
  assert.equal(x.h.store.load()!.room.state.commands.length,1);await gateway.release();
});


test('runtime automatically reacquires an expired fence through the real protocol without submitting gameplay twice',async t=>{
 const x=await setup(t),config=parseAgentConfig({storeDirectory:join(x.h.dir,'recovery-runtime'),seats:[x.config]});
 const runtime=new AgentRuntime(config,{step:async()=>{throw Error('Recovery must not call the model');}},{EXECUTOR_TOKEN:x.grant.token});
 try{
  await runtime.start('seat0');const entry=(runtime as any).entries.get('seat0'),gateway=entry.gateway as ProtocolPlayerGateway;
  const originalFence=gateway.client.authority().fence;
  // Both the authority and the scheduler see an expired lease. Valid local
  // leases renew asynchronously and do not fence independent foreground work.
  x.h.elapsed+=31000;Object.defineProperty(gateway,'expiresAt',{configurable:true,get:()=>Date.now()-1});
  t.mock.timers.enable({apis:['setTimeout']});await runtime.tick();
  assert.equal(runtime.status()[0]!.enabled,true);assert.equal(gateway.writable,false);assert.ok(entry.recoveryTimer);assert.match(runtime.status()[0]!.error!,/自动重连/);
  Reflect.deleteProperty(gateway,'expiresAt'); // Reacquisition must expose its actual new lease deadline.
  t.mock.timers.tick(15000);assert.ok(entry.starting);await entry.starting;
  assert.equal(runtime.status()[0]!.enabled,true);assert.equal(runtime.status()[0]!.owned,true);assert.equal(runtime.status()[0]!.error,null);assert.notEqual(gateway.client.authority().fence,originalFence);
  assert.equal(x.requests.filter(r=>r.path==='/player/v2/control/acquire').length,2);assert.equal(x.requests.filter(r=>r.path==='/player/v2/commands').length,0);assert.ok(!x.requests.some(r=>r.path.includes('/owner/')));
 }finally{await runtime.shutdown();}
});


test('recovery acquisition stops when another executor renews instead of taking over',async t=>{
 const x=await setup(t),other=new ProtocolPlayerGateway(x.config,x.grant.token,new MemoryProtocolClientStore());let checks=0;
 const gateway=new ProtocolPlayerGateway(x.config,x.grant.token,new MemoryProtocolClientStore(),{fetch:async(input,init)=>{
  if(String(input).includes('/player/v2/control?')&&++checks===3){x.h.wall+=10;await other.renew();}
  return fetch(input,init);
 }});
 try{
  await other.acquire();await assert.rejects(gateway.acquire(),/CONTROL_LEASE_RENEWED/);
  assert.equal(gateway.writable,false);assert.equal(other.writable,true);assert.equal((await other.client.control()).sessionId,other.client.sessionId);
  assert.equal(x.requests.filter(r=>r.path==='/player/v2/control/acquire').length,1);assert.ok(!x.requests.some(r=>r.path.includes('/owner/')));
 }finally{await other.release();gateway.close();other.close();}
});

test('official gateway submits a scoped basis from the original detached observation',async t=>{
 const x=await setup(t);await x.gateway.checkIdentity();await x.gateway.acquire();
 try{
  const snapshot=await x.gateway.snapshot(0,0),o=snapshot.observation;
  const source=o.view.outposts.find(p=>p.owner===0&&(p.drillers??0)>0),target=o.view.outposts.find(p=>p.owner===1);assert.ok(source&&target);
  const revision=o.revision;source.drillers=999999;
  const response=await x.gateway.request('/tool/order',{revision,order:{id:'scoped-launch',action:{kind:'launch',source:source.id,destination:target.id,drillers:1}}}) as {protocolReceipt:{state:string}};
  assert.equal(response.protocolReceipt.state,'applied');
  const sent=x.requests.filter(r=>r.path==='/player/v2/commands').map(r=>JSON.parse(r.body)).find(r=>r.kind==='order');
  assert.equal(sent.expectedRevision,revision);assert.match(sent.actionBasis,/^[0-9a-f]{64}$/);
 }finally{await x.gateway.release();}
});


test('combined authority guards share one verified document and reject changed authority on the next guard',async t=>{
 const x=await setup(t);await x.gateway.acquire();const initial=await x.gateway.snapshot(0,0);
 const manual=initial.observation.manualCommands?.version??0;let supplied=0;
 x.gateway.commanderRefresh=async thread=>{assert.ok(thread);supplied++;return thread.directives.version;};
 const start=x.requests.length;await x.gateway.authorityCheck(0,manual);
 const requests=x.requests.slice(start);
 assert.equal(supplied,1);
 assert.equal(requests.filter(r=>r.path.startsWith('/player/v2/sync?')).length,1,'both checks share one live cut');
 assert.equal(requests.filter(r=>r.path.startsWith('/player/v2/control?')).length,1,'identity is checked once');
 assert.equal(requests.filter(r=>r.path==='/player/v2/snapshot').length,0,'unchanged turn reuses its verified document');
 await assert.rejects(x.gateway.authorityCheck(0,manual+1),error=>!!error&&typeof error==='object'&&'code'in error&&error.code==='manual-replan-required');
 await x.commander.send('fixture-room',0,{id:'authority-change',text:'Protect home',references:[]},initial.observation);
 x.commander.workerSync('fixture-room',0,{op:'reply',messageId:'authority-change',reply:'Proposed constraint',proposal:{baseVersion:0,text:'Protect home',summary:'Fixture directive'}},0);
 const thread=await x.gateway.discussionTransport.request('/tool/commander/worker') as import('../packages/contracts/src/index.js').CommanderThread,proposal=thread.messages.find(message=>message.proposal)?.proposal!;
 x.commander.confirmSync('fixture-room',0,{proposalId:proposal.id,version:0},0);
 await assert.rejects(x.gateway.authorityCheck(0,manual),error=>!!error&&typeof error==='object'&&'code'in error&&error.code==='commander-replan-required');
 await x.gateway.authorityCheck(1,manual);
 await x.gateway.discussionTransport.request('/tool/commander/worker',{op:'ack',version:1,reply:'Confirmed current instructions'});
});

for(const blocked of ['commander','sync'] as const)test(`independent reads: a stalled ${blocked} does not block the other lane`,async t=>{
 const x=await setup(t);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});t.after(()=>release());
 const gateway=new ProtocolPlayerGateway(x.config,x.grant.token,new MemoryProtocolClientStore(),{fetch:async(input,init)=>{const url=new URL(String(input));if(url.pathname==='/player/v2/'+blocked){entered();await gate;}return fetch(input,init);}});
 await gateway.checkIdentity();const foreground=()=>gateway.snapshot(0,0),background=()=>gateway.discussionTransport.request('/tool/commander/worker');
 const held=blocked==='commander'?background():foreground();await started;
 const other=blocked==='commander'?foreground():background();let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([other,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('The other lane was blocked')),3000);})]);}finally{if(timer)clearTimeout(timer);release();}
 await held;
 const prior=structuredClone(gateway.client.state),signature=gateway.readinessSignature,from=x.requests.length;
 await Promise.all([gateway.discussionTransport.request('/tool/commander/worker'),gateway.discussionTransport.request('/tool/observation')]);
 assert.deepEqual(gateway.client.state,prior,'background reads must not advance foreground cursors, snapshots or outbox');assert.equal(gateway.readinessSignature,signature);
 assert.ok(!x.requests.slice(from).some(r=>/snapshot|activity|control/.test(r.path)),'thread and observation read only their independent endpoints');
});

test('background snapshot launches world and chat reads together and preserves foreground readiness',async t=>{
 const x=await setup(t);const waiting=new Map<string,()=>void>();let observedBoth!:()=>void;const both=new Promise<void>(r=>{observedBoth=r;});
 const gateway=new ProtocolPlayerGateway(x.config,x.grant.token,new MemoryProtocolClientStore(),{fetch:async(input,init)=>{const path=new URL(String(input)).pathname;if(['/player/v2/observation','/player/v2/chat'].includes(path)){await new Promise<void>(r=>{waiting.set(path,r);if(waiting.size===2)observedBoth();});}return fetch(input,init);}});
 await gateway.checkIdentity();const before=structuredClone(gateway.client.state),pending=gateway.snapshot(0,0,true);let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([both,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Independent reads ran serially')),3000);})]);}finally{if(timer)clearTimeout(timer);for(const release of waiting.values())release();}
 const snapshot=await pending;assert.equal(snapshot.observation.roomId,x.config.roomId);assert.deepEqual(gateway.client.state,before);assert.equal(gateway.readinessSignature,null);
});

test('a background-consumed message prefix can lead a fixed foreground cut without stopping or rereading',async t=>{
 const x=await setup(t);await x.gateway.acquire();const initial=await x.gateway.snapshot(0,0),cut=structuredClone(x.gateway.client.state);
 await x.chat.sendFromSeat(1,{id:'background-ahead-chat',to:0,text:'New private message'},x.config.chatCount,0);
 const background=await x.gateway.snapshot(initial.chatCursor,initial.notificationCursor,true);
 assert.ok(background.chatCursor>initial.chatCursor);assert.deepEqual(x.gateway.client.state,cut);
 const requests=x.requests.length,foreground=await x.gateway.snapshot(background.chatCursor,initial.notificationCursor);
 assert.equal(foreground.observation.revision,initial.observation.revision);assert.deepEqual(foreground.chat,[]);
 assert.equal(foreground.chatCursor,initial.chatCursor);assert.equal(foreground.hasMore,false);assert.equal(x.requests.length,requests,'no forced refresh or retry for an already consumed prefix');
 await assert.rejects(x.gateway.snapshot(background.chatCursor+1,initial.notificationCursor),/outside this room epoch/,'unproven cursor advances remain invalid');
 await x.gateway.waitForChange();const updated=await x.gateway.snapshot(background.chatCursor,initial.notificationCursor);
 assert.equal(updated.chatCursor,background.chatCursor);assert.deepEqual(updated.chat,[],'already consumed messages are not replayed');await x.gateway.release();
});

test('independent read endpoints preserve seat scope and reject seat override queries',async t=>{
 const x=await setup(t);const other=x.h.grant(1,['observe']);
 for(const path of ['/observation','/commander']){
  const response=await fetch(x.config.serverUrl+'/player/v2'+path,{headers:{Authorization:'Bearer '+other.token}});assert.equal(response.status,200);const data=await response.json() as any;
  assert.equal(path==='/observation'?data.observation.view.player:data.thread.player,1);
  const override=await fetch(x.config.serverUrl+'/player/v2'+path+'?player=0',{headers:{Authorization:'Bearer '+other.token}});assert.equal(override.status,400);
  const denied=x.h.grant(1,['events.read']);const rejected=await fetch(x.config.serverUrl+'/player/v2'+path,{headers:{Authorization:'Bearer '+denied.token}});assert.equal(rejected.status,403);
 }
});

test('concurrent background write context cannot replace foreground cancellation or revision',async t=>{
 const x=await setup(t);await x.gateway.acquire();const snapshot=await x.gateway.snapshot(0,0),revision=snapshot.observation.revision;
 const seen:string[]=[];x.gateway.debugGate.enabled=true;t.mock.method(x.gateway.debugGate,'beforeWrite',async(...[_path,_body,context]:Parameters<typeof x.gateway.debugGate.beforeWrite>)=>{seen.push(context!.turn);throw Error('Synthetic stop before write');});
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),foreground={turn:'foreground',deadline:Date.now()+60000,signal:new AbortController().signal,revision},background={...foreground,turn:'background'};
 const pending=x.gateway.withWriteContext(background,async()=>{await gate;await assert.rejects(x.gateway.request('/tool/chat',{id:'background',to:null,text:'test',revision}),/Synthetic stop/);});
 x.gateway.writeContext(foreground);release();await pending;
 await assert.rejects(x.gateway.request('/tool/chat',{id:'foreground',to:null,text:'test',revision}),/Synthetic stop/);assert.deepEqual(seen,['background','foreground']);x.gateway.writeContext(null);await x.gateway.release();
});

test('an updated background instruction version cannot relabel an older foreground action',async t=>{
 const x=await setup(t);await x.gateway.acquire();const snapshot=await x.gateway.snapshot(0,0);t.mock.method(x.coordinator,'instructionsVersion',()=> '1');
 x.gateway.writeContext({turn:'old-foreground',deadline:Date.now()+60000,signal:new AbortController().signal,revision:snapshot.observation.revision,instructionsVersion:0});x.gateway.commanderVersion=1;
 await assert.rejects(x.gateway.request('/tool/order',{revision:snapshot.observation.revision,order:{id:'old-foreground-action',action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}}),(error:unknown)=>(error as {code?:string}).code==='INSTRUCTIONS_CHANGED');
 assert.equal(x.h.store.load()!.room.state.commands.length,0);x.gateway.writeContext(null);await x.gateway.release();
});

test('pending-write checks use indexed metadata without loading historical bodies',()=>{
 let pending=false;const store={load:()=>assert.fail('Historical outbox bodies were loaded'),transaction:()=>assert.fail('A read must not transact'),outboxEntries:(states:readonly string[])=>{assert.deepEqual(states,['prepared','unknown','accepted','blocked']);return pending?[{} as never]:[];}};
 const client=new PlayerProtocolClient({serverUrl:'http://127.0.0.1:1',token:'synthetic',expectedIdentity:{roomId:'fixture-room',gamePlayer:0},store});assert.equal(client.hasUnresolvedCommands,false);pending=true;assert.equal(client.hasUnresolvedCommands,true);
});

test('lobby timing forwards authoritative countdown and rejects a different room or malformed seconds',async()=>{
 let value:Record<string,unknown>={roomId:'countdown-room',player:0,status:'starting',secondsRemaining:123};
 const gateway=new ProtocolPlayerGateway({id:'countdown',serverUrl:'http://127.0.0.1:1',roomId:'countdown-room',lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'TEST',lobbyConnection:true,settings:{model:'',personality:'schemer'}},'synthetic',new MemoryProtocolClientStore(),{fetch:async()=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}})});
 try{
  assert.deepEqual(await gateway.lobbyPhase(),{status:'starting',secondsRemaining:123});
  value={...value,status:'waiting'};assert.deepEqual(await gateway.lobbyPhase(),{status:'waiting'});
  value={...value,status:'starting',secondsRemaining:-1};await assert.rejects(gateway.lobbyPhase(),/Invalid lobby countdown/);
  value={...value,roomId:'another-room',secondsRemaining:100};await assert.rejects(gateway.lobbyPhase(),/Invalid lobby timing identity/);
 }finally{gateway.close();}
});
