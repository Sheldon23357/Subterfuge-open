import {createFleetScenario,type FleetScenario,type FleetSetup} from './fleet-scenario.js';
import type {ForecastKnowledge} from './forecast-knowledge.js';

export type ForecastWorldResult=
 |{status:'unsupported';reasons:string[]}
 |{status:'conditional';state:FleetScenario;assumptions:string[]};

/** Only projectForecastResult may expose this server-only simulation. Hidden
 * outposts stay marked unknown even when future sonar reaches their positions. */
export function buildForecastWorld(input:ForecastKnowledge):ForecastWorldResult{
 const k=structuredClone(input),v=k.view,player=v.player,reasons:string[]=[];
 if(v.match?.ended)reasons.push('match-ended');
 if(k.resources.some(r=>r.uncertainties.includes('inconsistent-public-totals')))reasons.push('inconsistent-public-totals');
 if(reasons.length)return {status:'unsupported',reasons};
 const setup:FleetSetup={size:{...v.size},positions:Object.fromEntries(v.outposts.map(o=>[o.id,{...o.position}])),
  economy:{initialTick:v.tick,teamSize:v.teamSize,players:structuredClone(k.retainedWorld.players),
   outposts:k.retainedWorld.outposts.map(({baseShieldMax,mineSeconds,shieldDisableSeconds,futureUnknown,...o})=>
    ({...o,shieldMax:baseShieldMax,minePending:false,shieldDisablePending:false}))}};
 const state=createFleetScenario(setup);
 state.forecastPlayer=player;
 if(v.match){const {ended,...match}=v.match;state.initial.match=match;state.forecastVictoryEnabled=true;}
 if(v.self.activity)state.forecastActivity={player,value:structuredClone(v.self.activity)};
 state.subCounters=[...k.retainedWorld.subCounters];
 state.fleetReservations=structuredClone(k.retainedWorld.reservations);
 state.economy.funding=structuredClone(k.retainedWorld.funding);
 state.fleets=k.visibleRuntime.fleets.map(f=>({...structuredClone(f),used:true,slot:k.retainedWorld.fleets.find(p=>p.id===f.id)!.slot}));
 state.secondsSinceLastTick=0;state.economy.secondsSinceLastTick=0;
 state.economy.outposts=k.retainedWorld.outposts.map(({baseShieldMax,...o})=>({...o,...(k.unknownOutposts.includes(o.id)?{futureUnknown:true}:{})}));
 return {status:'conditional',state,assumptions:[...k.assumptions,
  'Unknown outpost economics are retained only inside the server simulation',
  'Allocation slots, counters and reserved slots are retained internally',
  'Victory assumes no unobserved orders or unresolved hidden outcomes']};
}
