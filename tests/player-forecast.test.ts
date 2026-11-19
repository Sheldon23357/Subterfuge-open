import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,originalFutureActionKnown,type FleetSetup} from '../packages/engine/src/index.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {scheduleLaunch,advanceRoom,type LabRoom} from '../packages/server/src/planning.js';
import {prepareForecastAgenda,simulatePlayerFuture} from '../packages/server/src/player-forecast.js';
const setup=()=>JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;

test('immediate and future failed mine drafts include safe reasons at execution time',()=>{
 const cfg=setup();cfg.economy.outposts[0]!.type='generator';cfg.economy.outposts[0]!.drillers=41;
 const room:LabRoom={state:createFleetScenario(cfg),scheduled:[]},before=JSON.stringify(room);
 for(const issueTick of [100,102]){
  const result=simulatePlayerFuture(room,0,103,[{id:'early-mine',player:0,issueTick,action:{kind:'toggle-mine',outpostId:'蓝方工厂'}}]);
  assert.equal(result.status,'conditional');if(result.status!=='conditional')continue;
  const failure=result.orders.find(o=>o.id==='early-mine')!;
  assert.equal(failure.status,'failed');assert.equal(failure.code,'insufficient-drillers');assert.match(failure.reason!,/驻兵不足/);
  assert.equal(failure.issueTick,issueTick);
 }
 assert.equal(JSON.stringify(room),before);
});

test('hypothetical launch and cancellation use the original queue without changing the live room',()=>{
 const cfg=setup(),room:LabRoom={state:createFleetScenario(cfg),scheduled:[]};
 const drafts=[{id:'draft-launch',player:0,issueTick:102,action:{kind:'launch' as const,source:cfg.economy.outposts[0]!.id,destination:cfg.economy.outposts[1]!.id,drillers:10}},
  {id:'draft-cancel',player:0,issueTick:103,action:{kind:'cancel-launch' as const,fleetId:'draft-launch'}}];
 const before=JSON.stringify(room),input=JSON.stringify(drafts);
 const launched=simulatePlayerFuture(room,0,102,drafts.slice(0,1));
 assert.equal(launched.status,'conditional');if(launched.status==='conditional'){
  assert.equal(launched.result.fleets[0]!.drillers,10);
  assert.equal(launched.orders[0]!.status,'executed');
 }
 const cancelled=simulatePlayerFuture(room,0,103,drafts);
 const reference=drafts.reduce((r,{issueTick,...order})=>scheduleOrder(r,{order,issueTick}),room);
 assert.deepEqual(cancelled,simulatePlayerFuture(reference,0,103));
 assert.equal(JSON.stringify(room),before);assert.equal(JSON.stringify(drafts),input);
 assert.throws(()=>simulatePlayerFuture(room,0,103,[{...drafts[0]!,player:1}]),/draft/);
 assert.throws(()=>simulatePlayerFuture(room,0,103,[drafts[0]!,drafts[0]!]),/draft/);
 for(const issueTick of [99,104,101.5])assert.throws(()=>simulatePlayerFuture(room,0,103,[{...drafts[0]!,issueTick}]),/draft/);
 for(const action of [{kind:'resign' as const},{kind:'toggle-funding' as const,recipient:1},
  {kind:'reserve-fleet' as const,reservationId:'x'}])assert.throws(()=>simulatePlayerFuture(room,0,103,[{id:'hidden-product-action',player:0,issueTick:102,action}]),/draft/);
});
test("original queue visibility includes only active formal allies (local rules)",()=>{

 for(const state of [1,2,3,4]){
  assert.equal(originalFutureActionKnown(0,0,0,state),state===1);
  assert.equal(originalFutureActionKnown(0,0,1,state),false);
  assert.equal(originalFutureActionKnown(2,0,1,state),state===1);
  assert.equal(originalFutureActionKnown(2,0,2,state),false);
 }
});

