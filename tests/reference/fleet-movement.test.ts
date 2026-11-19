import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {moveFleet} from '../../packages/engine/src/fleet-movement.js';
import {fleetSpeed,prepareFleetMovement,launchFleet,fleetMovementSegment,type FleetKinematics} from '../../packages/engine/src/index.js';
const adapter=await import(new URL('../../../scripts/reference-functions.mjs',import.meta.url).href);
test('outpost movement matches extracted mre/eF/ZD/MH across delays, speed boundary, arrival and wrapping',()=>{
  const fixtures=[];
  for(const initialTick of [0,70,72,100])for(const delay of [0,1,599,600,601,1200])for(const target of [{x:1,y:.2},{x:-9.9,y:0},{x:9.81,y:0}]){
    fixtures.push({initialTick,position:{x:9.8,y:0},target,size:{width:20,height:20},state:'waiting',secondsUntilLaunch:delay,ticks:10});
  }
  const expected=adapter.runReferenceFleetMovement(adapter.readReference(),fixtures);
  for(const [i,f]of fixtures.entries()){
    const sub:FleetKinematics={position:{...f.position},previous:{...f.position},state:'waiting',secondsUntilLaunch:f.secondsUntilLaunch,fractionMoved:0};
    const trace=[];
    for(let step=1;step<=f.ticks;step++){
      sub.previous={...sub.position};const speed=fleetSpeed(f.initialTick+step);
      prepareFleetMovement(sub,f.target,f.size,speed);const prepared=structuredClone(sub);
      const segment=fleetMovementSegment(sub,f.target,sub.position,f.size,speed);
      launchFleet(sub,f.target,f.size,speed);trace.push({prepared,segment,after:structuredClone(sub)});
    }
    // JSON normalizes original nonfinite degenerate MH segment values, not movement state.
    assert.deepEqual(JSON.parse(JSON.stringify(trace)),expected[i],`movement fixture ${i}`);
  }
});
