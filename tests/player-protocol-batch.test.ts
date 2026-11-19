import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {protocolHarness,createOwnerProtocolHost} from './player-protocol-test-helpers.js';
import {createPlayerProtocolApi,type PlayerProtocolHost} from '../packages/server/src/player-protocol-api.js';
import {PlayerProtocolClient,MemoryProtocolClientStore,FileProtocolClientStore} from '../packages/player-sdk/src/index.js';
import {join} from 'node:path';
import {recoverBatchOutcome} from '../packages/ai/src/controller/execution/batch-recovery.js';
import {ProtocolPlayerGateway} from '../packages/ai/src/controller/transport/protocol-gateway.js';
import {BatchTransportError} from '../packages/ai/src/controller/execution/batch-outcome.js';
import {resolveWriteOutbox} from '../packages/ai/src/controller/execution/write-reconciliation.js';
import {parseProtocolCommand,type PlayerObservation,type ProtocolCommandRequest} from '../packages/contracts/src/index.js';
import {applyCoordinatedOrder} from '../packages/server/src/player-commands.js';
import {executeTool} from '../packages/ai/src/controller/execution/tools.js';
import {initialState} from '../packages/ai/src/controller/contracts/types.js';

const key=(kind:string,id:string)=>createHash('sha256').update(JSON.stringify([kind,id])).digest('hex');
const shield=(enabled=false)=>({kind:'set-shields',outpostId:'蓝方工厂',enabled});
async function fixture(t:TestContext,options:{fetcher?:typeof fetch;hook?:(host:PlayerProtocolHost,h:ReturnType<typeof protocolHarness>)=>Promise<void>}={}){
 const h=protocolHarness(t);h.elapsed+=31000;
 const grant=h.grant(0,['observe','events.read','commands.write','control.lease','chat.send','commander.worker']),host=await createOwnerProtocolHost(h);
 if(options.hook)host.afterAdmission=async()=>options.hook!(host,h);
 const server=createPlayerProtocolApi(host),requests:string[]=[];server.on('request',req=>requests.push(`${req.method} ${req.url}`));server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address() as {port:number},url=`http://127.0.0.1:${address.port}`,store=new MemoryProtocolClientStore();
 const client=new PlayerProtocolClient({serverUrl:url,token:grant.token,store,expectedIdentity:{roomId:h.roomId,gamePlayer:0},optionalCapabilities:['actions.batch/1','actions.order/1'],...options.fetcher?{fetch:options.fetcher}:{}});
 const gatewayStore=new MemoryProtocolClientStore(),gateway=new ProtocolPlayerGateway({id:'seat',serverUrl:url,roomId:h.roomId,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'TEST',settings:{model:'',personality:'schemer'}},grant.token,gatewayStore,options.fetcher?{fetch:options.fetcher}:{});
 t.after(async()=>{gateway.close();client.pause();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const batch=async(actions:Record<string,unknown>[],id='batch')=>{const view=(await client.snapshot()).observation as PlayerObservation;return {idempotencyKey:key('batch',id),clientCommandId:key('batch',id),expectedRevision:view.revision,instructionsVersion:'0',commands:actions.map((action,i)=>({idempotencyKey:key('order',`${id}-item-${i}`),clientCommandId:key('order',`${id}-item-${i}`),expectedRevision:view.revision,instructionsVersion:'0',payload:{action}}))};};
 return {h,host,grant,client,gateway,gatewayStore,batch,requests,url};
}

test('ordered batch persists independent receipts, returns one final snapshot, and replays without duplicate effects',async t=>{
 const x=await fixture(t);await x.client.acquire();const intent=await x.batch([shield(false),shield(true)]),at=x.requests.length;
 const result=await x.client.commandBatch(intent);assert.equal(result.receipt.state,'applied');
 assert.deepEqual(result.receipt.effects!.batchReceipts!.map(r=>r.state),['applied','applied']);assert.equal(x.h.store.load()!.room.state.commands.length,2);
 assert.equal(x.requests.slice(at).filter(r=>r==='GET /player/v2/snapshot').length,0,'the final snapshot first page travels with the batch response');
 assert.equal((result.snapshot.observation as PlayerObservation).view.outposts.find(p=>p.id==='蓝方工厂')!.shieldsEnabled,true);
 assert.deepEqual((await x.client.commandBatch(intent)).receipt,result.receipt);assert.equal(x.h.store.load()!.room.state.commands.length,2);
 await assert.rejects(x.client.commandBatch({...intent,commands:[{...intent.commands[0]!,payload:{action:shield(true)}},intent.commands[1]!]}),/IDEMPOTENCY_CONFLICT/);
 assert.deepEqual(x.h.repository.lookup(x.grant.principal,result.receipt.scope.roomEpoch,intent.commands.map(c=>c.idempotencyKey)).map(r=>r.status),['found','found']);
});

test('a rejected item preserves the accepted prefix and durably identifies untouched suffix items',async t=>{
 const x=await fixture(t);await x.client.acquire();const result=await x.client.commandBatch(await x.batch([shield(),{kind:'set-shields',outpostId:'不存在',enabled:false},shield(true)]));
 const children=result.receipt.effects!.batchReceipts!;assert.deepEqual(children.map(r=>r.state),['applied','rejected','rejected']);assert.equal(children[2]!.code,'BATCH_NOT_EXECUTED');
 assert.equal(x.h.store.load()!.room.state.commands.length,1);assert.equal(result.snapshot.observation!==undefined,true);
});

test('a lost committed batch response reconciles each original child without sending gameplay again',async t=>{
 const x=await fixture(t,{fetcher:async(input,init)=>{const r=await fetch(input,init);if(String(input).endsWith('/commands/batch')){await r.arrayBuffer();throw Error('synthetic dropped response');}return r;}});
 await x.gateway.acquire();const view=(await x.gateway.snapshot(0,0)).observation;
 await assert.rejects(x.gateway.orderBatch('lost',[shield(),{kind:'set-shields',outpostId:'不存在',enabled:false},shield(true)],view.revision),BatchTransportError);
 const writes=x.requests.filter(r=>r==='POST /player/v2/commands/batch').length,entries=await x.gateway.client.reconcile({retryAbsent:false}),hello=x.gateway.client.hello!;
 const resolutions=[0,1,2].map(i=>resolveWriteOutbox({id:`lost-item-${i}`,tool:'order'},entries,hello.scope.roomId,hello.scope.roomEpoch,hello.scope.playerId,0));
 assert.deepEqual(resolutions.map(r=>r.status),['committed','rejected','not-executed']);assert.equal(x.requests.filter(r=>r==='POST /player/v2/commands/batch').length,writes);assert.equal(x.h.store.load()!.room.state.commands.length,1);
});

test('a failed snapshot followup retains successful child receipts',async t=>{
 let fail=false;const x=await fixture(t,{fetcher:async(input,init)=>{if(fail&&String(input).includes('/snapshot/')&&String(input).endsWith('/complete'))throw Error('synthetic followup failure');return fetch(input,init);}});
 await x.gateway.acquire();const view=(await x.gateway.snapshot(0,0)).observation;fail=true;
 await assert.rejects(x.gateway.orderBatch('followup',[shield(),shield(true)],view.revision),error=>error instanceof BatchTransportError&&error.outcome.results.every(r=>r.status==='accepted'));
 assert.equal(x.h.store.load()!.room.state.commands.length,2);
});

test('tampered child receipts are rejected and later recovered from authoritative lookup',async t=>{
 const x=await fixture(t,{fetcher:async(input,init)=>{const r=await fetch(input,init);if(!String(input).endsWith('/commands/batch'))return r;const value=await r.json();value.receipt.effects.batchReceipts[0].idempotencyKey='wrong-child';return Response.json(value);}});
 await x.gateway.acquire();const view=(await x.gateway.snapshot(0,0)).observation;
 await assert.rejects(x.gateway.orderBatch('tampered',[shield()],view.revision),error=>error instanceof BatchTransportError&&error.outcome.results[0]!.status==='unknown');
 const entries=await x.gateway.client.reconcile({retryAbsent:false}),hello=x.gateway.client.hello!;
 assert.equal(resolveWriteOutbox({id:'tampered-item-0',tool:'order'},entries,hello.scope.roomId,hello.scope.roomEpoch,hello.scope.playerId,0).status,'committed');assert.equal(x.h.store.load()!.room.state.commands.length,1);
});

test('a manual command between admission and settlement invalidates the original batch basis',async t=>{
 const x=await fixture(t,{hook:async(host,h)=>{const current=h.store.load()!,room=applyCoordinatedOrder(current.room,{id:'manual-between',player:0,action:shield(false) as never},'manual');host.commit(room,current.revision);}});
 await x.client.acquire();const result=await x.client.commandBatch(await x.batch([shield(),shield(true)]));
 assert.equal(result.receipt.state,'rejected');assert.equal(result.receipt.code,'REVISION_CONFLICT');assert.equal(x.h.store.load()!.room.state.commands.length,1);assert.equal(x.h.store.load()!.room.state.commands[0]!.id,'manual-between');
});

test('a confirmed instruction change between admission and settlement prevents all batch effects',async t=>{
 let version='0';const x=await fixture(t,{hook:async()=>{version='1';}});x.host.instructionsVersion=()=>version;
 await x.client.acquire();const result=await x.client.commandBatch(await x.batch([shield()]));assert.equal(result.receipt.state,'rejected');assert.equal(result.receipt.code,'INSTRUCTIONS_CHANGED');assert.equal(x.h.store.load()!.room.state.commands.length,0);
});

test('batch prevalidation and audit preserve the same child identities as the sequential executor',async t=>{
 const x=await fixture(t);await x.gateway.acquire();const snapshot=await x.gateway.snapshot(0,0),events:{kind:string;data:Record<string,unknown>}[]=[];let guarded=false;
 const result=await executeTool('batch',{actions:[{tool:'order',arguments:{action:shield()}},{tool:'order',arguments:{action:shield(true)}}]}, {state:initialState(x.h.roomId,0,{model:'',personality:'schemer'}),snapshot,gateway:x.gateway,id:'audit',spoken:0,now:0,batchPrevalidated:true,beforeEffect:tool=>{assert.equal(tool,'batch');guarded=true;},audit:(kind,data)=>events.push({kind,data:data as Record<string,unknown>})}) as {complete:boolean};
 assert.equal(guarded,true);assert.equal(result.complete,true);assert.deepEqual(events.filter(e=>e.kind==='batch-item-result').map(e=>e.data.id),['audit-item-0','audit-item-1']);assert.equal(x.requests.filter(r=>r==='POST /player/v2/commands/batch').length,1);assert.equal(x.requests.filter(r=>r==='POST /player/v2/commands').length,0);
});

test('parser rejects nested batches, different authority, duplicate keys, and oversized batches before execution',()=>{
 const base:ProtocolCommandRequest={roomEpoch:'e',sessionId:'s',fence:'1',authorizationVersion:'1',idempotencyKey:'parent',clientCommandId:'parent',expectedRevision:'a'.repeat(64),instructionsVersion:'0',kind:'order-batch',payload:{}};
 const child={...base,kind:'order',idempotencyKey:'child',clientCommandId:'child',payload:{action:shield()}};
 for(const commands of [[{...child,kind:'order-batch'}],[{...child,fence:'2'}],[child,child],Array(9).fill(child)])assert.throws(()=>parseProtocolCommand({...base,payload:{commands}}));
 const input={...base,payload:{commands:[child]}};const before=structuredClone(input);assert.deepEqual(parseProtocolCommand(input),input);assert.deepEqual(input,before);
});

test('manual takeover after batch admission prevents all child effects',async t=>{
 const x=await fixture(t,{hook:async(_host,h)=>{h.repository.ownerControl(h.roomId,0,{action:'takeover',mode:'manual'});}});
 await x.client.acquire();const result=await x.client.commandBatch(await x.batch([shield(),shield(true)]));
 assert.equal(result.receipt.state,'rejected');assert.equal(result.receipt.effectCommitted,false);assert.equal(x.h.store.load()!.room.state.commands.length,0);
});

test('an observation racing a batch waits for the final snapshot without replacing newer facts',async t=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});
 const x=await fixture(t,{fetcher:async(input,init)=>{if(String(input).endsWith('/commands/batch')){entered();await hold;}return fetch(input,init);}});
 await x.gateway.acquire();const view=(await x.gateway.snapshot(0,0)).observation;
 const task=x.gateway.orderBatch('race',[shield()],view.revision);await started;
 let observed=false;const read=x.gateway.snapshot(0,0).then(s=>{observed=true;return s;});await new Promise(r=>setImmediate(r));assert.equal(observed,false);
 release();const result=await task,after=await read;assert.equal(after.observation.revision,result.observation.revision);assert.notEqual(after.observation.revision,view.revision);
});

