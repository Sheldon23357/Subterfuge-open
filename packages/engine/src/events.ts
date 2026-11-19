import {integer,nonnegative} from './numeric.js';
export interface MovementEvent {
  type:'launch'|'arrival'|'collision'; subIndex:number; timeFraction:number;
  destination:{type:'outpost'|'sub'|'none';index:number}; otherSubIndex?:number;
}
/** ES stable sorting is intentional: equal keys preserve original collection order. */
export function orderMovementEvents<T extends MovementEvent>(events:readonly T[]):T[] {
  for(const event of events){integer(event.subIndex,'subIndex');nonnegative(event.timeFraction,'timeFraction');}
  // Do not clamp >1 here: original RH upper-bound check inspects its old zero value.
  return [...events].sort((a,b)=>a.timeFraction-b.timeFraction||a.subIndex-b.subIndex);
}
export interface CollisionSub {used:boolean;destination:{type:'outpost'|'sub'|'none';index:number}}
/** Original f3e invalidation/duplicate checks; combat and gifting follow only after this guard. */
export function canProcessCollision(event:MovementEvent,subs:ReadonlyMap<number,CollisionSub>):boolean {
  if(event.type!=='collision'||event.otherSubIndex===undefined)return false;
  const sub=subs.get(event.subIndex),other=subs.get(event.otherSubIndex);
  if(!sub?.used||!other?.used)return false;
  if(event.destination.type!=='none'&&(sub.destination.type!==event.destination.type||sub.destination.index!==event.destination.index))return false;
  if(sub.destination.type==='outpost'&&event.otherSubIndex<event.subIndex)return false;
  if(sub.destination.type==='sub'&&event.otherSubIndex<event.subIndex&&other.destination.type==='sub'&&other.destination.index===event.subIndex)return false;
  return true;
}
