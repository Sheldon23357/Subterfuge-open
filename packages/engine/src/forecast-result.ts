import {fleetMatchOutcome,type FleetScenario} from './fleet-scenario.js';
import type {ForecastKnowledge} from './forecast-knowledge.js';
import {projectPlayerView} from './player-view.js';

/** Projection of the server's original pruned world, never its raw retained
 * outposts/caches. Unknown outposts remain unknown even if projected sonar
 * reaches them. Own totals and victory describe this conditional future.
 */
export function projectForecastResult(knowledge:Pick<ForecastKnowledge,'view'|'unknownOutposts'|'observedSeconds'|'assumptions'>,state:FleetScenario){
 const player=knowledge.view.player;
 if(state.forecastPlayer!==player||state.profile!==knowledge.view.profile||state.economy.tick<knowledge.view.tick)throw Error('Forecast perspective mismatch');
 const view=projectPlayerView(state,player);
 const unknown=new Set([...knowledge.unknownOutposts,...state.economy.outposts.filter(o=>o.futureUnknown).map(o=>o.id)]);
 const outposts=view.outposts.map(o=>{
  if(!unknown.has(o.id))return o;
  const observed=knowledge.view.outposts.find(p=>p.id===o.id);
  // Original renderOutposts uses PRESENT owner for futureUnknown nodes (ge/Ae,
  // index-DgdyVR_2.js:35045). Retained future ownership is not a confirmed capture.
  const publicOwner=observed?{owner:observed.owner}:{};
  if(observed&&observed.visibility===1&&'type'in observed)return{id:o.id,position:{...o.position},visibility:1,...publicOwner,type:observed.type,destroyed:observed.destroyed};
  return{id:o.id,position:{...o.position},visibility:0,...publicOwner};
 });
 const unknownArrivals=state.events.filter(e=>e.kind==='future-unknown-arrival'&&e.details.owner===player)
  .map(e=>({fleetId:e.subject,outpostId:String(e.details.outpost),tick:e.tick,fraction:e.fraction,outcome:'unknown' as const}));
 const uncertainPlayers=state.events.filter(e=>e.kind==='future-unknown-arrival').map(e=>Number(e.details.owner));
 const terminal=state.forecastTerminal;
 const terminalPrediction=terminal?{
  status:(terminal.reasons.length?(terminal.firstCrossing?'conditional':'unknown'):'determinate') as 'determinate'|'conditional'|'unknown',
  firstCrossing:terminal.firstCrossing??null,reasons:[...terminal.reasons],stoppedAtCrossing:!!terminal.firstCrossing,
 }:undefined;
 return{...(terminalPrediction?{terminalPrediction}:{}),format:'player-forecast/2' as const,player,profile:state.profile,
  observedAt:{tick:knowledge.view.tick,seconds:knowledge.observedSeconds},targetTick:state.economy.tick,
  certainty:'conditional' as const,assumptions:[...knowledge.assumptions,
   ...(terminal?['Terminal crossing uses the shared end-condition rule at the original tick boundary; determinate means within known-world assumptions only', 'An incomplete-world crossing is conditional: hidden events may end the match earlier; resources and orders stop at the crossing']:state.forecastVictoryEnabled?['Victory follows the original pruned world, assuming no unobserved orders']:['Victory prediction is unavailable for this research world']),
   'Unknown arrivals do not establish destruction, capture, ownership or survivors'],
  size:{...view.size},sonar:view.sonar.map(a=>({center:{...a.center},radius:a.radius})),playerCount:view.playerCount,teamSize:view.teamSize,
  outposts,fleets:view.fleets,self:view.self,
  ...(state.forecastVictoryEnabled?{match:{...state.initial.match!,ended:fleetMatchOutcome(state)}}:terminalPrediction?.status==='determinate'?{match:{...state.initial.match!,ended:terminal?.firstCrossing?{ended:true,...terminal.firstCrossing}:null}}:{}),
  unknownArrivals,uncertainPlayers:[...new Set(uncertainPlayers)]};
}
