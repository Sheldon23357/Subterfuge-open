import type {PlayerObservation} from '../../../../contracts/src/index.js';
import {botDistance} from './tactical-evaluation.js';

export interface OpeningTarget {
 id:string;zone:'own-near'|'contested'|'rival-near'|'unknown';
 ownSource:string|null;ownDistance:number|null;rivalSource:string|null;rivalPlayer:number|null;rivalDistance:number|null;
 claimForce:number|null;competitionForce:number|null;friendlyIncoming:number;hostileIncoming:number;covered:boolean;
}
/** Geography and bounded planning assumptions, never future ownership or intent. */
export function openingExpansion(o:PlayerObservation){
 const v=o.view,active=v.tick<144&&!v.match?.ended;
 const own=v.outposts.filter(p=>p.owner===v.player&&!p.destroyed);
 const rivals=v.outposts.filter(p=>p.owner!=null&&p.owner!==v.player&&!p.destroyed&&o.intel.some(i=>i.player===p.owner&&i.active));
 const targets:OpeningTarget[]=active?v.outposts.filter(p=>p.owner===null&&!p.destroyed).map(target=>{
  const nearest=(posts:typeof own)=>posts.map(p=>({post:p,distance:botDistance(p.position,target.position,v.size)})).sort((a,b)=>a.distance-b.distance||a.post.id.localeCompare(b.post.id))[0];
  const home=nearest(own),rival=nearest(rivals),margin=home&&rival?Math.max(0.5,Math.min(home.distance,rival.distance)*0.1):0;
  const zone:OpeningTarget['zone']=!home||!rival?'unknown':Math.abs(home.distance-rival.distance)<=margin?'contested':home.distance<rival.distance?'own-near':'rival-near';
  const incoming=v.fleets.filter(f=>!f.gift&&f.destination?.kind==='outpost'&&f.destination.id===target.id);
  const friendlyIncoming=incoming.filter(f=>f.owner===v.player).reduce((n,f)=>n+f.drillers,0);
  const byPlayer=new Map<number,number>();for(const f of incoming.filter(f=>f.owner!==v.player))byPlayer.set(f.owner,(byPlayer.get(f.owner)??0)+f.drillers);
  const hostileIncoming=Math.max(0,...byPlayer.values());
  const claimForce=target.visibility===2&&target.drillers!==undefined&&target.shield!==undefined?target.drillers+target.shield+1:null;
  // One rival's visible partial sortie, not a fabricated coalition or hidden army.
  const rivalForce=rival?.post.visibility===2&&rival.post.drillers!==undefined?Math.floor(rival.post.drillers*0.65):null;
  const competitionForce=zone==='own-near'?hostileIncoming:rivalForce===null&&hostileIncoming===0?null:Math.max(hostileIncoming,rivalForce??0);
  return {id:target.id,zone,ownSource:home?.post.id??null,ownDistance:home?.distance??null,rivalSource:rival?.post.id??null,rivalPlayer:rival?.post.owner??null,rivalDistance:rival?.distance??null,claimForce,competitionForce,friendlyIncoming,hostileIncoming,
   covered:claimForce!==null&&friendlyIncoming>=claimForce+(competitionForce??0)};
 }).sort((a,b)=>Number(a.covered)-Number(b.covered)||(a.ownDistance??Infinity)-(b.ownDistance??Infinity)||a.id.localeCompare(b.id)):[];
 return {active,untilWorldDay:144,basis:'authorized-geography-and-visible-force' as const,targets,
  uncoveredHome:targets.filter(t=>t.zone==='own-near'&&!t.covered).map(t=>t.id),
  unknowns:[...(v.outposts.some(p=>p.owner===undefined)?['unobserved-ownership']:[]),...(targets.some(t=>t.competitionForce===null)?['competitor-force-unknown']:[])],
  interpretation:'距离为环形地图几何距离，不是精确ETA或归属保证。敌方近点按可能被对手先占规划；兵力是假设种子，需联合推演。covered只表示已有足量在途投入，不表示已占领。'};
}

export function openingContestCurrent(o:PlayerObservation,targets:readonly string[],opponents:readonly number[]){
 const report=openingExpansion(o);
 return report.active&&targets.every(id=>report.targets.some(t=>t.id===id&&['rival-near','contested'].includes(t.zone)&&t.rivalPlayer!==null&&opponents.includes(t.rivalPlayer)));
}
