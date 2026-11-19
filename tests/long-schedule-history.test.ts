import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {scheduleOrder,pendingScheduleCount} from '../packages/server/src/scheduled-orders.js';
import {cancelSchedule,scheduleLaunch,saveRoom,restoreRoom,type LabRoom} from '../packages/server/src/planning.js';
import {RoomStore} from '../packages/server/src/room-store.js';
function fresh():LabRoom{const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;return {state:createFleetScenario(cfg),scheduled:[]};}
const input=(id:string)=>({order:{id,player:0,action:{kind:'set-shields' as const,outpostId:'蓝方工厂',enabled:false}},issueTick:101});
test('cancelled schedule history does not exhaust future queue or lose idempotence across SQLite restart',async()=>{
 let room=fresh();
 for(let i=0;i<1002;i++){room=scheduleOrder(room,input(`old-${i}`));room=cancelSchedule(room,`old-${i}`,0);}
 assert.equal(room.scheduledOrders!.length,1002);assert.equal(pendingScheduleCount(room),0);
 assert.equal(scheduleOrder(room,input('old-0')),room);assert.equal(room.scheduledOrders![0]!.status,'cancelled');
 room=scheduleOrder(room,input('new'));
 room=scheduleLaunch(room,{order:{id:'legacy-launch',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方后方',drillers:10}},departureTick:103});
 assert.equal(pendingScheduleCount(room),2);
 assert.throws(()=>saveRoom(room),/Portable room schedule limit/);
 const text=saveRoom(room,{trustedLocalStorage:true});assert.throws(()=>restoreRoom(text),/scheduled orders/);
 const spoof=JSON.parse(text);spoof.trustedLocalStorage=true;assert.throws(()=>restoreRoom(JSON.stringify(spoof)),/scheduled orders/);
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-schedule-history-'));let store=new RoomStore(join(dir,'room.sqlite'));
 try{
  store.commit(room,0);store.close();store=new RoomStore(join(dir,'room.sqlite'));
  const restored=store.load()!.room;assert.deepEqual(restored,room);assert.equal(scheduleOrder(restored,input('old-0')),restored);
  assert.equal(pendingScheduleCount(cancelSchedule(restored,'new',0)),1);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('1000 simultaneous pending orders remain the shared budget and local restore cannot bypass it',()=>{
 let room=fresh();
 for(let i=0;i<1000;i++)room=scheduleOrder(room,input(`pending-${i}`));
 assert.equal(pendingScheduleCount(room),1000);
 assert.throws(()=>scheduleOrder(room,input('overflow')),/Schedule limit/);
 assert.throws(()=>scheduleLaunch(room,{order:{id:'overflow-launch',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方后方',drillers:10}},departureTick:103}),/上限/);
 const malformed={...room,scheduledOrders:[...room.scheduledOrders!,{...room.scheduledOrders![0]!,id:'overflow'}]};
 assert.throws(()=>restoreRoom(saveRoom(malformed,{trustedLocalStorage:true}),{trustedLocalStorage:true}),/Schedule limit/);
 const cancelled=cancelSchedule(room,'pending-0',0),next=scheduleOrder(cancelled,input('replacement'));
 assert.equal(pendingScheduleCount(next),1000);assert.equal(next.scheduledOrders!.length,1001);
 assert.deepEqual(restoreRoom(saveRoom(next,{trustedLocalStorage:true}),{trustedLocalStorage:true}),next);
});