test('remote turn reads use local state until synchronization installs manual and notification changes',async t=>{
 const x=await fixture(t);await x.gateway.acquire();const first=await x.gateway.snapshot(0,0),count=()=>x.requests.filter(r=>r.startsWith('GET /player/v2/sync?')).length,initial=count();
 first.observation.view.outposts.length=0;await x.gateway.snapshot(0,0);const again=await x.gateway.snapshot(0,0);assert.equal(count(),initial);assert.ok(again.observation.view.outposts.length>0);
 const current=x.h.store.load()!,room=applyCoordinatedOrder(current.room,{id:'manual-cache-change',player:0,action:shield() as never},'manual');x.host.commit(room,current.revision);
 await x.gateway.waitForChange();const changed=await x.gateway.snapshot(0,0);assert.notEqual(changed.observation.revision,first.observation.revision);assert.equal(count(),initial+1);
 x.h.repository.domainEvent(x.h.roomId,0,'notifications.changed',{},true);await x.gateway.waitForChange();await x.gateway.snapshot(0,0);assert.equal(count(),initial+2);
});

test('real-time foreground reads use the synchronized local cut too',async t=>{
 const x=await fixture(t),original=x.host.snapshot!;x.host.snapshot=player=>{const data=original(player);return {...data,observation:{...(data.observation as PlayerObservation),realtime:true}};};
 await x.gateway.acquire();await x.gateway.snapshot(0,0);const count=x.requests.filter(r=>r==='GET /player/v2/snapshot').length;await x.gateway.snapshot(0,0);await x.gateway.snapshot(0,0);assert.equal(x.requests.filter(r=>r==='GET /player/v2/snapshot').length,count);
});

