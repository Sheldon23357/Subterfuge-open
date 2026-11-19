import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,prepareForecastKnowledge,buildForecastWorld,projectForecastResult,type FleetSetup} from '../packages/engine/src/index.js';
import {scheduleOrder,launchSlot} from '../packages/server/src/scheduled-orders.js';
import {advanceRoom,type LabRoom} from '../packages/server/src/planning.js';
import {simulatePlayerFuture} from '../packages/server/src/player-forecast.js';
function setup():FleetSetup{
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:80,height:80};cfg.positions={own:{x:0,y:0},hidden:{x:30,y:30},visible:{x:1,y:0},power:{x:35,y:35}};
 const base=cfg.economy.outposts[0]!;
 cfg.economy.outposts=[{...base,id:'own',owner:0,drillers:100,productionProgress:47},
  {...base,id:'hidden',owner:1,drillers:199,productionProgress:47},
  {...base,id:'visible',owner:1,drillers:0,productionProgress:47},
  {...base,id:'power',owner:1,type:'generator',drillers:0,productionProgress:0}];
 return cfg;
}

test('known reservations, sparse actor slots and allocation cursors survive native forecast reconstruction',()=>{
 const cfg=setup();cfg.positions.hidden={x:2,y:0};cfg.positions.power={x:3,y:0};
 cfg.economy.outposts.forEach(o=>{o.type='generator';o.drillers=100;o.shield=0;o.shieldMax=0;});
 let state=createFleetScenario(cfg);
 // Recycled fleet history advances the cursor even though the old fleet is gone.
 for(let i=0;i<3;i++){
  state=submitFleetOrder(state,{id:`recycle-${i}`,player:0,action:{kind:'launch',delaySeconds:600,source:'own',destination:'visible',drillers:1}}).state;
  state=submitFleetOrder(state,{id:`cancel-${i}`,player:0,action:{kind:'cancel-launch',fleetId:`recycle-${i}`}}).state;
 }
 state=submitFleetOrder(state,{id:'enemy',player:1,action:{kind:'launch',delaySeconds:600,source:'hidden',destination:'own',drillers:5}}).state;
 let room:LabRoom={state,scheduled:[]};
 room=scheduleOrder(room,{order:{id:'known-reserved',player:0,action:{kind:'launch',delaySeconds:600,source:'own',destination:'visible',drillers:10}},issueTick:101});
 const k=prepareForecastKnowledge(room.state,0),built=buildForecastWorld(k);assert.equal(built.status,'conditional');if(built.status!=='conditional')return;
 assert.equal(built.state.fleets[0]!.slot,128);
 assert.deepEqual(built.state.subCounters,room.state.subCounters);
 assert.equal(built.state.fleetReservations[0]!.slot,launchSlot(room,room.scheduledOrders![0]!));
 const predicted=simulatePlayerFuture(room,0,102),actual=advanceRoom(room,102,true);
 assert.equal(predicted.status,'conditional');if(predicted.status!=='conditional')return;
 assert.deepEqual(predicted.result.fleets,projectForecastResult(k,{...actual.state,forecastPlayer:0}).fleets);
 assert.equal(predicted.orders[0]!.status,'executed');
});


// Local engine regression is deliberately independent of the optional APK oracle.
test('retained hidden economics preserve forecast rules, privacy and input immutability every tick',()=>{
 for(const phase of [0,47])for(const start of [0,72,100]){
  const cfg=setup();cfg.economy.initialTick=start;cfg.economy.outposts[1]!.productionProgress=phase;
  const live=createFleetScenario(cfg),before=JSON.stringify(live),k=prepareForecastKnowledge(live,0),built=buildForecastWorld(k);
  assert.equal(built.status,'conditional');if(built.status!=='conditional')return;
  // Match the forecast-mode economy contract: foreign capacity is unknown.
  let actual=built.state;let expected:typeof live={...live,forecastPlayer:0};
  for(let offset=1;offset<=80;offset++){
   actual=advanceFleetScenario(actual,start+offset,true);expected=advanceFleetScenario(expected,start+offset,true);
   const economy=(s:typeof actual)=>s.economy.outposts.map(o=>({type:o.type,drillers:o.drillers,shield:o.shield,productionProgress:o.productionProgress,miningProgress:o.miningProgress,shieldProgress:o.shieldProgress}));
   assert.deepEqual(economy(actual),economy(expected),`start=${start},phase=${phase},tick=${start+offset}`);
   const out=projectForecastResult(k,actual),unknown=out.outposts.find(o=>o.id==='hidden')!;
   assert.equal('owner'in unknown,true);assert.equal('drillers'in unknown,false);assert.equal('metrics'in unknown,false);
   assert.equal('retainedWorld'in out,false);
  }
  assert.equal(JSON.stringify(live),before);
 }
});
