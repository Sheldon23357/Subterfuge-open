import {exportFleetReplay,replayFleetScenario,fleetMatchOutcome,type FleetScenario} from './fleet-scenario.js';
import {projectPlayerView} from './player-view.js';
import {commandSeconds} from './command-time.js';
import {fleetPublicIntel} from './world-economy.js';
/** Rebuild authority internally, return only the seat's historical view.
 * Timestamp is inclusive of commands at that second, preserving log order.
 * This never exposes replay commands or substitutes current sonar for past sonar.
 * Original hE reveals every historical entity once the PRESENT game has ended.
 */
export function projectPlayerHistory(state:FleetScenario,player:number,tick:number,seconds=0,presentSeconds=state.secondsSinceLastTick??0){
 commandSeconds(seconds);commandSeconds(presentSeconds,state.secondsSinceLastTick??0);
 if(!Number.isInteger(player)||player<0||player>=state.economy.players.length)throw Error('Invalid player');
 if(!Number.isSafeInteger(tick)||tick<state.initial.economy.initialTick||tick>state.economy.tick||tick===state.economy.tick&&seconds>presentSeconds)throw Error('Invalid history time');
 const replay=exportFleetReplay(state);
 replay.commands=replay.commands.filter(c=>c.tick<tick||c.tick===tick&&(c.seconds??0)<=seconds);replay.targetTick=tick;
 if(replay.phaseSettlements)replay.phaseSettlements=replay.phaseSettlements.filter(p=>p.afterCommand<=replay.commands.length&&(p.tick<tick||p.tick===tick&&p.seconds<=seconds));
 delete replay.targetSeconds;
 const past=replayFleetScenario(replay,{trustedLocalStorage:true});
 if(past.economy.tick!==tick)throw Error('History time is after game end');
 past.secondsSinceLastTick=seconds;
 return {format:'player-history/1' as const,tick,secondsSinceLastTick:seconds,view:projectPlayerView(past,player,!!fleetMatchOutcome(state)),intel:fleetPublicIntel(past)};
}