test('present drafts use observed seconds and can be followed by future cancellations',()=>{
 for(const seconds of [0,250,599]){
  const cfg=setup(),room:LabRoom={state:createFleetScenario(cfg),scheduled:[]};
  room.state.secondsSinceLastTick=seconds;
  const launch={id:'present-launch',player:0,action:{kind:'launch' as const,delaySeconds:600,source:cfg.economy.outposts[0]!.id,destination:cfg.economy.outposts[1]!.id,drillers:10}};
  const cancel={id:'later-cancel',player:0,action:{kind:'cancel-launch' as const,fleetId:launch.id}};
  const before=JSON.stringify(room);
  const result=simulatePlayerFuture(room,0,101,[{...launch,issueTick:100}]);
  const executed={...room,state:submitFleetOrder(room.state,launch,seconds).state};
  const reference=simulatePlayerFuture(executed,0,101);
  assert.equal(result.status,'conditional');assert.equal(reference.status,'conditional');
  if(result.status==='conditional'&&reference.status==='conditional'){
   assert.deepEqual(result.result.fleets,reference.result.fleets);
   assert.equal(result.result.fleets[0]!.secondsUntilLaunch,seconds);
   assert.equal(result.orders[0]!.status,'executed');
  }
  const cancelled=simulatePlayerFuture(room,0,101,[{...launch,issueTick:100},{...cancel,issueTick:101}]);
  const scheduled=scheduleOrder(executed,{order:cancel,issueTick:101},seconds);
  const expected=simulatePlayerFuture(scheduled,0,101);
  assert.equal(cancelled.status,'conditional');assert.equal(expected.status,'conditional');
  if(cancelled.status==='conditional'&&expected.status==='conditional'){
   assert.deepEqual(cancelled.result,expected.result);
   assert.equal(cancelled.orders.find(p=>p.id==='later-cancel')!.status==='executed',seconds>0);
  }
  assert.equal(JSON.stringify(room),before);
 }
});
test('forecast agenda excludes opponent orders/history and copies known commands in submission order',()=>{
 const cfg=setup();let room:LabRoom={state:createFleetScenario(cfg),scheduled:[]};
 room=scheduleOrder(room,{order:{id:'enemy-secret',player:1,action:{kind:'check-in'}},issueTick:102});
 room=scheduleOrder(room,{order:{id:'own-later',player:0,action:{kind:'check-in'}},issueTick:104});
 room=scheduleOrder(room,{order:{id:'own-sooner',player:0,action:{kind:'launch',delaySeconds:600,source:cfg.economy.outposts[0]!.id,destination:cfg.economy.outposts[1]!.id,drillers:10,}},issueTick:102});
 const plans=prepareForecastAgenda(room,0);assert.deepEqual(plans.map(p=>p.id),['own-later','own-sooner']);
 assert.equal(JSON.stringify(plans).includes('enemy-secret'),false);assert.equal('launchSlot'in plans[1]!,false);
 if(plans[1]!.action.kind==='launch')plans[1]!.action.destination='mutated';
 assert.equal(JSON.stringify(room).includes('mutated'),false);
 room.state.economy.initial.teamSize=2;assert.equal(prepareForecastAgenda(room,0).length,3);
 room.state.economy.players[1]!.active=false;assert.equal(prepareForecastAgenda(room,0).length,2);
});
test('known launch and its later cancellation simulate without touching authoritative orders',()=>{
 const cfg=setup();let room:LabRoom={state:createFleetScenario(cfg),scheduled:[]};
 room=scheduleOrder(room,{order:{id:'own-launch',player:0,action:{kind:'launch',delaySeconds:600,source:cfg.economy.outposts[0]!.id,destination:cfg.economy.outposts[1]!.id,drillers:10}},issueTick:102});
 room=scheduleOrder(room,{order:{id:'own-cancel',player:0,action:{kind:'cancel-launch',fleetId:'own-launch'}},issueTick:103});
 const before=JSON.stringify(room),atLaunch=simulatePlayerFuture(room,0,102),afterCancel=simulatePlayerFuture(room,0,103);
 assert.equal(atLaunch.status,'conditional');assert.equal(afterCancel.status,'conditional');
 if(atLaunch.status!=='conditional'||afterCancel.status!=='conditional')return;
 assert.equal(atLaunch.result.fleets[0]!.secondsUntilLaunch,600);
 assert.equal(afterCancel.result.fleets.length,1);assert.notEqual(afterCancel.orders.find(p=>p.id==='own-cancel')!.status,'executed');
 assert.equal(JSON.stringify(room),before);
 room=scheduleOrder(room,{order:{id:'enemy-hidden-plan',player:1,action:{kind:'launch',delaySeconds:600,source:cfg.economy.outposts[1]!.id,destination:cfg.economy.outposts[0]!.id,drillers:5}},issueTick:102});
 assert.deepEqual(simulatePlayerFuture(room,0,103),afterCancel);
});
test('legacy departure scheduling retains original departure delay and matches unfiltered known execution',()=>{
 const cfg=setup();let room:LabRoom={state:createFleetScenario(cfg),scheduled:[]};
 room=scheduleLaunch(room,{order:{id:'legacy',player:0,action:{kind:'launch',delaySeconds:600,source:cfg.economy.outposts[0]!.id,destination:cfg.economy.outposts[1]!.id,drillers:10}},departureTick:105});
 const tick=room.scheduled[0]!.issueTick,result=simulatePlayerFuture(room,0,tick);
 assert.equal(result.status,'conditional');if(result.status!=='conditional')return;
 const reference=advanceRoom(room,tick,true);
 assert.equal(result.result.fleets[0]!.secondsUntilLaunch,reference.state.fleets[0]!.secondsUntilLaunch);
 assert.throws(()=>simulatePlayerFuture(room,0,100.5),/horizon/);
 assert.throws(()=>simulatePlayerFuture(room,0,1541),/horizon/);
});






