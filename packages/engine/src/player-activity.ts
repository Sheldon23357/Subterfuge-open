import {exportFleetReplay,replayFleetScenario,type FleetScenario} from './fleet-scenario.js';
import {readActivity,readActivityPage,inheritNotifications,readGlobalBattleLosses,readCommandHead} from './notification-journal.js';
export function projectPlayerCommandHead(s:FleetScenario,player:number){
 projectPlayerActivity(s,player);
 // A custom mutable host may append records directly. Frozen authoritative
 // cuts use the engine-maintained head; mutable callers derive their own head.
 if(!Object.isFrozen(s.commands)){for(let i=s.commands.length-1;i>=0;i--){const c=s.commands[i]!;if(c.player===player)return{id:c.id,tick:c.tick};}return null;}
 const head=readCommandHead(s,player);return head?{...head}:null;
}
export function projectPlayerActivity(s:FleetScenario,player:number){
  if(!Number.isInteger(player)||player<0||player>=s.economy.players.length)throw Error('Invalid player');
  return activity(s,player);
}
/** Admin observer only; never exposed by the authenticated player projection. */
export function projectGlobalActivity(s:FleetScenario){return activity(s,-1);}
/** Public totals only: no global event details, coordinates or fleet identities. */
export function projectGlobalBattleLosses(s:FleetScenario){
  activity(s,-1); // Rebuild the authoritative journal after restore if necessary.
  return readGlobalBattleLosses(s,s.economy.players.length);
}
export function projectPlayerActivityPage(s:FleetScenario,player:number,after:number,through:number,limit=100){
 projectPlayerActivity(s,player); // Validate identity and reconstruct the journal after a storage restore.
 return readActivityPage(s,player,after,through,limit);
}
function activity(s:FleetScenario,player:number){
  let events=readActivity(s,player);
  if(events===null){
    const replayed=replayFleetScenario(exportFleetReplay(s),{trustedLocalStorage:true});
    inheritNotifications(replayed,s);events=readActivity(s,player)!;
  }
  return events;
}
