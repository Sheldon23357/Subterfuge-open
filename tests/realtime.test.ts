import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,advanceFleetScenario,saveFleetSnapshot,restoreFleetSnapshot,advanceEconomicScenario,saveEconomicSnapshot,restoreEconomicSnapshot,type FleetSetup} from '../packages/engine/src/index.js';
import {advanceRoom,saveRoom,restoreRoom,type LabRoom} from '../packages/server/src/planning.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {startRealtime,realtimeTarget,realtimeSeconds,catchUpRealtime,TICK_MILLISECONDS} from '../packages/server/src/realtime.js';
const epoch=1_800_000_000_000;
test('ten wall seconds advance one tick with proportional rule-second phase',async()=>{
  const r=startRealtime(room(),epoch);
  assert.equal(TICK_MILLISECONDS,10_000);
  assert.equal(realtimeSeconds(r,epoch+5000),300);
  assert.equal(realtimeSeconds(r,epoch+9999),599);
  const next=await catchUpRealtime(r,epoch+10_000);
  assert.equal(next.state.economy.tick,r.state.economy.tick+1);
  assert.equal(realtimeSeconds(next,epoch+10_000),0);
  assert.equal(realtimeSeconds(next,epoch+10_500),30);
});
function room():LabRoom{
  const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  return {state:createFleetScenario(cfg),scheduled:[]};
}
test('wall anchor preserves partial tick across restart and exact boundaries, never rewinds',async()=>{
  const r=startRealtime(room(),epoch),initial=r.state.economy.tick;
  assert.equal(realtimeTarget(r,epoch+TICK_MILLISECONDS-1),initial);
  assert.equal(await catchUpRealtime(r,epoch+TICK_MILLISECONDS-1),r);
  const next=await catchUpRealtime(restoreRoom(saveRoom(r)),epoch+TICK_MILLISECONDS);
  assert.equal(next.state.economy.tick,initial+1);assert.equal(realtimeTarget(next,epoch-1000),initial+1);
  assert.equal(await catchUpRealtime(next,epoch-1000),next);
  const twice=await catchUpRealtime(restoreRoom(saveRoom(next)),epoch+TICK_MILLISECONDS*2);
  assert.deepEqual(twice.state,advanceFleetScenario(r.state,initial+2));
  assert.deepEqual(twice.clock,r.clock);assert.equal(startRealtime(twice,epoch+999),twice);
});
test('offline catch-up executes only saved orders, equals online batches, and does not duplicate commands',async()=>{
  let r=startRealtime(room(),epoch);
  r=scheduleOrder(r,{order:{id:'funding',player:1,action:{kind:'toggle-funding',recipient:0}},issueTick:102});
  r=scheduleOrder(r,{order:{id:'shield',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}},issueTick:104});
  const offline=await catchUpRealtime(restoreRoom(saveRoom(r)),epoch+TICK_MILLISECONDS*150);
  let online=r;for(let i=1;i<=150;i++)online=await catchUpRealtime(online,epoch+TICK_MILLISECONDS*i);
  assert.deepEqual(offline,online);assert.equal(offline.state.commands.length,2);
  assert.equal(await catchUpRealtime(offline,epoch+TICK_MILLISECONDS*150),offline);
  assert.deepEqual(restoreRoom(saveRoom(offline)),offline);
});
test('ended worlds stop at terminal tick even after a long outage',async()=>{
  const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:1};const r=startRealtime({state:createFleetScenario(cfg),scheduled:[]},epoch);
  const next=await catchUpRealtime(r,epoch+TICK_MILLISECONDS*10000);assert.equal(next,r);
});
test('clock import rejects malformed anchor and services reject invalid wall readings',()=>{
  const r=startRealtime(room(),epoch),data=JSON.parse(saveRoom(r));data.clock.anchorTick=r.state.economy.tick+1;
  assert.throws(()=>restoreRoom(JSON.stringify(data)),/clock/);
  for(const now of [-1,NaN,Infinity,1.5])assert.throws(()=>realtimeTarget(r,now),/wall/);
  assert.equal(realtimeTarget(room(),epoch+TICK_MILLISECONDS),100);
});
test('long-lived world passes the former 10000-tick lifetime cap and restores via segmented replay',async()=>{
  const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.economy.outposts.forEach(o=>{o.type='generator';o.owner=null;o.shield=0;o.shieldMax=0;});
  const r=startRealtime({state:createFleetScenario(cfg),scheduled:[]},epoch);
  const near=advanceRoom(r,10099),next=advanceRoom(near,10101);
  assert.equal(next.state.economy.tick,10101);assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(next.state)),next.state);
  const economic=advanceEconomicScenario(advanceEconomicScenario(r.state.economy,10099),10101);
  assert.deepEqual(restoreEconomicSnapshot(saveEconomicSnapshot(economic)),economic);
  const scheduled=scheduleOrder(next,{order:{id:'late-failure',player:0,action:{kind:'toggle-mine',outpostId:cfg.economy.outposts[0]!.id}},issueTick:10102});
  assert.deepEqual(restoreRoom(saveRoom(scheduled)),scheduled);
  assert.equal(advanceRoom(scheduled,10102).scheduledOrders![0]!.status,'failed');
});