test('AI defense forecast recalls only observed enemy waiting fleets using the original cancellation',()=>{
 const cfg=setup(),source=cfg.economy.outposts[1]!.id,destination=cfg.economy.outposts[2]!.id;

 const waiting=submitFleetOrder(createFleetScenario(cfg),{id:'enemy-waiting',player:1,action:{kind:'launch',delaySeconds:600,source,destination,drillers:10,}},0).state;
 const own=submitFleetOrder(waiting,{id:'own-waiting',player:0,action:{kind:'launch',delaySeconds:600,source:cfg.economy.outposts[0]!.id,destination:source,drillers:5}},0).state;
 const room:LabRoom={state:own,scheduled:[]},before=JSON.stringify(room),tick=own.economy.tick;
 const current=simulatePlayerFuture(room,0,tick),defended=simulatePlayerFuture(room,0,tick,[],'defend');
 assert.equal(current.status,'conditional');assert.equal(defended.status,'conditional');
 if(current.status!=='conditional'||defended.status!=='conditional')return;
 const currentSource=current.result.outposts.find(p=>p.id===source)!;
 assert.equal('drillers' in currentSource?currentSource.drillers:undefined,1);
 const defendedSource=defended.result.outposts.find(p=>p.id===source)!;
 assert.equal('drillers' in defendedSource?defendedSource.drillers:undefined,11);
 assert.ok(defended.result.fleets.some(f=>f.id==='own-waiting'));
 assert.ok(!defended.result.fleets.some(f=>f.id==='enemy-waiting'));
 const actualRecall=submitFleetOrder(own,{id:'reference-cancel',player:1,action:{kind:'cancel-launch',fleetId:'enemy-waiting'}},0).state;
 const reference=simulatePlayerFuture({...room,state:actualRecall},0,tick);
 assert.equal(reference.status,'conditional');if(reference.status==='conditional'){
   assert.deepEqual(defended.result.outposts,reference.result.outposts);
 }
 const launched=advanceRoom(room,tick+2,true);
 const normal=simulatePlayerFuture(launched,0,tick+2),conservative=simulatePlayerFuture(launched,0,tick+2,[],'defend');
 assert.equal(normal.status,'conditional');assert.equal(conservative.status,'conditional');
 if(normal.status==='conditional'&&conservative.status==='conditional')assert.deepEqual(normal.result.fleets,conservative.result.fleets);
 assert.equal(JSON.stringify(room),before);
});


test('an apparent empty-source attack fails against recallable defenders rather than assuming their departure',()=>{
 const cfg=setup(),source=cfg.economy.outposts[1]!,home=cfg.economy.outposts[0]!.id;
 source.drillers=39;source.shield=0;source.shieldMax=0;
 const state=submitFleetOrder(createFleetScenario(cfg),{id:'enemy-34',player:1,action:{kind:'launch',delaySeconds:600,source:source.id,destination:cfg.economy.outposts[2]!.id,drillers:34}},0).state;
 const room:LabRoom={state,scheduled:[]};
 const drafts=[{id:'attack-29',player:0,issueTick:100,action:{kind:'launch' as const,source:home,destination:source.id,drillers:29}}];
 const departing=simulatePlayerFuture(room,0,120,drafts),defending=simulatePlayerFuture(room,0,120,drafts,'defend');
 assert.equal(departing.status,'conditional');assert.equal(defending.status,'conditional');
 if(departing.status==='conditional'&&defending.status==='conditional'){
   assert.equal(departing.result.outposts.find(p=>p.id===source.id)!.owner,0);
   assert.equal(defending.result.outposts.find(p=>p.id===source.id)!.owner,1);
 }
});
