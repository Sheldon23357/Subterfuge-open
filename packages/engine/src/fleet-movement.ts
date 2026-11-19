import type {Point,WorldSize} from './geometry.js';
import {CLIENT_EPSILON,unwrapClientPoint,wrapClientPoint,type Segment} from './client-geometry.js';
import {startSpeedFactor} from './economy.js';

export type FleetMotion='waiting'|'launching'|'moving'|'arriving';
export interface FleetKinematics {
  position:Point;previous:Point;state:FleetMotion;secondsUntilLaunch:number;fractionMoved:number;
}
export const BASE_FLEET_SPEED=0.004999999888;
export function fleetSpeed(tick:number):number{return BASE_FLEET_SPEED*startSpeedFactor(tick);}
/** ZD, outpost target only. Vector length here is double, unlike V.getMinDist. */
export function moveFleet(f:FleetKinematics,target:Point,size:WorldSize,speed:number,fraction:number):void{
  const unwrapped=unwrapClientPoint(target,f.position,size),dx=unwrapped.x-f.position.x,dy=unwrapped.y-f.position.y;
  const length=Math.sqrt(dx*dx+dy*dy),travel=fraction*speed*10;
  if(length<=travel){f.position={...target};f.state='arriving';f.fractionMoved=length/travel;}
  else if(length>CLIENT_EPSILON){f.position=wrapClientPoint({x:f.position.x+dx/length*travel,y:f.position.y+dy/length*travel},size);f.fractionMoved=1;}
  else{f.position={...target};f.fractionMoved=0;}
}
/** mre before collection. A zero countdown stays waiting; launch event invokes launchFleet. */
export function prepareFleetMovement(f:FleetKinematics,target:Point,size:WorldSize,speed:number):void{
  if(f.state==='waiting'){
    const remaining=f.secondsUntilLaunch-600;
    if(remaining<0){f.state='launching';f.fractionMoved=-remaining/600;}else f.secondsUntilLaunch=remaining;
  }else if(f.state==='moving'){
    if(f.secondsUntilLaunch>0){
      f.secondsUntilLaunch-=600;
      if(f.secondsUntilLaunch<=0&&-f.secondsUntilLaunch/600>CLIENT_EPSILON)moveFleet(f,target,size,speed,-f.secondsUntilLaunch/600);
    }else moveFleet(f,target,size,speed,1);
  }
}
export function launchFleet(f:FleetKinematics,target:Point,size:WorldSize,speed:number,onDeparture?:()=>void):void{
  if(f.state!=='launching')return;
  f.secondsUntilLaunch=0;f.state='moving';
  // Native eF notifies before this tick's fractional movement (42541).
  onDeparture?.();
  if(f.fractionMoved>CLIENT_EPSILON)moveFleet(f,target,size,speed,f.fractionMoved);
  // eF resets this even when ZD changed the state to Arriving.
  f.fractionMoved=0;
}
/** MH expanded segment, including original launch/arrival edge behavior. */
export function fleetMovementSegment(f:FleetKinematics,target:Point,anchor:Point,size:WorldSize,speed:number):Segment{
  let a=unwrapClientPoint(f.previous,anchor,size),b=unwrapClientPoint(f.position,anchor,size);
  if(f.state==='arriving'||f.state==='launching'){
    if(f.fractionMoved<1){
      const dx=b.x-a.x,dy=b.y-a.y,length=Math.sqrt(dx*dx+dy*dy);
      if(length>CLIENT_EPSILON){
        const ux=dx/length,uy=dy/length;
        if(f.state==='arriving'){const distance=length/f.fractionMoved;b={x:a.x+ux*distance,y:a.y+uy*distance};}
        else{const distance=length*f.fractionMoved;a={x:b.x-ux*distance,y:b.y-uy*distance};}
      }
    }else{
      const destination=unwrapClientPoint(target,f.position,size),dx=destination.x-f.position.x,dy=destination.y-f.position.y,length=Math.sqrt(dx*dx+dy*dy);
      const travel=speed*10,fraction=length<=travel?length/travel:1,distance=travel/fraction;
      const ux=dx/length,uy=dy/length;
      if(f.state==='arriving')a={x:b.x-ux*distance,y:b.y-uy*distance};
      else b={x:a.x+ux*distance,y:a.y+uy*distance};
    }
  }
  return {a,b};
}
