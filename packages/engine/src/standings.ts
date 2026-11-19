import type {FleetScenario} from './fleet-scenario.js';
import {originalStandings} from './original-endgame.generated.js';
/** Read-only projection. Local seat IDs replace unavailable original account IDs only for final ties. */
export function fleetStandings(s:FleetScenario){
 const count=s.economy.players.length,teamSize=s.economy.initial.teamSize;
 const ended=s.events.find(e=>e.kind==='game-ended');
 const players=s.economy.players.map((p,seat)=>{
   const death=s.events.find(e=>(e.kind==='player-eliminated'||e.kind==='player-resigned')&&e.details.owner===seat);
   return {seat,active:p.active,deathTick:p.active?null:death?.tick??null,
     assumedDeathTime:!p.active&&!death,
     // Initial-inactive research fixtures have no death history; tie these at the initial boundary explicitly.
     timeOfDeathInSecs:p.active?-1:(death?.tick??s.initial.economy.initialTick)*600+Math.round((death?.fraction??0)*600),seatState:p.active?1:3};
 });
 const cache=s.economy.players.map((p,seat)=>{
   const owned=s.economy.outposts.filter(o=>o.owner===seat);
   return {neptunium:p.neptunium,outpostCountByType:[owned.filter(o=>!o.destroyed&&o.type==='mine').length,owned.filter(o=>!o.destroyed&&o.type==='factory').length,owned.filter(o=>!o.destroyed&&o.type==='generator').length],
     drillers:owned.reduce((sum,o)=>sum+o.drillers,0)+s.fleets.filter(f=>f.used&&f.owner===seat).reduce((sum,f)=>sum+f.drillers,0)};
 });
 const raw=originalStandings({status:ended?1:0,info:{maxPlayerCount:count,players:players.map(p=>({playerId:p.seat+1})),teamSize,noMines:s.initial.match?.mode==='domination'},
   playerStates:{get:(i:number)=>players[i]!},world:{cachedValues:{get:(i:number)=>cache[i]!}}}) as {order:number[];teams:number[];teamRanks:number[];winners:number[]};
 return {ended:!!ended,endTick:ended?.tick??null,rankingTieBreak:'local-seat-id' as const,
   winners:raw.winners,teamOrder:teamSize>0?raw.teams:[],
   players:raw.order.map((seat,index)=>({seat,rank:index+1,teamRank:teamSize>0?raw.teamRanks[seat]!+1:null,active:players[seat]!.active,deathTick:players[seat]!.deathTick,assumedDeathTime:players[seat]!.assumedDeathTime,
     neptunium:cache[seat]!.neptunium,mines:cache[seat]!.outpostCountByType[0]!,outposts:cache[seat]!.outpostCountByType[1]!+cache[seat]!.outpostCountByType[2]!,drillers:cache[seat]!.drillers}))};
}
