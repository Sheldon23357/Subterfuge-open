import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,previewFleetLaunchSpeed,fleetScenarioSpeed,type FleetSetup,type FleetOrder} from '../packages/engine/src/index.js';
function fixture(){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;

 return createFleetScenario(c);
}
 test('scalar launch preview matches command execution without changing caller state',()=>{
  const state=fixture();
  for(const seconds of [0,599]){
   const order:FleetOrder={id:'launch',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:1,}};
   const before=structuredClone(state),expected=submitFleetOrder(state,order,seconds).state,fleet=expected.fleets.find(f=>f.used)!;
   assert.deepEqual(previewFleetLaunchSpeed(state,order,seconds),{speed:fleetScenarioSpeed(expected,fleet),secondsUntilLaunch:fleet.secondsUntilLaunch});
   assert.deepEqual(state,before);
  }
 });

test('scalar preview preserves waiting route edits, commitment rejection and immutable history',()=>{
 let state=fixture();
 for(let i=0;i<12;i++)state=submitFleetOrder(state,{id:'history-'+i,player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:10,delaySeconds:1200,}}).state;
 const initial:FleetOrder={id:'old',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:10,delaySeconds:1200,}};
 state=submitFleetOrder(state,initial).state;
 const order:FleetOrder={id:'edit',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:15,}},before=structuredClone(state);
 const expected=submitFleetOrder(state,order,599).state,fleet=expected.fleets.find(f=>f.used)!;
 assert.deepEqual(previewFleetLaunchSpeed(state,order,599),{speed:fleetScenarioSpeed(expected,fleet),secondsUntilLaunch:fleet.secondsUntilLaunch});
 const invalid:FleetOrder={...order,id:'invalid',action:{...order.action,kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:9999}};
 assert.throws(()=>submitFleetOrder(state,invalid),/Insufficient/);assert.throws(()=>previewFleetLaunchSpeed(state,invalid),/Insufficient/);
 assert.deepEqual(state,before);
});
