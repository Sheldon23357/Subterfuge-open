import {fleetSpeed,prepareFleetMovement,launchFleet,wrapClientPoint,type FleetKinematics} from '../../engine/src/index.js';
import type {PlayerObservation} from '../../contracts/src/index.js';
const routeCache=new Map<string,number|null>();

/** Public geometry estimate, never an authoritative arrival or safety claim. */
export function previewKnownRoute(observation:PlayerObservation,input:{source:string;point:{x:number;y:number};issueTick:number}){
 const source=observation.view.outposts.find(p=>p.id===input.source);
 if(!source||!Number.isSafeInteger(input.issueTick)||input.issueTick<observation.view.tick||input.issueTick>observation.view.tick+1440||!input.point||!Number.isFinite(input.point.x)||!Number.isFinite(input.point.y))throw Error('Invalid authorized route');
 const offset=basicRouteTicks(source.position,input.point,observation.view.size, input.issueTick,1440);
 return{roomId:observation.roomId,revision:observation.revision,arrivalTick:offset===null?null:input.issueTick+offset,minutes:offset===null?null:offset*10};
}

/** Shared ordinary-speed route estimate. Uses only public geometry and game time;
 * does not model hidden units, combat, or future commands. */
export function basicRouteTicks(origin:{x:number;y:number},point:{x:number;y:number},size:{width:number;height:number},issueTick:number,maxTicks:number,waitingSeconds=0):number|null {
  const target=wrapClientPoint(point,size);
  // Pure kinematics only: no ownership, resources, visibility or speculative
  // action result is cached. Preserve exact numbers, including signed zero.
  const values=[origin.x,origin.y,target.x,target.y,size.width,size.height,issueTick,maxTicks,waitingSeconds];
  const key=values.every(Number.isFinite)?JSON.stringify(values.map(n=>Object.is(n,-0)?'-0':n)):null;
  if(key!==null&&routeCache.has(key)){const value=routeCache.get(key)!;routeCache.delete(key);routeCache.set(key,value);return value;}
  const finish=(ticks:number|null)=>{if(key!==null){routeCache.set(key,ticks);if(routeCache.size>8192)routeCache.delete(routeCache.keys().next().value!);}return ticks;};
  const f:FleetKinematics={position:{...origin},previous:{...origin},state:waitingSeconds<0?'moving':'waiting',secondsUntilLaunch:Math.max(0,waitingSeconds),fractionMoved:0};
  for(let offset=1;offset<=maxTicks;offset++){
    const speed=fleetSpeed(issueTick+offset);
    prepareFleetMovement(f,target,size,speed);
    launchFleet(f,target,size,speed);
    if(f.state==='arriving')return finish(offset);
  }
  return finish(null);
}
