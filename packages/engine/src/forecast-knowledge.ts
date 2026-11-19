import {originalSameTeam} from './original-scheduling.generated.js';
import {projectPlayerView,type PlayerView} from './player-view.js';
import type {FleetScenario,Fleet} from './fleet-scenario.js';
import {fleetPublicIntel} from './world-economy.js';
import {partitionForecastResources,type ForecastResourcePartition} from './forecast-resources.js';
import type {EconomicOutpost,EconomicPlayer} from './economic-scenario.js';

export type ForecastOwnFleet=Omit<Fleet,'slot'|'used'|'owner'>;
/** Server-only simulation input. Hidden fleet identities are removed; retained
 * outpost economics never leave the projection boundary as player facts. */
export interface ForecastKnowledge {
 format:'forecast-knowledge/2';view:PlayerView;
 publicIntel:ReturnType<typeof fleetPublicIntel>;
 resources:ForecastResourcePartition[];observedSeconds:number;
 ownUnits:{fleets:ForecastOwnFleet[]};
 visibleRuntime:{fleets:(ForecastOwnFleet&{owner:number})[]};
 executionOrder:{fleets:string[]};
 retainedWorld:{players:EconomicPlayer[];funding:boolean[][];
  outposts:(EconomicOutpost&{baseShieldMax:number})[];
  fleets:{id:string;slot:number}[];subCounters:number[];
  reservations:FleetScenario['fleetReservations'];};
 unknownOutposts:string[];assumptions:readonly string[];
}
export function prepareForecastKnowledge(source:FleetScenario,player:number):ForecastKnowledge{
 const view=projectPlayerView(source,player),knownFleets=new Set(view.fleets.map(f=>f.id));
 const allied=(seat:number)=>originalSameTeam(source.economy.initial.teamSize,player,seat);
 const visibleRuntime={fleets:source.fleets.filter(f=>f.used&&knownFleets.has(f.id)).map(({slot,used,...f})=>structuredClone(f))};
 const publicIntel=fleetPublicIntel(source);
 return {format:'forecast-knowledge/2',view,publicIntel,resources:partitionForecastResources(view,publicIntel),
  observedSeconds:source.secondsSinceLastTick??0,visibleRuntime,
  ownUnits:{fleets:visibleRuntime.fleets.filter(f=>f.owner===player).map(({owner,...f})=>structuredClone(f))},
  retainedWorld:{players:structuredClone(source.economy.players),funding:structuredClone(source.economy.funding),
   outposts:source.economy.outposts.map(o=>({...structuredClone(o),baseShieldMax:source.initial.economy.outposts.find(p=>p.id===o.id)!.shieldMax})),
   fleets:source.fleets.filter(f=>f.used&&knownFleets.has(f.id)).map(f=>({id:f.id,slot:f.slot})),
   subCounters:[...source.subCounters],
   reservations:source.fleetReservations.map(r=>({...r,id:allied(r.player)?r.id:`forecast-hidden-reservation-${r.slot}`}))},
  executionOrder:{fleets:source.fleets.filter(f=>f.used&&knownFleets.has(f.id)).sort((a,b)=>a.slot-b.slot).map(f=>f.id)},
  unknownOutposts:view.outposts.filter(o=>o.visibility!==2).map(o=>o.id),
  assumptions:['No unobserved enemy orders','Unseen arrivals have unknown outcomes']};
}
