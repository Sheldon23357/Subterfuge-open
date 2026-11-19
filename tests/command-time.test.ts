import {scheduleLaunch,advanceRoom} from '../packages/server/src/planning.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,saveFleetSnapshot,restoreFleetSnapshot,replayFleetScenario,exportFleetReplay,type FleetSetup,type FleetScenario,type FleetAction} from '../packages/engine/src/index.js';
import {commandTime} from '../packages/engine/src/command-time.js';
import {startRealtime,realtimeSeconds,catchUpRealtime} from '../packages/server/src/realtime.js';
function setup():FleetSetup{
  const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  return cfg;
}
const command=(s:FleetScenario,id:string,action:FleetAction,seconds:number)=>submitFleetOrder(s,{id,player:0,action},seconds).state;
const launch={kind:'launch' as const,delaySeconds:600,source:'蓝方工厂',destination:'红方后方',drillers:10};
test("time getters preserve strict gifting and mine boundaries (local rules)",()=>{

  const sub={private_isGift:false,secsUntilGifting:50};
  assert.equal(commandTime.gift(sub,50),false);assert.equal(commandTime.gift(sub,51),true);
  assert.equal(commandTime.gifting(sub,50),false);
  const outpost={private_type:1,private_secsUntilMineCreation:50};
  assert.equal(commandTime.outpostType(outpost,50),1);assert.equal(commandTime.outpostType(outpost,51),0);
  assert.equal(commandTime.mining(outpost,50),0);
});
test('late launch carries phase into countdown, fractional departure and replay',()=>{
  let s=command(createFleetScenario(setup()),'late',launch,590);
  assert.equal(s.fleets[0]!.secondsUntilLaunch,1190);assert.equal(s.commands[0]!.seconds,590);
  assert.equal(s.events.find(e=>e.kind==='launch-ordered')!.fraction,590/600);
  s=advanceFleetScenario(s,101);assert.equal(s.fleets[0]!.state,'waiting');assert.equal(s.fleets[0]!.secondsUntilLaunch,590);
  s=advanceFleetScenario(s,102);const departed=s.events.find(e=>e.kind==='departed')!;
  assert.equal(departed.tick,102);assert.ok(Math.abs(departed.fraction-590/600)<1e-12);
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
});



test('mine and shield countdowns survive late commands without early tick completion',()=>{
  let s=command(createFleetScenario(setup()),'mine',{kind:'toggle-mine',outpostId:'蓝方工厂'},500);
  s=command(s,'shield',{kind:'set-shields',outpostId:'蓝方工厂',enabled:false},550);
  s=advanceFleetScenario(s,101);assert.equal(s.economy.outposts[0]!.type,'factory');assert.equal(s.economy.outposts[0]!.mineSeconds,500);assert.equal(s.economy.outposts[0]!.shieldsEnabled,true);
  assert.throws(()=>command(s,'late-cancel',{kind:'toggle-mine',outpostId:'蓝方工厂'},500),/expired/);
  const canceled=command(s,'cancel',{kind:'toggle-mine',outpostId:'蓝方工厂'},499);assert.equal(canceled.economy.outposts[0]!.minePending,false);
  const end=advanceFleetScenario(s,102);assert.equal(end.economy.outposts[0]!.type,'mine');assert.equal(end.economy.outposts[0]!.shieldsEnabled,false);
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(end)),end);assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(canceled)),canceled);
});
test('fleet return has no commitment delay at fractional world time',()=>{
 let s=command(createFleetScenario(setup()),'fleet',launch,0);
 s=command(s,'destroy',{kind:'return-fleet',fleetId:'fleet'},50);
 assert.equal(s.fleets[0]!.used,true);assert.equal(s.fleets[0]!.returned,true);assert.ok(s.events.some(e=>e.kind==='fleet-recalled'&&e.fraction===50/600));
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
});

test('phase cannot rewind inside one tick; duplicates remain idempotent and invalid phases are atomic',()=>{
  const s=command(createFleetScenario(setup()),'late',launch,500),saved=JSON.stringify(s);
  for(const seconds of [-1,499,600,Infinity,1.5])assert.throws(()=>command(s,'invalid',{kind:'check-in'},seconds),/seconds/);
  assert.equal(JSON.stringify(s),saved);
  assert.equal(submitFleetOrder(s,{id:'late',player:0,action:launch},599).duplicate,true);
  const replay=exportFleetReplay(s);replay.commands.push({id:'rewind',player:0,action:{kind:'check-in'},tick:100,seconds:499});
  assert.throws(()=>replayFleetScenario(replay),/seconds/);
});
test('host phase is whole-second, survives clock rollback, and resets after a tick',async()=>{
  let r=startRealtime({state:createFleetScenario(setup()),scheduled:[]},1000000);
  assert.equal(realtimeSeconds(r,1009999),599);
  r={...r,state:command(r.state,'late',launch,599)};assert.equal(realtimeSeconds(r,1001000),599);
  r=await catchUpRealtime(r,1010500);assert.equal(realtimeSeconds(r,1010500),30);
});

 test('legacy absolute departure does not add command phase twice',()=>{
 const cfg=setup();cfg.match={mode:'mining',neptuniumGoal:1000};
 let room={state:command(createFleetScenario(cfg),'phase',{kind:'check-in'},100),scheduled:[]};
 assert.throws(()=>scheduleLaunch(room,{order:{id:'absolute',player:0,action:launch},departureTick:101.5},100),/整数/);
 const planned=scheduleLaunch(room,{order:{id:'absolute',player:0,action:launch},departureTick:101.5},100,{simulation:true});
 assert.equal(planned.state.fleets.length,0);
 const executed=advanceRoom(planned,101);assert.equal(executed.state.fleets[0]!.secondsUntilLaunch,300);
 assert.equal(executed.state.commands.find(c=>c.id==='absolute')!.tick,101);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(planned.state)),planned.state);
 });
