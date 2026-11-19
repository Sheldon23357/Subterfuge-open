import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,saveFleetSnapshot,type FleetSetup,type FleetScenario} from '../packages/engine/src/index.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {prepareForecastKnowledge} from '../packages/engine/src/forecast-knowledge.js';
import {buildForecastWorld} from '../packages/engine/src/forecast-world.js';
import {simulatePlayerFuture} from '../packages/server/src/player-forecast.js';
function setup(){
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.match={mode:'mining',neptuniumGoal:200};cfg.economy.initialTick=96;
 const s=createFleetScenario(cfg);
 s.activity![0]={lastCheckinTime:0,inactivityWarningCount:1,autoResigned:false};
 s.secondsSinceLastTick=590;return s;
}
test('restricted activity restores only self and reuses original check-in versus dismiss semantics',()=>{
 const live=setup(),knowledge=prepareForecastKnowledge(live,0),built=buildForecastWorld(knowledge);
 assert.equal(built.status,'conditional');if(built.status!=='conditional')return;
 assert.equal(built.state.activity,undefined);
 assert.deepEqual(built.state.forecastActivity,{player:0,value:live.activity![0]});
 for(const kind of ['check-in','cancel-inactivity-warning'] as const){
  const order={id:kind,player:0,action:{kind}},real=submitFleetOrder(live,order,590).state;
  const predicted:FleetScenario=submitFleetOrder(built.state,order,590).state;
  assert.deepEqual(predicted.forecastActivity!.value,real.activity![0]);
  assert.equal(predicted.forecastActivity!.value.lastCheckinTime,58190);
  const future=advanceFleetScenario(predicted,97,true),reference=advanceFleetScenario(real,97,true);
  assert.deepEqual(future.forecastActivity!.value,reference.activity![0]);
 }
 const hidden=structuredClone(live);hidden.activity![1]!.lastCheckinTime=99999;hidden.activity![1]!.inactivityWarningCount=4;
 assert.deepEqual(prepareForecastKnowledge(hidden,0),knowledge);
 const future=advanceFleetScenario(built.state,288,true);
 assert.equal(future.economy.players[0]!.active,true);
 assert.ok(future.forecastActivity!.value.inactivityWarningCount>1);
 assert.ok(future.events.filter(e=>e.kind==='inactivity-warning').every(e=>e.details.owner===0));
 assert.throws(()=>saveFleetSnapshot(future),/Prediction/);
 delete future.forecastPlayer;assert.throws(()=>saveFleetSnapshot(future),/Prediction/);
 assert.deepEqual(live.activity![0],{lastCheckinTime:0,inactivityWarningCount:1,autoResigned:false});
});
test('present and future own activity drafts execute without mutating live activity',()=>{
 const state=setup(),room={state,scheduled:[]},before=JSON.stringify(room);
 const result=simulatePlayerFuture(room,0,97,[
  {id:'present',player:0,issueTick:96,action:{kind:'check-in'}},
  {id:'future',player:0,issueTick:97,action:{kind:'cancel-inactivity-warning'}},
 ]);
 assert.equal(result.status,'conditional');if(result.status==='conditional')assert.deepEqual(result.orders.map(p=>p.status),['executed','executed']);
 assert.equal(JSON.stringify(room),before);
});
test('unknown teammate activity is not invented for a known scheduled check-in',()=>{
 // Four seats keep a second team alive; two seats on one team now correctly
 // end at the first native terminal check before this action can execute.
 const cfg=structuredClone(setup().initial);cfg.economy.teamSize=2;
 cfg.economy.players.push(...structuredClone(cfg.economy.players));
 for(const player of [2,3]){
  const id=`opponent-${player}`;cfg.positions[id]={x:player,y:1};
  cfg.economy.outposts.push({...cfg.economy.outposts[0]!,id,owner:player});
 }
 const state=createFleetScenario(cfg);
 const room=scheduleOrder({state,scheduled:[]},{order:{id:'team-check',player:1,action:{kind:'check-in'}},issueTick:97});
 assert.deepEqual(simulatePlayerFuture(room,0,97),{status:'unsupported',reasons:['scheduled-activity-unknown']});
});