test('an unresolved write permits local reads while continuing to fence gameplay writes',async t=>{
 const x=await fixture(t);await x.gateway.acquire();await x.gateway.snapshot(0,0);const count=x.requests.filter(r=>r==='GET /player/v2/snapshot').length;
 const hello=x.gateway.client.hello!,request=x.h.command('synthetic-unsent',{sessionId:hello.sessionId});
 x.gatewayStore.transaction(state=>{state.outbox.synthetic={scope:hello.scope,request,intentDigest:'a'.repeat(64),attempts:1,state:'unknown',receipt:null,reason:null};});
 const before=x.requests.length;await x.gateway.snapshot(0,0);assert.equal(x.requests.length,before);assert.equal(x.gateway.writable,false);assert.equal(x.gateway.client.hasUnresolvedCommands,true);await assert.rejects(x.gateway.request('/tool/order',{revision:(await x.gateway.snapshot(0,0)).observation.revision,order:{id:'must-stay-fenced',action:shield()}}),/agent-write-blocked/);assert.equal(x.h.store.load()!.room.state.commands.length,0);
});

test('the same two-order workload uses one batch write and eliminates per-child snapshot downloads',async t=>{
 const x=await fixture(t);await x.gateway.acquire();let snapshot=await x.gateway.snapshot(0,0);
 const context={state:initialState(x.h.roomId,0,{model:'',personality:'schemer'}),snapshot,id:'roundtrips-batch',spoken:0,now:0,batchPrevalidated:true};
 const actions=[{tool:'order',arguments:{action:shield()}},{tool:'order',arguments:{action:shield(true)}}],before=x.requests.length;
 const batch=await executeTool('batch',{actions},{...context,gateway:x.gateway}) as {observation:PlayerObservation};const batched=x.requests.slice(before);
 snapshot={...snapshot,observation:batch.observation};const start=x.requests.length;
 await executeTool('batch',{actions},{...context,snapshot,id:'roundtrips-sequential',gateway:{snapshot:x.gateway.snapshot.bind(x.gateway),request:x.gateway.request.bind(x.gateway)}});const sequential=x.requests.slice(start);
 assert.equal(batched.filter(r=>r==='POST /player/v2/commands/batch').length,1);assert.equal(sequential.filter(r=>r==='POST /player/v2/commands').length,2);
 assert.equal(batched.filter(r=>r==='GET /player/v2/snapshot').length,0);assert.equal(sequential.filter(r=>r==='GET /player/v2/snapshot').length,0);assert.equal(sequential.filter(r=>r.startsWith('GET /player/v2/sync?')).length,2);assert.ok(batched.length<sequential.length);
});

