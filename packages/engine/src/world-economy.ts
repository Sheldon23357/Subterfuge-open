import type {FleetScenario} from './fleet-scenario.js';
import {economicTotals} from './economic-scenario.js';
import {factoryPeriodTicks,productionAmount,startSpeedFactor} from './economy.js';
import {TICKS_PER_DAY} from '../../rules/src/index.js';
import {outpostTypeAtPhase} from './command-time.js';

export interface PublicIntelStatistics {
 active:boolean;neptunium:number;npPerDay:number;
 outposts:{mine:number;generator:number;factory:number};numOutposts:number;
 drillers:number;output:number;drillerRate:number;
}
/** Public aggregates include all owned fleets, never their hidden positions. */
export function fleetPublicIntel(s:FleetScenario):({player:number}&PublicIntelStatistics)[]{
 const phase=s.secondsSinceLastTick??0,totals=economicTotals(s.economy,s.economy.players.map((_,i)=>s.fleets.filter(f=>f.used&&f.owner===i).reduce((n,f)=>n+f.drillers,0)),phase);
 return s.economy.players.map((p,player)=>{
  const owned=s.economy.outposts.filter(o=>o.owner===player&&!o.destroyed),outposts={mine:0,generator:0,factory:0},t=totals[player]!;
  for(const o of owned)outposts[outpostTypeAtPhase(o,phase)]++;
  const amount=productionAmount({funders:t.funders,currentDrillers:0,capacity:Number.MAX_SAFE_INTEGER});
  return {player,active:p.active,neptunium:p.neptunium,npPerDay:p.active?outposts.mine*owned.length:0,outposts,numOutposts:owned.length,drillers:t.drillers,output:t.capacity,
   drillerRate:outposts.factory*amount*TICKS_PER_DAY*startSpeedFactor(s.economy.tick)/factoryPeriodTicks()};
 });
}
