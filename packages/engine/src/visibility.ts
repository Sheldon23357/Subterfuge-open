import type {FleetScenario} from './fleet-scenario.js';
import {clientDistanceSquared} from './client-geometry.js';
import {RULES} from '../../rules/src/index.js';
import type {Point} from './geometry.js';

export function fleetOutpostSonarRange(_s:FleetScenario,_id:string){return RULES.OutpostParams.VisibilityRange;}
/** Visibility is determined only by owned/team outposts and actual geometry.
 * A visible incoming route to an owned outpost remains observable in transit. */
export function fleetVisibility(s:FleetScenario,player:number){
 if(!Number.isInteger(player)||player<0||player>=s.economy.players.length)throw Error('Invalid player');
 const team=s.economy.initial.teamSize,allied=(owner:number|null)=>owner!==null&&(team>0?Math.floor(owner/team)===Math.floor(player/team):owner===player);
 const areas=s.economy.outposts.filter(o=>allied(o.owner)&&!o.destroyed).map(o=>({center:{...s.initial.positions[o.id]!},radius:fleetOutpostSonarRange(s,o.id)}));
 const visible=(p:Point)=>areas.some(a=>clientDistanceSquared(a.center,p,s.initial.size)<=a.radius*a.radius);
 return {areas,outposts:Object.fromEntries(s.economy.outposts.map(o=>[o.id,allied(o.owner)||visible(s.initial.positions[o.id]!)?2:0])),
  fleets:Object.fromEntries(s.fleets.filter(f=>f.used).map(f=>[f.id,allied(f.owner)||visible(f.position)||f.state==='moving'&&allied(s.economy.outposts.find(o=>o.id===f.destination)?.owner??null)?2:0]))};
}