test('persistent transport recovery reconstructs lost child outcomes after a new client process',async t=>{
 const x=await fixture(t,{fetcher:async(input,init)=>{const r=await fetch(input,init);if(String(input).endsWith('/commands/batch')){await r.arrayBuffer();throw Error('dropped before local receipt');}return r;}});
 await x.gateway.acquire();const view=(await x.gateway.snapshot(0,0)).observation;
 await assert.rejects(x.gateway.orderBatch('disk',[shield(),shield(true)],view.revision),BatchTransportError);
 const store=new FileProtocolClientStore(join(x.h.dir,'restart-transport.json'));store.transaction(s=>Object.assign(s,x.gatewayStore.load()));
 const restored=new PlayerProtocolClient({serverUrl:x.url,token:x.grant.token,store:new FileProtocolClientStore(join(x.h.dir,'restart-transport.json')),expectedIdentity:{roomId:x.h.roomId,gamePlayer:0}});
 const entries=await restored.reconcile({retryAbsent:false}),hello=restored.hello!;
 assert.deepEqual([0,1].map(i=>resolveWriteOutbox({id:`disk-item-${i}`,tool:'order'},entries,hello.scope.roomId,hello.scope.roomEpoch,hello.scope.playerId,0).status),['committed','committed']);
 assert.equal(x.h.store.load()!.room.state.commands.length,2);assert.equal(x.requests.filter(r=>r==='POST /player/v2/commands/batch').length,1);
});

