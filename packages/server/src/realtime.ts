import {fleetMatchOutcome,settleFleetScenarioPhase} from '../../engine/src/index.js';
import {advanceRoom,type LabRoom} from './planning.js';
import {REALTIME_TICK_MILLISECONDS} from '../../rules/src/index.js';
/** One world day takes 10 wall seconds; the engine still uses 600 rule seconds. */
export const TICK_MILLISECONDS=REALTIME_TICK_MILLISECONDS;
export interface RealtimeClock {format:'realtime-clock/1';anchorMs:number;anchorTick:number;tickMilliseconds?:number}
/** Exact clock inputs; callers need not reconstruct a complete world to read time. */
export interface RoomClockBasis {clock?:RealtimeClock;state:{economy:{tick:number};secondsSinceLastTick?:number}}
export function tickMilliseconds(room:RoomClockBasis){return room.clock?.tickMilliseconds??TICK_MILLISECONDS;}
export function validateClock(value:unknown,currentTick:number):RealtimeClock{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid clock');
  const c=value as Record<string,unknown>;
  if(Object.keys(c).length!==(c.tickMilliseconds===undefined?3:4)||Object.keys(c).some(k=>!['format','anchorMs','anchorTick','tickMilliseconds'].includes(k))||c.tickMilliseconds!==undefined&&(!Number.isInteger(c.tickMilliseconds)||Number(c.tickMilliseconds)<1000||Number(c.tickMilliseconds)>3600000)||c.format!=='realtime-clock/1'||!Number.isSafeInteger(c.anchorMs)||Number(c.anchorMs)<0||!Number.isSafeInteger(c.anchorTick)||Number(c.anchorTick)<0||Number(c.anchorTick)>currentTick)throw Error('Invalid clock');
  return {format:'realtime-clock/1',anchorMs:Number(c.anchorMs),anchorTick:Number(c.anchorTick),...(c.tickMilliseconds===undefined?{}:{tickMilliseconds:Number(c.tickMilliseconds)})};
}
export function startRealtime(room:LabRoom,now:number):LabRoom{
  if(room.clock)return room;
 if(room.timing?.mode==='turn-based')throw Error('Turn-based room cannot start a realtime clock');
  return {...room,clock:validateClock({format:'realtime-clock/1',anchorMs:now,anchorTick:room.state.economy.tick,...(room.timing?.mode==='realtime'?{tickMilliseconds:room.timing.tickSeconds*1000}:{})},room.state.economy.tick)};
}
export function realtimeTarget(room:RoomClockBasis,now:number):number{
  if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid wall time');
  if(!room.clock)return room.state.economy.tick;
  const c=validateClock(room.clock,room.state.economy.tick);
  const target=Math.max(room.state.economy.tick,c.anchorTick+Math.floor((now-c.anchorMs)/tickMilliseconds(room)));
  if(target>1e7)throw Error('Clock exceeds supported tick range');
  return target;
}
/** Offline catch-up executes only the saved world and existing scheduled commands.
 * No player or AI action is synthesized. Yield between batches for host responsiveness.
 */
export async function catchUpRealtime(room:LabRoom,now:number):Promise<LabRoom>{
  const target=realtimeTarget(room,now);
  if(fleetMatchOutcome(room.state))return room;
  let next=room;
  while(next.state.economy.tick<target&&!fleetMatchOutcome(next.state)){
    next=advanceRoom(next,Math.min(target,next.state.economy.tick+144));
    if(next.state.economy.tick<target)await new Promise<void>(resolve=>setImmediate(resolve));
  }
  const seconds=realtimeSeconds(next,now),time=next.state.economy.tick+seconds/600;
  if(next.state.diplomacy.agreements.some(a=>['proposed','active'].includes(a.status)&&a.deadline<=time))next={...next,state:settleFleetScenarioPhase(next.state,seconds)};
  return next;
}

/** Whole-second phase used by original command countdowns; captured at request sync. */
export function realtimeSeconds(room:RoomClockBasis,now:number):number{
  const previous=room.state.secondsSinceLastTick??0;
  if(!room.clock)return previous;
  const target=realtimeTarget(room,now);
  if(target!==room.state.economy.tick)return previous;
  const elapsed=(now-room.clock.anchorMs)*600/tickMilliseconds(room)-(room.state.economy.tick-room.clock.anchorTick)*600;
  return Math.max(previous,Math.min(599,Math.max(0,Math.floor(elapsed))));
}
