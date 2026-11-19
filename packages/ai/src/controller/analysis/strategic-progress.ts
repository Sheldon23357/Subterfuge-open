import type {PlayerObservation} from '../../../../contracts/src/index.js';
import type {KnownPathEvidence} from '../../../../prediction/src/index.js';

interface Goal {kind:string;targets:string[];priority:number}
/** Conditional control time, not an execution or probability claim. Existing
 * fleets and pending construction earn the same credit in the hold branch. */
export function strategicProgress(o:PlayerObservation,path:KnownPathEvidence|null,goals:readonly Goal[],horizon:number):Record<string,number>{
 const result:Record<string,number>={};
 if(!path||path.roomId!==o.roomId||path.basisRevision!==o.revision||path.player!==o.view.player||path.observedTick!==o.view.tick)return result;
 const start=o.view.tick+o.secondsSinceLastTick/600,end=o.view.tick+horizon,covered=Math.min(end,path.actualTargetTick),window=end-start;
 if(window<=0)return result;
 for(const g of goals){
  if(!['capture','expand','defend','mine'].includes(g.kind))continue;
  const ids=[...new Set(g.targets.length?g.targets:o.view.outposts.map(p=>p.id))].sort();
  for(const id of ids){
   const post=o.view.outposts.find(p=>p.id===id);
   if(!post||post.owner===undefined||post.destroyed)continue;
   let owner=post.owner,mine=post.type==='mine',destroyed=false,at=start,held=0;
   const earns=()=>!destroyed&&owner===o.view.player&&(g.kind!=='mine'||mine);
   const events=path.events.filter(e=>e.subject===id&&['outpost-captured','outpost-destroyed','mine-created'].includes(e.kind))
    .sort((a,b)=>a.tick-1+a.fraction-(b.tick-1+b.fraction)||a.sequence-b.sequence);
   for(const e of events){
    const time=Math.max(start,Math.min(covered,e.tick-1+e.fraction));
    if(time<at)continue;if(earns())held+=time-at;at=time;
    if(e.kind==='outpost-captured')owner=typeof e.details.owner==='number'?e.details.owner:null;
    if(e.kind==='outpost-destroyed')destroyed=true;
    if(e.kind==='mine-created')mine=true;
   }
   if(earns())held+=Math.max(0,covered-at);
   const key=(g.kind==='mine'?'mine':'control')+':'+id;
   const credit=Math.max(0,Math.min(100,g.priority))*0.5*Math.max(0,Math.min(1,held/window))/Math.max(1,ids.length);
   result[key]=Math.max(result[key]??0,credit);
  }
 }
 return result;
}
