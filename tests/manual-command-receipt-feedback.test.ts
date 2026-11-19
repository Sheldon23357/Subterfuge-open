import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {playerOrder,applyCoordinatedOrder,applyCoordinatedCancellation} from '../packages/server/src/player-commands.js';
import {observation} from '../packages/server/src/player-api.js';
import type {LabRoom} from '../packages/server/src/planning.js';
import {playerManualCommandNotice} from '../packages/client/src/manual-command-feedback.js';
const cryptoProvider=webcrypto.subtle as unknown as SubtleCrypto;
function fixture():LabRoom{return {state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup),scheduled:[],playerRoomId:'receipt-fixture'};}
const action={kind:'set-shields',outpostId:'蓝方工厂',enabled:false};
const id='00112233-4455-6677-8899-aabbccddeeff';
function observed(room:LabRoom){return {...observation(room,0,'receipt-fixture'),outpostNames:{'蓝方工厂':'Avalon'}};}
test('player feedback matches the actual server-hashed order receipt, never a later concurrent manual receipt',async()=>{
 const room=fixture(),order=playerOrder({id,action},0,room);
 assert.match(order.id,/^p0-[a-f0-9]{64}$/);assert.notEqual(order.id,id);
 const committed=applyCoordinatedOrder(room,order,'manual');
 const later=playerOrder({id:'different-command',action:{...action,enabled:true}},0,committed);
 const afterConcurrent=applyCoordinatedOrder(committed,later,'manual'),next=observed(afterConcurrent);
 assert.equal(next.manualCommands!.receipts[0]!.orderId,order.id);
 const notice=await playerManualCommandNotice(next,{id,kind:'order'},cryptoProvider);
 assert.equal(notice,'Avalon · 调整护盾：已执行。');
 assert.equal(await playerManualCommandNotice(next,{id:'unknown',kind:'order'},cryptoProvider),null);
 // A replay uses the original key and still selects its receipt after another command has committed.
 const replay=applyCoordinatedOrder(afterConcurrent,playerOrder({id,action},0,afterConcurrent),'manual');
 assert.equal(replay.manualCoordination!.receipts.length,2);
 assert.equal(await playerManualCommandNotice(observed(replay),{id,kind:'order'},cryptoProvider),notice);
});
test('player feedback matches a real hashed schedule and preserves canonical cancellation IDs without hashing again',async()=>{
 const room=fixture(),issueTick=room.state.economy.tick+1,order=playerOrder({id,action},0,room),scheduled=applyCoordinatedOrder(room,order,'manual',0,issueTick);
 assert.equal(await playerManualCommandNotice(observed(scheduled),{id,kind:'order',issueTick},cryptoProvider),'Avalon · 调整护盾：已预约。手动安排优先，AI 不会直接覆盖。');
 const cancelled=applyCoordinatedCancellation(scheduled,order.id,0,'manual');
 const unavailable={digest:async()=>{throw Error('Cancellation must not hash canonical IDs');}} as unknown as SubtleCrypto;
 assert.equal(await playerManualCommandNotice(observed(cancelled),{id:order.id,kind:'cancel'},unavailable),'取消预约：已取消。手动安排优先，AI 不会直接覆盖。');
 assert.equal(await playerManualCommandNotice(observed(cancelled),{id,kind:'cancel'},cryptoProvider),null);
});
test('missing or rejected WebCrypto safely omits enriched notice after a real committed order',async()=>{
 const room=fixture(),committed=applyCoordinatedOrder(room,playerOrder({id,action},0,room),'manual'),next=observed(committed);
 assert.equal(await playerManualCommandNotice(next,{id,kind:'order'},null),null);
 const unavailable={digest:async()=>{throw Error('WebCrypto unavailable');}} as unknown as SubtleCrypto;
 assert.equal(await playerManualCommandNotice(next,{id,kind:'order'},unavailable),null);
 assert.equal(next.manualCommands!.receipts[0]!.outcome,'applied');
 const source=readFileSync('packages/client/src/player-main.tsx','utf8');
 assert.ok(source.includes('await playerManualCommandNotice(next,command)'));
 assert.ok(source.includes('setNotice(receiptNotice??message)'));
});
test('player receipt matching is seat-scoped even when another receipt carries the same textual ID',async()=>{
 const room=fixture(),committed=applyCoordinatedOrder(room,playerOrder({id,action},0,room),'manual'),next=observed(committed);
 next.manualCommands!.receipts=next.manualCommands!.receipts.map(row=>({...row,player:1}));
 assert.equal(await playerManualCommandNotice(next,{id,kind:'order'},cryptoProvider),null);
});
