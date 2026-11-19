import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {OutboxEntry} from '../packages/player-sdk/src/index.js';
import {resolveWriteOutbox} from '../packages/ai/src/controller/execution/write-reconciliation.js';
import {GameTransportError} from '../packages/ai/src/controller/transport/gateway.js';

const scope={serverId:'server',roomId:'room',roomEpoch:'epoch',playerId:'player'};
const key=(kind:string,id:string)=>createHash('sha256').update(JSON.stringify([kind,id])).digest('hex');
function entry(kind:'order'|'schedule'|'chat-send'|'cancel-schedule',id:string):OutboxEntry{
 const identity=key(kind,id);
 return {scope,request:{kind,roomEpoch:'epoch',sessionId:'s',fence:'1',authorizationVersion:'1',idempotencyKey:identity,clientCommandId:identity,expectedRevision:'r',instructionsVersion:'0',payload:{}},intentDigest:'digest',attempts:1,state:'settled',reason:null,
  receipt:{scope,commandId:'command',idempotencyKey:identity,clientCommandId:identity,intentDigest:'digest',state:kind==='schedule'?'scheduled':'applied',receiptVersion:'2',effectCommitted:true,createdAt:'2026-10-22T00:00:00Z',updatedAt:'2026-10-22T00:00:01Z',effects:{orderId:'actual-order'}}};
}
const resolve=(request:Parameters<typeof resolveWriteOutbox>[0],entries:OutboxEntry[])=>resolveWriteOutbox(request,entries,'room','epoch','player',0);

test('protocol unresolved-outbox and accepted-pending errors explain their actual stop boundary',()=>{
 const message=(failure:string)=>new GameTransportError({requestId:'request',method:'POST',path:'/player/v2/control/acquire',origin:'https://example.test',timeoutMs:15000,elapsedMs:0,stage:'http-response',failure,outcome:'rejected'}).displayReason;
 assert.match(message('UNRESOLVED_OUTBOX'),/未核实.*未取得写入控制权/);
 assert.match(message('COMMAND_PENDING'),/已接收.*仍在处理/);
 assert.match(message('COMMAND_EFFECT_UNCONFIRMED'),/尚未确认操作效果/);
});

test('read-only reconciliation matches precise request kind and identity for each write',()=>{
 for(const [request,transport] of [
  [{id:'a',tool:'order',arguments:{action:{kind:'check-in'}}},entry('order','a')],
  [{id:'c',tool:'say',arguments:{text:'hello'}},entry('chat-send','c')],
 ] as const){
  const before=structuredClone(transport),result=resolve(request,[transport]);
  assert.equal(result.status,'committed');assert.equal(result.protocolReceiptPlayer,0);
  assert.deepEqual(transport,before);
 }
});

test('different scope, kind, duplicate match and missing identity cannot resolve a write',()=>{
 const request={id:'a',tool:'order'};
 assert.equal(resolve(request,[entry('schedule','a')]).status,'unknown');
 assert.equal(resolve(request,[{...entry('order','a'),scope:{...scope,roomEpoch:'other'}}]).status,'unknown');
 assert.equal(resolve(request,[{...entry('order','a'),scope:{...scope,playerId:'other'}}]).status,'unknown');
 assert.equal(resolve(request,[entry('order','a'),entry('order','a')]).status,'unknown');
 assert.equal(resolve({id:'a',tool:'cancelSchedule',arguments:{id:'schedule'}},[entry('cancel-schedule','schedule:r')]).status,'unknown');
});

test('reconciled speech preserves actual transport text, recipients and authoritative message identity',()=>{
 const transport=entry('chat-send','message');transport.request.payload={to:[1,2],text:'Expanded TRITON actual message'};transport.receipt!.effects={messageId:'server-message'};
 const result=resolve({id:'message',tool:'say',arguments:{to:[1,2],text:'original reference'}},[transport]);
 assert.equal(result.status,'committed');
 assert.deepEqual(result.message,{id:'server-message',to:[1,2],text:'Expanded TRITON actual message',acceptedAtUtc:transport.receipt!.updatedAt});
});

test('absence is conclusive only after SDK verifies retired authority or no dispatch',()=>{
 const request={id:'a',tool:'order'},original=entry('order','a');
 for(const reason of ['absent-after-authority-retired','never-dispatched'])assert.equal(resolve(request,[{...original,receipt:null,reason}]).status,'not-executed');
 for(const reason of ['absent-with-original-authority-unresolved','ledger-history-unavailable',null])assert.equal(resolve(request,[{...original,receipt:null,reason}]).status,'unknown');
 const pending=entry('order','a');pending.receipt!.state='accepted';pending.receipt!.effectCommitted=false;
 assert.equal(resolve(request,[pending]).status,'unknown');
 pending.receipt!.state='rejected';assert.equal(resolve(request,[pending]).status,'rejected');
});
