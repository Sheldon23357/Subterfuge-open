import {test} from 'node:test';
import assert from 'node:assert/strict';
import {basicRouteTicks} from '../packages/prediction/src/route-timing.js';
import {fleetSpeed,prepareFleetMovement,launchFleet,wrapClientPoint,type FleetKinematics} from '../packages/engine/src/index.js';

test('bounded route cache preserves exact engine kinematics across time, wrapping, preparation',()=>{
 const size={width:16,height:9};
 for(const origin of [{x:0,y:-0},{x:7.99,y:4.49},{x:4.5,y:2}])for(const point of [{x:0,y:0},{x:17,y:-2},{x:6,y:4.5}])for(const tick of [0,71,72,73,798])for(const wait of [-1,0,1,599,1200])for(const max of [1,144]){
  const target=wrapClientPoint(point,size),f:FleetKinematics={position:{...origin},previous:{...origin},state:wait<0?'moving':'waiting',secondsUntilLaunch:Math.max(0,wait),fractionMoved:0};
  let expected:number|null=null;
  for(let offset=1;offset<=max;offset++){const speed=fleetSpeed(tick+offset);prepareFleetMovement(f,target,size,speed);launchFleet(f,target,size,speed);if(f.state==='arriving'){expected=offset;break;}}
  assert.equal(basicRouteTicks(origin,point,size,tick,max,wait),expected);
  assert.equal(basicRouteTicks(origin,point,size,tick,max,wait),expected);
 }
});
