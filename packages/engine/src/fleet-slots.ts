import type {FleetScenario} from './fleet-scenario.js';
import {originalNextFleetSlot,originalReserveFleetSlot} from './original-scheduling.generated.js';
export function isFleetSlotReserved(s:FleetScenario,slot:number){return s.fleetReservations.some(r=>r.slot===slot);}
function context(s:FleetScenario){
  let reserved=-1;
  return {get reserved(){return reserved;},
    playerStates:{get:(player:number)=>({get subCounter(){return s.subCounters[player]!;},set subCounter(v:number){s.subCounters[player]=v;}})},
    world:{subs:{get:(slot:number)=>({get used(){return s.fleets.some(f=>f.used&&f.slot===slot);},get reserved(){return isFleetSlotReserved(s,slot);},set reserved(value:boolean){if(value)reserved=slot;}})}},
  };
}
export function nextFleetSlot(s:FleetScenario,player:number){return originalNextFleetSlot(context(s),player) as number;}
export function reserveFleetSlot(s:FleetScenario,player:number,id:string){
  if(s.fleetReservations.some(r=>r.id===id)||s.commands.some(c=>c.id===id))throw Error('Reservation id conflict');
  const n=context(s),slot=originalReserveFleetSlot(n,player) as number;
  if(slot<0)throw Error('No fleet slot available');
  if(n.reserved!==slot)throw Error('Reservation bridge mismatch');
  s.fleetReservations.push({id,player,slot});return slot;
}
