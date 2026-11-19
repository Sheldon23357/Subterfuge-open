import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,restoreFleetSnapshot,saveFleetSnapshot,type FleetSetup,type FleetScenario,type FleetAction} from '../packages/engine/src/index.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {advanceRoom,cancelSchedule,saveRoom,restoreRoom} from '../packages/server/src/planning.js';
function setup():FleetSetup{return JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial;}
const issue=(s:FleetScenario,id:string,action:FleetAction,player=0)=>submitFleetOrder(s,{id,player,action}).state;
const launch={kind:'launch' as const,delaySeconds:600,source:'蓝方工厂',destination:'红方后方',drillers:1};
test('reservation and ordinary launch use original shared counter; later launch consumes reserved slot',()=>{
  let s=issue(createFleetScenario(setup()),'reserve',{kind:'reserve-fleet',reservationId:'later'});
  assert.deepEqual(s.fleetReservations,[{id:'later',player:0,slot:0}]);assert.equal(s.subCounters[0],0);
  s=issue(s,'now',{...launch,destination:'红方矿场'});assert.equal(s.fleets[0]!.slot,1);
  s=issue(s,'later',launch);assert.equal(s.fleets.find(f=>f.id==='later')!.slot,0);assert.equal(s.fleetReservations.length,0);
  assert.equal(s.subCounters[0],1);assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
});
test('release enforces ownership and permits circular reuse; rejected operations are atomic',()=>{
  let s=issue(createFleetScenario(setup()),'reserve',{kind:'reserve-fleet',reservationId:'later'});const before=JSON.stringify(s);
  assert.throws(()=>issue(s,'steal',{kind:'release-fleet-reservation',reservationId:'later'},1),/ownership/);
  assert.equal(JSON.stringify(s),before);s=issue(s,'free',{kind:'release-fleet-reservation',reservationId:'later'});
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);s.subCounters[0]=127;
  s=issue(s,'now',launch);assert.equal(s.fleets[0]!.slot,0);
});
test('all reserved slots reject allocation atomically, even without live fleets',()=>{
  let s=createFleetScenario(setup());for(let i=0;i<128;i++)s=issue(s,`reserve${i}`,{kind:'reserve-fleet',reservationId:`plan${i}`});
  const before=JSON.stringify(s);assert.throws(()=>issue(s,'full',launch),/slot/);assert.equal(JSON.stringify(s),before);
  assert.throws(()=>issue(s,'full-reserve',{kind:'reserve-fleet',reservationId:'extra'}),/slot/);
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
});
test('scheduled launch reserves immediately, persists and cancellation frees its slot',()=>{
  const r=scheduleOrder({state:createFleetScenario(setup()),scheduled:[]},{order:{id:'future',player:0,action:launch},issueTick:102});
  assert.equal(r.state.fleetReservations[0]!.slot,0);assert.equal(r.state.fleets.length,0);
  const restored=restoreRoom(saveRoom(r));const canceled=cancelSchedule(restored,'future',0);
  assert.deepEqual(canceled.state.fleetReservations,[]);assert.equal(advanceRoom(canceled,103).state.fleets.length,0);
  const done=advanceRoom(restored,102);assert.equal(done.state.fleets.find(f=>f.id==='future')!.slot,0);assert.deepEqual(done.state.fleetReservations,[]);
  assert.deepEqual(restoreRoom(saveRoom(done)),done);
});

test('reserved launch replacing an existing pending route refunds old troops and uses reserved identity',()=>{
  let s=issue(createFleetScenario(setup()),'reserve',{kind:'reserve-fleet',reservationId:'future'});
  s=issue(s,'now',{...launch,drillers:20});s=issue(s,'future',{...launch,drillers:30});
  assert.equal(s.fleets.find(f=>f.id==='future')!.slot,0);assert.equal(s.fleets.find(f=>f.id==='now')!.drillers,0);
  assert.equal(s.economy.outposts[0]!.drillers,70);assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
  assert.deepEqual(advanceFleetScenario(s,103).fleetReservations,[]);
});
test('scheduled launch whose reservation was released cannot silently allocate a new slot',()=>{
  const r=scheduleOrder({state:createFleetScenario(setup()),scheduled:[]},{order:{id:'future',player:0,action:launch},issueTick:102});
  const state=issue(r.state,'manual-release',{kind:'release-fleet-reservation',reservationId:'future'});
  const next=advanceRoom({...r,state},102);assert.equal(next.scheduledOrders![0]!.status,'failed');
  assert.match(next.scheduledOrders![0]!.reason!,/reservation missing/);assert.equal(next.state.fleets.length,0);
});
