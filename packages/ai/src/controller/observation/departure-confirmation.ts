import type {PlayerObservation} from '../../../../contracts/src/index.js';
import type {KnownDepartureEvidence} from '../../../../prediction/src/index.js';
import type {DecisionSignal} from '../contracts/types.js';
import {routineDefenseGrowth} from '../analysis/expected-growth.js';

export type DepartureReview=Omit<KnownDepartureEvidence,'departures'>&{
  sequence:number;resultRef:string;validatedRevision:string;departure:KnownDepartureEvidence['departures'][number];
};
type Fleet=PlayerObservation['view']['fleets'][number];
const now=(o:PlayerObservation)=>o.view.tick*600+o.secondsSinceLastTick;
export const fleetPlanKey=(f:Fleet)=>JSON.stringify([f.owner,f.drillers,f.gift,f.destination]);
const staticPost=(p:PlayerObservation['view']['outposts'][number])=>JSON.stringify([p.id,p.position,p.owner,p.type,p.visibility,p.destroyed,p.minePending,p.shieldMax,p.shieldsEnabled,
  p.metrics?.active,p.metrics?.paused,p.metrics?.output,p.metrics?.cycleMinutes,p.metrics?.contribution]);
function samePremises(before:PlayerObservation,after:PlayerObservation,confirmed:Set<string>){
  if(before.view.profile!==after.view.profile||JSON.stringify(before.view.size)!==JSON.stringify(after.view.size))return false;
  if(JSON.stringify(before.scheduled)!==JSON.stringify(after.scheduled)||
    JSON.stringify(before.intel.map(p=>[p.player,p.active]))!==JSON.stringify(after.intel.map(p=>[p.player,p.active])))return false;
  const own=(o:PlayerObservation)=>{const s=o.view.self;return [s.active,s.capacity,s.outpostCount,s.mineCreationCost,s.funding];};
  if(JSON.stringify(own(before))!==JSON.stringify(own(after))||JSON.stringify(before.view.match)!==JSON.stringify(after.view.match))return false;
  if(before.view.outposts.length!==after.view.outposts.length||before.view.fleets.length!==after.view.fleets.length)return false;
  for(const p of before.view.outposts){
    const next=after.view.outposts.find(n=>n.id===p.id);
    if(!next||staticPost(p)!==staticPost(next))return false;
    if(p.drillers!==next.drillers||p.shield!==next.shield){
      if(p.drillers===undefined||next.drillers===undefined||next.drillers<p.drillers||p.shield===undefined||next.shield===undefined||next.shield<p.shield||
        !routineDefenseGrowth(p,next,before,after,true))return false;
    }
  }
  for(const f of before.view.fleets){
    const next=after.view.fleets.find(n=>n.id===f.id);
    if(!next||fleetPlanKey(f)!==fleetPlanKey(next))return false;
    if(f.state!==next.state&&!(['launching','moving'].includes(f.state)&&['launching','moving'].includes(next.state))&&
      !(f.state==='waiting'&&['launching','moving'].includes(next.state)&&(confirmed.has(f.id)||f.owner===before.view.player)))return false;
  }
  return true;
}

/** Confirmation is a private continuation of a finished baseline forecast.
 * No new prediction, model request, cancellation, or interpretation of prose. */
export function confirmDepartures(before:PlayerObservation|null,after:PlayerObservation,reviews:readonly DepartureReview[]){
  const confirmed=new Set<string>(),minor:{key:string;summary:string}[]=[],important:DecisionSignal[]=[];
  if(!reviews.length||!before||before.roomId!==after.roomId||before.view.player!==after.view.player||now(after)<now(before))return {reviews:[] as DepartureReview[],confirmed,minor,important};
  const valid:DepartureReview[]=[];
  for(const r of reviews){
    if(r.roomId!==after.roomId||r.player!==after.view.player||r.validatedRevision!==before.revision)continue;
    const id=r.departure.fleetId,old=before.view.fleets.find(f=>f.id===id),next=after.view.fleets.find(f=>f.id===id);
    const changed=!old||!next||fleetPlanKey(old)!==fleetPlanKey(next);
    const late=next?.state==='waiting'&&now(after)>r.departure.departureSeconds;
    if(changed||late){
      important.push({key:`departure-plan:${id}`,category:'military',urgent:true,entities:[id,...(old?.destination?[old.destination.id]:[])],
        reason:changed?'已推演的待发敌舰撤回、失去可见性或兵力/航线变化，复核原对策':'已推演的敌舰未按预计时点出发，复核原对策'});
      continue;
    }
    if(now(after)>=r.departure.arrivalSeconds||after.view.tick>r.targetTick)continue;
    if(old!.state==='waiting'&&['launching','moving'].includes(next!.state)){
      const frame=r.departure.frames.find(f=>f.tick===after.view.tick&&f.state===next!.state);
      const samePosition=frame&&(['x','y'] as const).every(axis=>{
        const size=axis==='x'?after.view.size.width:after.view.size.height,d=((frame.position[axis]-next!.position[axis])%size+size)%size;
        return Math.min(d,size-d)<1e-6;
      });
      if(after.secondsSinceLastTick!==0||!samePosition||r.departure.departureSeconds<now(before)||r.departure.departureSeconds>now(after))continue;
      confirmed.add(id);
    }else if(next!.state!=='waiting')continue;
    valid.push({...r,validatedRevision:after.revision});
  }
  if(!samePremises(before,after,confirmed)){confirmed.clear();return {reviews:[] as DepartureReview[],confirmed,minor,important};}
  for(const id of confirmed)minor.push({key:`departure-confirmed:${id}`,summary:`敌舰${id}已按上轮推演的兵力、航线及时点实际出航，合并确认；既定对策和复核节点继续`});
  return {reviews:valid.filter(r=>!confirmed.has(r.departure.fleetId)),confirmed,minor,important};
}
