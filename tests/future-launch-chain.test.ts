import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {advanceRoom,cancelSchedule,saveRoom,restoreRoom,type LabRoom} from '../packages/server/src/planning.js';
function room():LabRoom{
  const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;

  return {state:createFleetScenario(cfg),scheduled:[]};
}
const launch={kind:'launch' as const,source:'蓝方工厂',destination:'红方后方',drillers:20,delaySeconds:1800};
function plan(r:LabRoom,id:string,tick:number,drillers:number,fleetId?:string):LabRoom{
  return scheduleOrder(r,{order:{id,player:0,action:{...launch,drillers,...(fleetId?{fleetId}:{})}},issueTick:tick});
}

test('future launch edits share one original slot and preserve departure, troops and replay',()=>{
  let r=scheduleOrder(room(),{order:{id:'root',player:0,action:{...launch,}},issueTick:101});
  r=scheduleOrder(r,{order:{id:'edit',player:0,action:{...launch,drillers:40,fleetId:'root',}},issueTick:102});
  assert.equal(r.state.fleetReservations.length,1);
  assert.deepEqual(r.scheduledOrders!.map(p=>p.launchSlot),[0,0]);
  const original=saveRoom(r),done=advanceRoom(restoreRoom(original),102);
  assert.equal(done.state.fleets.filter(f=>f.used).length,1);
  assert.equal(done.state.fleets[0]!.id,'root');assert.equal(done.state.fleets[0]!.slot,0);
  assert.equal(done.state.fleets[0]!.drillers,40);assert.equal(done.state.fleets[0]!.secondsUntilLaunch,1200);

  assert.equal(done.state.subCounters[0],0);assert.equal(done.state.fleetReservations.length,0);
  assert.deepEqual(done.scheduledOrders!.map(p=>p.status),['executed','executed']);
  assert.deepEqual(restoreRoom(saveRoom(done)),done);
  assert.deepEqual(advanceRoom(advanceRoom(r,101),102),done);
  assert.equal(saveRoom(r),original);
});

test('failure flags do not prevent a not-yet-due related launch from executing',()=>{
  let r=plan(room(),'root',103,20);r=plan(r,'earlier',102,10000,'root');
  r=advanceRoom(r,102);
  assert.equal(r.scheduledOrders![0]!.status,'pending');assert.equal(r.scheduledOrders![0]!.failed,true);
  assert.deepEqual(restoreRoom(saveRoom(r)),r);
  r=advanceRoom(r,103);
  assert.equal(r.scheduledOrders![0]!.status,'executed');assert.equal(r.scheduledOrders![0]!.failed,undefined);
  assert.equal(r.state.fleets[0]!.id,'root');
});

test('F2e cancels matching root/edit actions and releases the single shared reservation',()=>{
  let r=plan(room(),'root',102,20);r=plan(r,'edit',103,40,'root');
  const canceled=cancelSchedule(r,'edit',0,500);
  assert.deepEqual(canceled.scheduledOrders!.map(p=>p.status),['cancelled','cancelled']);
  assert.equal(canceled.state.fleetReservations.length,0);
  assert.equal(advanceRoom(canceled,105).state.fleets.length,0);
  assert.deepEqual(restoreRoom(saveRoom(canceled)),canceled);
  assert.throws(()=>cancelSchedule(r,'edit',1));
});

test('F2e respects the original one-tick comparison instead of canceling every record with a shared slot',()=>{
  let r=plan(room(),'root',102,20);r=plan(r,'near',103,30,'root');r=plan(r,'far',104,40,'root');
  const canceled=cancelSchedule(r,'root',0);
  assert.deepEqual(canceled.scheduledOrders!.map(p=>p.status),['cancelled','cancelled','pending']);
  const done=advanceRoom(canceled,104);assert.equal(done.scheduledOrders![2]!.status,'failed');
  assert.match(done.scheduledOrders![2]!.reason!,/reservation missing/);
});

test('original launch failure propagates backward to matching modifications; a successful retry clears it',()=>{
  let r=plan(room(),'root',101,20);r=plan(r,'too-large',102,10000,'root');
  const failed=advanceRoom(r,102);
  assert.deepEqual(failed.scheduledOrders!.map(p=>p.status),['failed','failed']);
  assert.equal(failed.state.fleets[0]!.drillers,20);
  assert.deepEqual(restoreRoom(saveRoom(failed)),failed);
  let retry=plan(failed,'retry',103,35,'root');retry=advanceRoom(retry,103);
  assert.equal(retry.scheduledOrders![0]!.status,'failed'); // two ticks apart
  assert.equal(retry.scheduledOrders![1]!.status,'executed');
  assert.equal(retry.scheduledOrders![2]!.status,'executed');
  assert.equal(retry.state.fleets[0]!.drillers,35);
});

test('shared-fleet edits reject foreign identities, mismatched routes and modification after departure atomically',()=>{
  const r=plan(room(),'root',101,20),before=saveRoom(r);
  assert.throws(()=>scheduleOrder(r,{order:{id:'foreign',player:1,action:{...launch,fleetId:'root'}},issueTick:102}),/unavailable/);
  assert.throws(()=>scheduleOrder(r,{order:{id:'route',player:0,action:{...launch,destination:'红方矿场',fleetId:'root'}},issueTick:102}),/route mismatch/);
  assert.equal(saveRoom(r),before);
  let done=advanceRoom(r,105);
  const original=saveRoom(done);
  assert.throws(()=>submitFleetOrder(done.state,{id:'late',player:0,action:{...launch,fleetId:'root'}}),/not editable/);
  assert.equal(saveRoom(done),original);
});

test('failed launch can be canceled at its own issue tick, releasing the reserved slot as kr.cancelFutureAction does',()=>{
  let r=advanceRoom(plan(room(),'failed',101,10000),101);
  assert.equal(r.state.fleetReservations.length,1);assert.equal(r.scheduledOrders![0]!.status,'failed');
  r=cancelSchedule(r,'failed',0);
  assert.equal(r.state.fleetReservations.length,0);assert.equal(r.scheduledOrders![0]!.status,'cancelled');
  assert.deepEqual(restoreRoom(saveRoom(r)),r);
});

test('stored original slot identity survives removal and circular reuse before the future modification',()=>{
  let r=plan(room(),'root',105,20);
  const issue=(id:string,action:Parameters<typeof submitFleetOrder>[1]['action'])=>{r={...r,state:submitFleetOrder(r.state,{id,player:0,action}).state};};
  issue('early',{...launch,fleetId:'root'});issue('remove',{kind:'cancel-launch',fleetId:'root'});
  for(let i=1;i<128;i++){
    issue(`reserve-${i}`,{kind:'reserve-fleet',reservationId:`slot-${i}`});
    issue(`release-${i}`,{kind:'release-fleet-reservation',reservationId:`slot-${i}`});
  }
  issue('replacement',{...launch,drillers:35,delaySeconds:86400});
  assert.equal(r.state.fleets.find(f=>f.id==='replacement')!.slot,0);
  r=advanceRoom(r,105);
  const fleet=r.state.fleets.find(f=>f.used&&f.slot===0)!;
  assert.equal(fleet.id,'replacement');assert.equal(fleet.drillers,20);
  assert.equal(r.scheduledOrders![0]!.status,'executed');
  assert.deepEqual(restoreRoom(saveRoom(r)),r);
});