test('crash recovery retains an explicit untouched child instead of relabelling it unknown',()=>{
 const actions=[0,1].map(()=>({tool:'order',arguments:{action:shield()}}));
 const outcome=recoverBatchOutcome('batch',{actions},[{id:'batch-item-0',intentRecorded:true,evidence:{kind:'batch-item-result',result:{status:'rejected'}}},{id:'batch-item-1',intentRecorded:true,evidence:{kind:'batch-item-result',result:{status:'not-executed',reason:'BATCH_NOT_EXECUTED'}}}],[]);
 assert.deepEqual(outcome.results.map(r=>r.status),['rejected','not-executed']);assert.equal(outcome.status,'partial');
});

test('an unnegotiated batch capability is rejected before any game effect',async t=>{
 const x=await fixture(t),child=x.h.command('not-negotiated-child'),parent=x.h.command('not-negotiated-parent',{kind:'order-batch',payload:{commands:[child]}});
 const response=await fetch(x.url+'/player/v2/commands/batch',{method:'POST',headers:{Authorization:'Bearer '+x.h.first.token,'Content-Type':'application/json'},body:JSON.stringify(parent)});
 assert.equal(response.status,409);assert.equal((await response.json()).code,'UNSUPPORTED_OPERATION');assert.equal(x.h.store.load()!.room.state.commands.length,0);
});

