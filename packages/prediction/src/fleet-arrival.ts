import { createFleetReplaySession, exportFleetReplay, fleetMatchOutcome } from '../../engine/src/index.js';
import { advanceLabBranch, type LabPredictionRoom } from './lab-branch.js';

export interface FleetArrivalEstimate {
  fleetId:string;
  arrivalTick:number|null;
  /** Absolute game seconds; display clocks can advance without rerunning a forecast. */
  arrivalSeconds:number|null;
  status:'estimated'|'unknown';
}
export const unknownFleetArrival=(fleetId:string):FleetArrivalEstimate=>({fleetId,arrivalTick:null,arrivalSeconds:null,status:'unknown'});

/** Only the selected fleet is a stopping condition. Other fleets,
 * combat and appointments remain in the branch and keep their normal effects. */
export function* labFleetArrivalSteps(initial:LabPredictionRoom,fleetId:string,atTick=initial.state.economy.tick):Generator<void,FleetArrivalEstimate> {
  if(!Number.isInteger(atTick)||atTick<initial.state.initial.economy.initialTick||atTick>initial.state.economy.tick+1440)throw Error('Invalid arrival frame');
  let room=initial;
  if(atTick<initial.state.economy.tick){
    const history=createFleetReplaySession(exportFleetReplay(initial.state),{trustedLocalStorage:true});
    history.begin(atTick);
    while(!history.step(8))yield;
    // Historical forecasts start with the commands actually issued by this time;
    // later real commands are not fed into the prediction.
    room={state:history.snapshot(),scheduled:[],...(initial.map?{map:initial.map}:{})};
  }else{
    while(room.state.economy.tick<atTick&&!fleetMatchOutcome(room.state)){
      room=advanceLabBranch(room,Math.min(atTick,room.state.economy.tick+1),true);yield;
    }
  }
  const fleet=room.state.fleets.find(f=>f.used&&f.id===fleetId);
  if(!fleet||room.state.economy.tick!==atTick)return unknownFleetArrival(fleetId);
  const destination=fleet.destination;
  for(let tick=atTick+1;tick<=Math.min(1e7,atTick+288);tick++){
    if(fleetMatchOutcome(room.state))break;
    const first=room.state.events.length;
    room=advanceLabBranch(room,tick,true);
    const arrival=room.state.events.slice(first).find(e=>e.subject===fleetId&&
      (e.kind==='unloaded'&&e.details.outpost===destination||e.kind==='battle'&&e.details.target===destination));
    if(arrival)return {fleetId,arrivalTick:arrival.tick,arrivalSeconds:(arrival.tick-1+arrival.fraction)*600,status:'estimated'};
    if(!room.state.fleets.some(f=>f.used&&f.id===fleetId))break;
    yield;
  }
  return unknownFleetArrival(fleetId);
}
