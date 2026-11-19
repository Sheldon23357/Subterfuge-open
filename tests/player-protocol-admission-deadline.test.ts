import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PLAYER_PROTOCOL_LIMITS,type ProtocolCommanderRequest} from '../packages/contracts/src/index.js';
import {protocolHarness} from './player-protocol-test-helpers.js';

function found(h:ReturnType<typeof protocolHarness>,key:string){const result=h.repository.lookup(h.first.principal,h.authority.roomEpoch,[key])[0]!;assert.equal(result.status,'found');if(result.status!=='found')throw Error('Expected authoritative receipt');return result.receipt;}

test('B4 L02 takeover terminates effect-free accepted work without another settle and late settle returns that exact terminal',t=>{
 const h=protocolHarness(t),request=h.command('takeover-pending'),accepted=h.repository.acceptCommand(h.first.principal,request),before=h.repository.stream(h.first.principal);
 h.repository.ownerControl('fixture-room',0,{action:'takeover',mode:'manual'});
 const terminal=found(h,request.idempotencyKey);assert.equal(terminal.state,'rejected');assert.equal(terminal.effectCommitted,false);assert.equal(terminal.code,'FENCE_STALE');assert.equal(terminal.receiptVersion,'2');
 assert.deepEqual(h.repository.settleCommand(h.first.principal,accepted.commandId,()=>{throw Error('Late original request must not execute');}),terminal);
 const events=h.repository.events(h.first.principal,before.cursor,100).events.filter(event=>event.type==='command.status.changed');assert.equal(events.length,1);assert.deepEqual(events[0]!.payload.receipt,terminal);assert.equal(h.store.load()!.room.state.commands.length,0);
});

test('B4 lease expiry reaches a no-effect terminal through lookup alone before the fixed admission deadline',t=>{
 const h=protocolHarness(t);h.repository.controlOperation(h.first.principal,'renew',{roomEpoch:h.authority.roomEpoch,sessionId:h.session,fence:h.lease.generation,idempotencyKey:'short-lease',ttlMs:1000});const accepted=h.repository.acceptCommand(h.first.principal,h.command('expired-lease'));h.elapsed+=1000;
 const result=h.repository.receipt(h.first.principal,accepted.commandId);assert.equal(result.state,'rejected');assert.equal(result.code,'LEASE_LOST');assert.equal(result.effectCommitted,false);assert.equal(result.receiptVersion,'2');assert.equal(h.store.load()!.room.state.commands.length,0);
});

test('B4 C07 continuing renewal, request retries and lookup cannot extend the persisted accepted deadline',t=>{
 const h=protocolHarness(t),request=h.command('renewed-pending'),accepted=h.repository.acceptCommand(h.first.principal,request),admittedAt=h.elapsed;
 for(let i=1;i<=3;i++){h.elapsed=admittedAt+i*9000;h.wall-=1_000_000;h.repository.controlOperation(h.first.principal,'renew',{roomEpoch:h.authority.roomEpoch,sessionId:h.session,fence:h.lease.generation,idempotencyKey:'renew-'+i,ttlMs:120000});assert.equal(found(h,request.idempotencyKey).state,'accepted');assert.deepEqual(h.repository.acceptCommand(h.first.principal,request),accepted);}
 h.elapsed=admittedAt+PLAYER_PROTOCOL_LIMITS.acceptedCommandMs;const terminal=found(h,request.idempotencyKey);assert.equal(terminal.state,'rejected');assert.equal(terminal.code,'COMMAND_EXPIRED');assert.equal(terminal.effectCommitted,false);assert.equal(terminal.receiptVersion,'2');assert.equal(h.repository.control(h.first.principal,h.session).mode,'agent');assert.deepEqual(h.repository.settleCommand(h.first.principal,accepted.commandId,()=>{throw Error('Expired work must never execute');}),terminal);assert.equal(h.store.load()!.room.state.commands.length,0);
});

test('B4 calculation crossing the fixed accepted deadline rolls back its tentative world and emits only one no-effect terminal',t=>{
 const h=protocolHarness(t);h.repository.controlOperation(h.first.principal,'renew',{roomEpoch:h.authority.roomEpoch,sessionId:h.session,fence:h.lease.generation,idempotencyKey:'long-lease',ttlMs:120000});const request=h.command('slow-calculation'),accepted=h.repository.acceptCommand(h.first.principal,request),before=h.store.load(),cursor=h.repository.stream(h.first.principal).cursor;
 const result=h.repository.settleCommand(h.first.principal,accepted.commandId,r=>{const effect=h.apply(r);h.elapsed+=PLAYER_PROTOCOL_LIMITS.acceptedCommandMs;return effect;});assert.equal(result.code,'COMMAND_EXPIRED');assert.equal(result.state,'rejected');assert.equal(result.effectCommitted,false);assert.deepEqual(h.store.load(),before);const events=h.repository.events(h.first.principal,cursor,100).events.filter(event=>event.type==='command.status.changed');assert.equal(events.length,1);assert.deepEqual(events[0]!.payload.receipt,result);
});

