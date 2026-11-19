import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {advanceRoom,saveRoom,restoreRoom,type LabRoom} from '../packages/server/src/planning.js';
import {applyCoordinatedOrder,applyCoordinatedCancellation} from '../packages/server/src/player-commands.js';
import * as coordination from '../packages/server/src/manual-commands.js';
import {manualCommandView,manualCommandVersion,manualReceiptPage,commandSource} from '../packages/server/src/manual-commands.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {PlayerControl} from '../packages/server/src/player-control.js';
// Static synthetic archive from the earlier feature candidate. It is decoded as
// history only; no current API or helper can create a release operation.
const archived=()=>fs.readFileSync('tests/fixtures/historical-manual-release.json','utf8');
const room=()=>restoreRoom(archived());
const shields=(r:LabRoom,id:string,enabled:boolean,source:'manual'|'agent'='manual')=>applyCoordinatedOrder(r,{id,player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled}},source);

test('archived release facts roundtrip without advertising or exporting a handback operation',()=>{
 const r=room(),view=manualCommandView(r,0),fact=view.receipts.at(-1)!;
 assert.equal('releaseSupported' in view,false);assert.equal('releaseManualProtections' in coordination,false);assert.equal('manualReleaseReceipt' in coordination,false);
 assert.equal(view.version,3);assert.equal(fact.kind,'release-protection');assert.equal(fact.outcome,'released');assert.deepEqual(fact.releasedReceiptIds,['manual:0:1']);
 assert.deepEqual(fact.releasedScopes,['action:set-shields','outpost:蓝方工厂','schedule:historical-manual-schedule']);assert.equal(fact.action,undefined);
 assert.ok(view.protections.every(p=>p.receiptId!=='manual:0:1'));assert.ok(view.protections.some(p=>p.kind==='funding'));
 assert.equal(commandSource(r,'historical-manual-schedule'),'manual');assert.deepEqual(restoreRoom(saveRoom(r)),r);
 assert.deepEqual(manualReceiptPage(r,0,new URLSearchParams({id:fact.id})).receipts,[fact]);assert.deepEqual(manualReceiptPage(r,1,new URLSearchParams({id:fact.id})).receipts,[]);
 assert.throws(()=>applyCoordinatedOrder(r,{id:'ai-fund',player:0,action:{kind:'toggle-funding',recipient:1}},'agent'));
});

test('malformed archived release facts cannot erase unrelated or revive released authority',()=>{
 for(const mutate of [
  (raw:any)=>{raw.manualCoordination.receipts[2].releasedReceiptIds=['manual:1:1'];},
  (raw:any)=>{raw.manualCoordination.receipts[2].releasedScopes=[];},
  (raw:any)=>{raw.manualCoordination.receipts[2].action={kind:'toggle-funding',recipient:1};},
  (raw:any)=>{raw.manualCoordination.protections.push({receiptId:'manual:0:1',player:0,eventCursor:1,kind:'schedule',scheduleId:'historical-manual-schedule',scope:['schedule:historical-manual-schedule']});},
 ]){const raw=JSON.parse(archived());mutate(raw);assert.throws(()=>restoreRoom(JSON.stringify(raw)),/manual/i);}
});

test('archived released future schedules do not regain protection or override newer commander choices',()=>{
 const r=room(),executed=advanceRoom(r,102);
 assert.equal(executed.scheduledOrders![0]!.status,'executed');assert.equal(commandSource(executed,'historical-manual-schedule'),'manual');
 assert.equal(manualCommandVersion(executed,0),3);assert.ok(manualCommandView(executed,0).protections.every(p=>p.receiptId!=='manual:0:1'));
 assert.doesNotThrow(()=>shields(executed,'ai-after-due',true,'agent'));
 const renewed=shields(r,'newer-owner',false),guarded=advanceRoom(renewed,102);assert.equal(guarded.scheduledOrders![0]!.status,'failed');assert.equal(commandSource(guarded,'historical-manual-schedule'),'manual');
 const cancelled=applyCoordinatedCancellation(r,'historical-manual-schedule',0,'agent');assert.equal(cancelled.scheduledOrders![0]!.status,'cancelled');assert.equal(manualCommandVersion(cancelled,0),3);
 assert.deepEqual(restoreRoom(saveRoom(executed)),executed);
});

test('new manual commands preserve archived facts but can never manufacture another release fact',()=>{
 let r=room();const history=structuredClone(r.manualCoordination!.receipts);
 for(let i=0;i<105;i++)r=applyCoordinatedOrder(r,{id:'fund-'+i,player:0,action:{kind:'toggle-funding',recipient:1}},'manual');
 assert.deepEqual(r.manualCoordination!.receipts.slice(0,3),history);assert.equal(r.manualCoordination!.receipts.filter(r=>r.kind==='release-protection').length,1);
 assert.ok(manualCommandView(r,0).hasEarlierReceipts);assert.equal('releaseSupported' in manualCommandView(r,0),false);
 assert.deepEqual(manualReceiptPage(r,0,new URLSearchParams({id:'manual:0:3'})).receipts,[history[2]]);assert.deepEqual(restoreRoom(saveRoom(r)),r);
});

test('removed owner release route returns 404 without changing manual facts, guards, lease or save boundary',async t=>{
 const current=shields(room(),'manual-shields',false),h=protocolHarness(t,{room:current}),data=h.ownerCredentials;
 const server=await createOwnerPlayerApi(h);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const request=(path:string,body?:unknown,headers:Record<string,string>={})=>fetch(`http://127.0.0.1:${address.port}`+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${data.credentials[0]!.token}`,...headers},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const lease=await(await request('/player/v2/owner/control',{action:'acquire',sessionId:'simplification-test-agent-session'})).json();assert.equal(lease.mode,'agent');
  const payload={id:'owner-release',receiptIds:['manual:0:4'],expectedManualVersion:4,expectedRoomId:data.roomId},before=saveRoom(h.store.load()!.room);
  for(const headers of [{},{'x-subterfuge-controller':'agent','x-subterfuge-control-session':'simplification-test-agent-session'}])assert.equal((await request('/player/v2/owner/manual-commands/release',payload,headers)).status,404);
  assert.equal(h.store.load()!.revision,1);assert.equal(saveRoom(h.store.load()!.room),before);assert.equal(manualCommandVersion(h.store.load()!.room,0),4);
  const observation=await(await request('/player/v2/owner/observation')).json();assert.equal('releaseSupported' in observation.manualCommands,false);
  const afterLease=await(await request('/player/v2/owner/control',undefined,{'x-subterfuge-control-session':'simplification-test-agent-session'})).json();assert.equal(afterLease.mode,'agent');assert.equal(afterLease.expiresAt,lease.expiresAt);assert.equal(afterLease.sessionId,lease.sessionId);
  assert.throws(()=>shields(current,'ai-still-guarded',true,'agent'));
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
