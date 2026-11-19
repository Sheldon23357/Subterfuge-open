import type {PlayerView} from './player-view.js';
import type {PublicIntelStatistics} from './world-economy.js';

export interface ForecastResourcePartition {
 player:number;
 /** These are public totals, not hidden entity records or inferred positions. */
 publicDrillers:number;
 locatedDrillers:number;
 unlocatedDrillers:number|null;
 unlocatedOutposts:{mine:number;factory:number;generator:number}|null;
 uncertainties:('unlocated-armies'|'unlocated-outposts'|'inconsistent-public-totals')[];
}
/** Preserve public aggregates without inventing hidden units or assigning them
 * to unknown bases. Input is restricted knowledge only, never FleetScenario.
 * Original Ms calculates totals independently of the fog; lye publishes them.
 */
export function partitionForecastResources(view:PlayerView,intel:readonly ({player:number}&PublicIntelStatistics)[]):ForecastResourcePartition[]{
 return intel.map(row=>{
  const known=view.outposts.filter((o):o is Extract<PlayerView['outposts'][number],{drillers:number}>=>o.visibility===2&&'drillers' in o&&o.owner===row.player);
  const locatedDrillers=known.reduce((sum,o)=>sum+o.drillers!,0)+view.fleets.filter(f=>f.owner===row.player).reduce((sum,f)=>sum+f.drillers,0);
  const counts={mine:0,factory:0,generator:0};
  for(const o of known)if(!o.destroyed&&o.type)counts[o.type]++;
  const remainder={mine:row.outposts.mine-counts.mine,factory:row.outposts.factory-counts.factory,generator:row.outposts.generator-counts.generator};
  const mismatch=Object.values(remainder).some(n=>n<0),drillers=row.drillers-locatedDrillers;
  const uncertainties:ForecastResourcePartition['uncertainties']=[];
  if(drillers>0)uncertainties.push('unlocated-armies');
  if(mismatch||drillers<0)uncertainties.push('inconsistent-public-totals');
  else if(Object.values(remainder).some(n=>n>0))uncertainties.push('unlocated-outposts');
  return {player:row.player,publicDrillers:row.drillers,locatedDrillers,
   unlocatedDrillers:drillers<0?null:drillers,unlocatedOutposts:mismatch?null:remainder,uncertainties};
 });
}