test('B4 revocation retires independent worker admissions without a gameplay lease or another execution attempt',t=>{
 const h=protocolHarness(t),worker=h.grant(0,['observe','commander.worker']),sessionId=h.repository.createSession(worker.principal,'worker-only',['core/2']),request:ProtocolCommanderRequest={roomEpoch:h.authority.roomEpoch,sessionId,authorizationVersion:'1',instructionsVersion:'0',idempotencyKey:'worker-revocation',clientCommandId:'worker-revocation',kind:'commander-worker',payload:{action:'reply',messageId:'fixture',text:'test-only'}};
 const accepted=h.repository.acceptCommand(worker.principal,request);h.repository.revokeGrant(worker.principal.grantId);const terminal=h.repository.receipt(h.first.principal,accepted.commandId);assert.equal(terminal.state,'rejected');assert.equal(terminal.code,'UNAUTHORIZED');assert.equal(terminal.effectCommitted,false);assert.deepEqual(h.repository.settleCommand(worker.principal,accepted.commandId,()=>{throw Error('Revoked admitted worker must not execute');}),terminal);assert.throws(()=>h.repository.receipt(worker.principal,accepted.commandId),/authorization changed/i);assert.equal(h.repository.control(h.first.principal,h.session).mode,'agent');
});

test('B4 expiration of an accepted deadline cannot retire an already committed schedule, which still fires once',async t=>{
 const {advanceRoom}=await import('../packages/server/src/planning.js');const h=protocolHarness(t),tick=h.store.load()!.room.state.economy.tick+1,request=h.command('scheduled-before-expiry',{kind:'schedule',payload:{action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false},issueTick:tick}}),accepted=h.repository.acceptCommand(h.first.principal,request),scheduled=h.repository.settleCommand(h.first.principal,accepted.commandId,r=>h.apply(r));assert.equal(scheduled.state,'scheduled');h.elapsed+=PLAYER_PROTOCOL_LIMITS.acceptedCommandMs+1;h.repository.ownerControl('fixture-room',0,{action:'takeover',mode:'manual'});assert.deepEqual(found(h,request.idempotencyKey),scheduled);
 const current=h.store.load()!,next=advanceRoom(current.room,tick);h.repository.atomic(()=>{h.store.commit(next,current.revision);h.repository.updateScheduleReceipts('fixture-room',[...next.scheduled,...(next.scheduledOrders??[])]);});const terminal=h.repository.receipt(h.first.principal,accepted.commandId);assert.equal(terminal.scheduleOutcome,'fired');assert.equal(terminal.effectCommitted,true);assert.equal(terminal.receiptVersion,'3');assert.equal(next.state.commands.filter(command=>command.id===terminal.effects?.orderId).length,1);
});

test('B4 takeover retirement, receipt version and event all roll back when their outer storage transaction fails',t=>{
 const h=protocolHarness(t),accepted=h.repository.acceptCommand(h.first.principal,h.command('rollback-takeover')),before=h.repository.stream(h.first.principal);
 assert.throws(()=>h.repository.atomic(()=>{h.repository.ownerControl('fixture-room',0,{action:'takeover',mode:'manual'});throw Error('injected transaction failure');}),/injected/);assert.deepEqual(h.repository.receipt(h.first.principal,accepted.commandId),accepted);assert.deepEqual(h.repository.stream(h.first.principal),before);assert.equal(h.repository.control(h.first.principal,h.session).mode,'agent');
});

test('B4 C07 SDK keeps a storage-unknown admission until real HTTP lookup proves COMMAND_EXPIRED without resending',async t=>{
 const {sdkFixture}=await import('./player-sdk-test-helpers.js');let x!:Awaited<ReturnType<typeof sdkFixture>>,sends=0;
 x=await sdkFixture(t,{fetcher:async(input,init)=>{if(String(input).endsWith('/commands')){sends++;x.h.repository.acceptCommand(x.h.first.principal,JSON.parse(String(init!.body)));return Response.json({code:'STORAGE_UNAVAILABLE',category:'transient',outcome:'unknown',safeMessage:'Synthetic storage failure after durable admission',requestId:'fixture-storage-unknown'},{status:503});}return fetch(input,init);}});
 await x.client.acquire(120000);await assert.rejects(x.client.command(await x.intent('storage-unknown')));assert.equal(Object.values(x.client.state.outbox)[0]!.state,'unknown');assert.equal((await x.client.reconcile())[0]!.receipt!.state,'accepted');x.h.elapsed+=PLAYER_PROTOCOL_LIMITS.acceptedCommandMs;
 const recovered=(await x.client.reconcile())[0]!;assert.equal(recovered.state,'settled');assert.equal(recovered.receipt!.state,'rejected');assert.equal(recovered.receipt!.code,'COMMAND_EXPIRED');assert.equal(recovered.receipt!.effectCommitted,false);assert.equal(recovered.receipt!.receiptVersion,'2');assert.equal(sends,1);assert.equal(x.h.store.load()!.room.state.commands.length,0);assert.equal(x.client.writable,false);
});