test('a server without negotiated batch support retains the guarded sequential path',async t=>{
 const x=await fixture(t,{fetcher:async(input,init)=>{const r=await fetch(input,init);if(!String(input).endsWith('/sessions/hello'))return r;const value=await r.json();value.capabilities=value.capabilities.filter((c:string)=>c!=='actions.batch/1');return Response.json(value);}});
 await x.gateway.acquire();assert.equal(x.gateway.batchAvailable,false);const snapshot=await x.gateway.snapshot(0,0);
 const result=await executeTool('batch',{actions:[{tool:'order',arguments:{action:shield()}},{tool:'order',arguments:{action:shield(true)}}]}, {state:initialState(x.h.roomId,0,{model:'',personality:'schemer'}),snapshot,gateway:x.gateway,id:'legacy',spoken:0,now:0,batchPrevalidated:true}) as {complete:boolean};
 assert.equal(result.complete,true);assert.equal(x.requests.filter(r=>r==='POST /player/v2/commands').length,2);assert.equal(x.requests.filter(r=>r==='POST /player/v2/commands/batch').length,0);
});

test('a storage fault rolls back uncommitted children and restart retires the accepted parent',async t=>{
 const x=await fixture(t),commit=x.host.commit;let writes=0;x.host.commit=(room,revision)=>{if(++writes===2)throw Error('synthetic disk fault');return commit(room,revision);};
 await x.client.acquire();const intent=await x.batch([shield(),shield(true)],'fault');await assert.rejects(x.client.commandBatch(intent),/STORAGE_UNAVAILABLE/);
 assert.equal(x.h.store.load()!.room.state.commands.length,0);assert.equal(x.h.repository.lookup(x.grant.principal,x.h.authority.roomEpoch,[intent.idempotencyKey])[0]!.status,'found');
 x.h.restart();const principal=x.h.repository.authenticate('Bearer '+x.grant.token),found=x.h.repository.lookup(principal,principal.roomEpoch,[intent.idempotencyKey])[0]!;
 assert.equal(found.status,'found');if(found.status==='found')assert.equal(found.receipt.state,'rejected');assert.equal(x.h.store.load()!.room.state.commands.length,0);
});

test('an uncommitted parent cannot smuggle successful child receipts into action history',async t=>{
 const x=await fixture(t,{fetcher:async(input,init)=>{const r=await fetch(input,init);if(!String(input).endsWith('/commands/batch'))return r;const value=await r.json();value.receipt.state='rejected';value.receipt.effectCommitted=false;value.receipt.code='REVISION_CONFLICT';return Response.json(value);}});
 await x.gateway.acquire();const view=(await x.gateway.snapshot(0,0)).observation;
 await assert.rejects(x.gateway.orderBatch('contradictory',[shield()],view.revision),error=>error instanceof BatchTransportError&&error.outcome.results[0]!.status==='unknown');
 const entries=await x.gateway.client.reconcile({retryAbsent:false}),hello=x.gateway.client.hello!;
 assert.equal(resolveWriteOutbox({id:'contradictory-item-0',tool:'order'},entries,hello.scope.roomId,hello.scope.roomEpoch,hello.scope.playerId,0).status,'committed');assert.equal(x.h.store.load()!.room.state.commands.length,1);
});

test('realtime lobby countdown accepts usable stale single and batch orders before the clock starts',async t=>{
 const x=await fixture(t),load=x.host.load;
 x.host.load=()=>{const saved=load();return {...saved,room:{...saved.room,timing:{mode:'realtime' as const,tickSeconds:5}}};};
 await x.client.acquire();
 const before=(await x.client.snapshot()).observation as PlayerObservation;
 assert.equal(before.realtime,false);
 const {commands,...singleIntent}=await x.batch([shield(false)],'countdown-single');
 const command={...singleIntent,kind:'order' as const,payload:{action:shield(false)},expectedRevision:'0'.repeat(64)};
 const single=await x.client.command(command);assert.equal(single.state,'applied');
 const intent=await x.batch([shield(true),shield(false)],'countdown-batch');intent.expectedRevision='0'.repeat(64);for(const child of intent.commands)child.expectedRevision='0'.repeat(64);
 const batch=await x.client.commandBatch(intent);assert.deepEqual(batch.receipt.effects!.batchReceipts!.map(r=>r.state),['applied','applied']);
});
