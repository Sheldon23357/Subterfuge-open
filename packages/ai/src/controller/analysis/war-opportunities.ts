import type {AttackRoutes,PlayerObservation} from '../../../../contracts/src/index.js';

/** Outreach leads, never allied orders or additional spendable soldiers. Include
 * opponents omitted by the solo-attack ranking when every source is reserved. */
export function warOpportunities(o:PlayerObservation,routes:AttackRoutes,options:{attackTicks:number;leader:number|undefined}){
  const v=o.view,posts=v.outposts.filter(p=>!p.destroyed);
  const active=(player:number)=>o.intel.find(i=>i.player===player)?.active!==false;
  const own=posts.filter(p=>p.owner===v.player);
  const ownIds=new Set(own.map(p=>p.id));
  const players=[...new Set(posts.flatMap(p=>typeof p.owner==='number'&&p.owner!==v.player&&active(p.owner)?[p.owner]:[]))];
  const eta=(source:string,target:string)=>routes.postTicks[source]?.[target]??null;
  return players.map(opponent=>{
    const targets=posts.filter(p=>p.owner===opponent);
    const incoming=v.fleets.filter(f=>f.owner===opponent&&!f.gift&&f.destination?.kind==='outpost'&&ownIds.has(f.destination.id));
    const approaches=own.flatMap(source=>targets.flatMap(target=>{
      const ticks=eta(source.id,target.id);
      return ticks!==null&&ticks<=options.attackTicks?[{source:source.id,target:target.id,ticks}]:[];
    })).sort((a,b)=>a.ticks-b.ticks||a.target.localeCompare(b.target)||a.source.localeCompare(b.source));
    const partners=players.filter(player=>player!==opponent).flatMap(player=>{
      const routesToOpponent=posts.filter(p=>p.owner===player).flatMap(source=>targets.flatMap(target=>{
        const ticks=eta(source.id,target.id);
        return ticks!==null&&ticks<=options.attackTicks?[{source:source.id,target:target.id,ticks}]:[];
      })).sort((a,b)=>a.ticks-b.ticks||a.target.localeCompare(b.target)||a.source.localeCompare(b.source));
      return routesToOpponent.length?[{player,approaches:routesToOpponent.slice(0,3)}]:[];
    }).sort((a,b)=>a.approaches[0]!.ticks-b.approaches[0]!.ticks||a.player-b.player).slice(0,3);
    return {opponent,leadingOpponent:opponent===options.leader,
      incoming:incoming.map(f=>({id:f.id,target:f.destination!.id,state:f.state,ticks:routes.fleetTicks[f.id]??null})),
      ownApproaches:approaches.slice(0,3),partners,
      purposes:[...(incoming.length?['seek-defense-or-counterattack']:[]),...(approaches.length?['joint-attack-or-diversion']:[])]};
  }).filter(p=>p.partners.length&&(p.incoming.length||p.ownApproaches.length))
    .sort((a,b)=>Number(b.incoming.length>0)-Number(a.incoming.length>0)||Number(b.leadingOpponent)-Number(a.leadingOpponent)||a.opponent-b.opponent)
    .slice(0,3);
}
