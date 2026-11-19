import type {FleetScenario} from './fleet-scenario.js';
import {fleetVisibility} from './visibility.js';
import {fleetMatchOutcome,fleetScenarioTotals,canReturnFleet} from './fleet-scenario.js';
import {commandTime} from './command-time.js';
import {canCancelFleetLaunch,departureCommitted} from './launch-window.js';
import {fleetOutpostInspector} from './outpost-statistics.js';
import {economicMineCreationCost} from './economic-scenario.js';

/** Ownership and geometry are public; garrisons and economics are sonar-bound. */
export function projectPlayerView(s:FleetScenario,player:number,postgameReplay=false){
 const deadlineLock=s.economy.tick>=(s.initial.launchCancellationLockTick??0),visibility=fleetVisibility(s,player),ended=!!fleetMatchOutcome(s),fullMapVisible=ended||postgameReplay;
 if(fullMapVisible){for(const p of s.economy.outposts)visibility.outposts[p.id]=2;for(const f of s.fleets)visibility.fleets[f.id]=2;}
 const totals=fleetScenarioTotals(s)[player]!,phase=s.secondsSinceLastTick??0,inspect=fleetOutpostInspector(s);
 return {
  format:'player-observation/2' as const,profile:s.profile,player,tick:s.economy.tick,...s.initial.launchCancellationLockTick===undefined?{}:{launchCancellationLockTick:s.initial.launchCancellationLockTick},
  size:{...s.initial.size},sonar:visibility.areas,fullMapVisible,playerCount:s.economy.players.length,teamSize:s.economy.initial.teamSize,match:s.initial.match?{...s.initial.match,ended}:null,
  self:{mineCreationCost:economicMineCreationCost(s.economy,player),neptunium:s.economy.players[player]!.neptunium,active:s.economy.players[player]!.active,drillers:totals.drillers,capacity:totals.capacity,outpostCount:totals.outposts,funding:[...s.economy.funding[player]!],...s.activity?{activity:{...s.activity[player]!}}:{}},
  outposts:s.economy.outposts.map(o=>{
   const level=visibility.outposts[o.id]!,base={id:o.id,position:{...s.initial.positions[o.id]!},visibility:level,owner:o.owner};if(level===0)return base;
   if(level===1)return {...base,type:o.type,destroyed:o.destroyed??false};
   const typeValue=commandTime.outpostType({private_type:o.type==='mine'?0:o.type==='factory'?1:2,private_secsUntilMineCreation:o.minePending?(o.mineSeconds??600):0},phase),type:typeof o.type=typeValue===0?'mine':typeValue===1?'factory':'generator';
   return {...base,type,destroyed:o.destroyed??false,drillers:o.drillers,shield:o.shield,shieldMax:o.shieldMax,shieldsEnabled:o.shieldsEnabled,minePending:o.minePending,mineRemainingSeconds:Number(commandTime.mining({private_secsUntilMineCreation:o.minePending?(o.mineSeconds??600):0},phase)),shieldDisablePending:o.shieldDisablePending,shieldDisableRemainingSeconds:commandTime.shieldRemaining({secsUntilShieldDisable:o.shieldDisablePending?(o.shieldDisableSeconds??600):0},phase),metrics:inspect(o.id)};
  }),
  fleets:s.fleets.filter(f=>f.used&&visibility.fleets[f.id]===2).map(f=>({id:f.id,owner:f.owner,position:{...f.position},drillers:f.drillers,state:f.state,departureCommitted:departureCommitted(f,phase,deadlineLock),gift:commandTime.gift({private_isGift:f.gift,secsUntilGifting:f.giftSeconds},phase),destination:{kind:'outpost' as const,id:f.destination},...f.owner===player?{secondsUntilLaunch:f.secondsUntilLaunch,source:f.source,returned:!!f.returned,canReturn:canReturnFleet(f),launchRemainingSeconds:Math.max(0,commandTime.launchRemaining({state:f.state,secsUntilLaunch:f.secondsUntilLaunch},phase)),giftPendingSeconds:Math.max(0,f.giftSeconds-phase),canCancelLaunch:canCancelFleetLaunch(f,phase,deadlineLock)}:{}})),
 };
}
export type PlayerView=ReturnType<typeof projectPlayerView>;
