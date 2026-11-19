import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder} from '../packages/engine/src/index.js';
import {scheduleLaunch,previewLaunch,saveRoom,advanceRoom,type LabRoom} from '../packages/server/src/planning.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {validateImmediateLaunchTime} from '../packages/server/src/schedule-time.js';
const fresh=():LabRoom=>({state:{...createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),secondsSinceLastTick:150},scheduled:[]});
const action={kind:'launch' as const,source:'蓝方工厂',destination:'红方矿场',drillers:1};
test('formal schedules use integer absolute days and reject without mutation; previews remain fractional',()=>{
 const room=fresh(),before=saveRoom(room),tick=room.state.economy.tick;
 assert.throws(()=>scheduleLaunch(room,{order:{id:'fraction',player:0,action},departureTick:tick+2.25}),/整数/);
 assert.throws(()=>scheduleOrder(room,{order:{id:'fraction-delay',player:0,action:{...action,delaySeconds:750}},issueTick:tick+2}),/整数/);
 const accepted=scheduleLaunch(room,{order:{id:'whole',player:0,action},departureTick:tick+2});assert.equal(accepted.scheduled[0]!.departureTick,tick+2);
 assert.doesNotThrow(()=>previewLaunch(room,{order:{id:'preview',player:0,action},departureTick:tick+2.25}));
 assert.equal(saveRoom(room),before);
});
test('explicit delay uses phase plus delay, default immediate and arbitrary engine simulation stay unchanged',()=>{
 const room=fresh();const order={id:'explicit',player:0,action:{...action,delaySeconds:1200}};
 assert.throws(()=>validateImmediateLaunchTime(room,order),/整数/);
 assert.doesNotThrow(()=>validateImmediateLaunchTime(room,{...order,action:{...action,delaySeconds:1050}}));
 assert.doesNotThrow(()=>validateImmediateLaunchTime(room,{...order,action}));
 assert.doesNotThrow(()=>submitFleetOrder(room.state,order,150));
 const waiting={...room,state:submitFleetOrder(room.state,{...order,action:{...action,delaySeconds:600}},150).state};
 assert.throws(()=>validateImmediateLaunchTime(waiting,{id:'edit-default',player:0,action}),/整数/);
 assert.throws(()=>validateImmediateLaunchTime(waiting,{id:'edit',player:0,action:{...action,delaySeconds:1050}}),/整数/);
});
test('accepted historical fractional intent retries remain idempotent with no new write',()=>{
 const room=fresh(),input={order:{id:'old',player:0,action},departureTick:room.state.economy.tick+2.25};
 const old=scheduleLaunch(room,input,150,{simulation:true});
 assert.equal(scheduleLaunch(old,input,150),old);
 const scheduled={order:{id:'old-order',player:0,action:{...action,delaySeconds:750}},issueTick:room.state.economy.tick+2};
 const accepted=scheduleOrder(room,scheduled,150,{simulation:true});
 assert.equal(scheduleOrder(accepted,scheduled,150),accepted);
});

import {once} from 'node:events';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {PlayerGateway} from '../packages/ai/src/controller/transport/gateway.js';
test('authenticated PlayerGateway cannot bypass whole-day schedule boundary or cause rejected writes',async t=>{
 const room=fresh();delete room.state.secondsSinceLastTick;const h=protocolHarness(t,{room}),data=h.ownerCredentials;
 const server=await createOwnerPlayerApi(h,{seconds:()=>150});
 server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert.ok(addr&&typeof addr==='object');
 const gateway=new PlayerGateway(`http://127.0.0.1:${addr.port}`,data.credentials[0]!.token,data.roomId,0,2);
 try{
  const observed=await gateway.request('/tool/observation') as any,revision=observed.revision;
  const bad={order:{id:'bad',action:{...action,delaySeconds:1200}},revision};
  await assert.rejects(gateway.request('/tool/order',bad),(e:any)=>e.code==='INVALID_REQUEST');assert.equal(h.store.load()!.revision,1);
  await assert.rejects(gateway.request('/tool/schedule',{order:{id:'bad-schedule',action:{...action,delaySeconds:750}},issueTick:room.state.economy.tick+2,revision}));assert.equal(h.store.load()!.revision,1);
  const good={order:{id:'good',action:{...action,delaySeconds:1050}},revision};
  await gateway.request('/tool/order',good);assert.equal(h.store.load()!.revision,2);
  await gateway.request('/tool/order',good);assert.equal(h.store.load()!.revision,2,'same accepted intent remains idempotent');
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('future explicit identity edits retain old deadline; new-slot same-route schedules really retime to whole days',()=>{
 const room=fresh(),tick=room.state.economy.tick;
 const waiting={...room,state:submitFleetOrder(room.state,{id:'waiting-original',player:0,action:{...action,delaySeconds:600}},150).state},before=saveRoom(waiting);
 assert.throws(()=>scheduleOrder(waiting,{order:{id:'identity-edit',player:0,action:{...action,fleetId:'waiting-original',delaySeconds:600}},issueTick:tick+1}),/整数/);
 assert.equal(saveRoom(waiting),before);
 const scheduled=scheduleOrder(waiting,{order:{id:'new-slot',player:0,action:{...action,delaySeconds:600}},issueTick:tick+1});
 const executed=advanceRoom(scheduled,tick+1),fleet=executed.state.fleets.find(f=>f.id==='new-slot')!;
 assert.equal(executed.scheduledOrders![0]!.status,'executed');assert.ok(fleet);
 assert.notEqual(fleet.slot,waiting.state.fleets.find(f=>f.id==='waiting-original')!.slot);
 assert.equal(executed.state.economy.tick+fleet.secondsUntilLaunch/600,tick+2,'actual engine countdown adopts the integer new departure');
 const departed=advanceRoom(executed,tick+3).state.events.find(e=>e.kind==='departed'&&e.subject==='new-slot')!;
 assert.ok(departed);assert.equal(departed.tick-1+departed.fraction,tick+2);
 // An isolated legacy simulation demonstrates why same-slot identity reuse
 // cannot be accepted as an integer reschedule merely from its requested delay.
 const legacy=scheduleOrder(waiting,{order:{id:'identity-simulation',player:0,action:{...action,fleetId:'waiting-original',delaySeconds:600}},issueTick:tick+1},150,{simulation:true});
 const simulated=advanceRoom(legacy,tick+1),old=simulated.state.fleets.find(f=>f.id==='waiting-original')!;
 assert.equal(simulated.state.economy.tick+old.secondsUntilLaunch/600,tick+1.25);
 assert.doesNotThrow(()=>scheduleOrder(waiting,{order:{id:'ordinary',player:0,action:{kind:'check-in'}},issueTick:tick+1}));
});
