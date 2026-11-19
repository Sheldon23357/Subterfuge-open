import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,type FleetSetup,type FleetAction} from '../packages/engine/src/index.js';
import {advanceRoom,cancelSchedule,saveRoom,restoreRoom,scheduleLaunch,type LabRoom} from '../packages/server/src/planning.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
function room():LabRoom{
  const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;

  return {state:createFleetScenario(cfg),scheduled:[]};
}
const schedule=(r:LabRoom,id:string,issueTick:number,action:FleetAction)=>scheduleOrder(r,{order:{id,player:0,action},issueTick});



test('queue acceptance does not consult future hidden resources or targets',()=>{
  const r=schedule(room(),'unavailable',101,{kind:'toggle-mine',outpostId:'does-not-exist'});
  assert.equal(r.scheduledOrders![0]!.status,'pending');
  const next=advanceRoom(r,101);assert.equal(next.scheduledOrders![0]!.status,'failed');assert.equal(next.state.commands.length,0);
});
test('owner-only cancellation, replay-safe idempotency, conflicts, schema and import validation',()=>{
  const action={kind:'set-shields' as const,outpostId:'蓝方工厂',enabled:false};
  const r=schedule(room(),'shield',101,action);
  assert.equal(schedule(r,'shield',101,action),r);
  assert.throws(()=>schedule(r,'shield',102,action),/conflict/);
  assert.throws(()=>cancelSchedule(r,'shield',1));
  const canceled=cancelSchedule(r,'shield',0);assert.equal(advanceRoom(canceled,102).scheduledOrders![0]!.status,'cancelled');
  const done=advanceRoom(r,102);assert.equal(schedule(done,'shield',101,action),done);
  const raw=JSON.parse(saveRoom(r));raw.agendaOrder=['bogus'];assert.throws(()=>restoreRoom(JSON.stringify(raw)),/agenda/);
  const wrong=JSON.parse(saveRoom(r));wrong.scheduledOrders[0].action.kind='unknown';assert.throws(()=>restoreRoom(JSON.stringify(wrong)),/Unsupported/);
  assert.throws(()=>schedule(room(),'past',100,action),/tick/);
  assert.throws(()=>schedule(room(),'fraction',101.2,action),/整数/);
});
test('legacy launch and general actions share persisted insertion order',()=>{
  let r=schedule(room(),'generic-launch',102,{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方后方',drillers:100});
  r=scheduleLaunch(r,{departureTick:102,order:{id:'legacy-launch',player:0,action:{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方矿场',drillers:1}}});
  assert.deepEqual(r.agendaOrder,['generic-launch','legacy-launch']);
  const next=advanceRoom(restoreRoom(saveRoom(r)),102);
  assert.equal(next.scheduledOrders![0]!.status,'executed');assert.equal(next.scheduled[0]!.status,'executed');
  assert.equal(next.state.fleets[0]!.id,'generic-launch');assert.deepEqual(next.state.commands.filter(c=>c.action.kind==='launch').map(c=>c.id),['generic-launch','legacy-launch']);
});

test('scheduled mine construction executes after the tick and completes at its later boundary',()=>{
 const r=schedule(room(),'mine',101,{kind:'toggle-mine',outpostId:'蓝方工厂'});
 assert.equal(r.state.economy.outposts[0]!.minePending,false);
 const pending=advanceRoom(r,101);assert.equal(pending.scheduledOrders![0]!.status,'executed');assert.equal(pending.state.economy.outposts[0]!.minePending,true);
 const later=advanceRoom(pending,102);assert.equal(later.state.economy.outposts[0]!.type,'mine');
 assert.deepEqual(restoreRoom(saveRoom(later)),later);assert.deepEqual(advanceRoom(r,102),later);
});
test('same-tick insertion order survives a failed action and keeps later settings',()=>{
 let r=schedule(room(),'first',101,{kind:'set-shields',outpostId:'蓝方工厂',enabled:false});
 r=schedule(r,'missing',101,{kind:'toggle-mine',outpostId:'missing'});r=schedule(r,'last',101,{kind:'set-shields',outpostId:'蓝方工厂',enabled:true});
 const next=advanceRoom(r,101);assert.deepEqual(next.scheduledOrders!.map(p=>p.status),['executed','failed','executed']);
 assert.equal(next.state.economy.outposts[0]!.shieldsEnabled,true);assert.deepEqual(next.state.commands.filter(c=>c.action.kind==='set-shields').map(c=>c.id),['first','last']);
 assert.deepEqual(restoreRoom(saveRoom(next)),next);
});
