import type {PlayerObservation} from '../../../../contracts/src/index.js';
import type {AiReminder,DecisionSignal} from '../contracts/types.js';
import {activeCampaign,type Campaign} from '../storage/campaign-state.js';
import {routineDefenseGrowth} from '../analysis/expected-growth.js';
import {fleetLabel} from '../presentation/fleet-labels.js';

export const ARRIVAL_COALESCED_PREFIX='预期援军到账合并：';
export interface ArrivalEstimates {
  roomId:string;player:number;observedSeconds:number;
  fleets:{id:string;target:string;drillers:number;arrivalSeconds:number}[];
}
export interface CoalescedArrival {
  signal:DecisionSignal;target:string;reminderId:string;atSeconds:number;
}
const time=(o:PlayerObservation)=>o.view.tick*600+o.secondsSinceLastTick;
type EstimateResult={status:string;arrivals?:{id:string;arrivalMinutes:number|null}[]};

/** Audit the already performed arrivals calculation; no extra prediction. */
export function arrivalEstimates(o:PlayerObservation,result:EstimateResult):ArrivalEstimates {
  const fleets=result.status==='conditional'?o.view.fleets.flatMap(f=>{
    const a=result.arrivals?.find(a=>a.id===f.id),target=o.view.outposts.find(p=>p.id===f.destination?.id);
    if(f.owner!==o.view.player||f.gift||f.giftPendingSeconds||!['moving','launching'].includes(f.state)||f.drillers<=0||f.destination?.kind!=='outpost'||target?.owner!==o.view.player||
      a?.arrivalMinutes===null||a?.arrivalMinutes===undefined)return [];
    return [{id:f.id,target:target.id,drillers:f.drillers,arrivalSeconds:time(o)+a.arrivalMinutes*60}];
  }):[];
  return {roomId:o.roomId,player:o.view.player,observedSeconds:time(o),fleets};
}

/** Delay only a whole otherwise-idle arrival batch. Any other important event
 * already needs a decision, so keep all arrivals in that immediate decision. */
export function coalesceOwnArrivals(before:PlayerObservation|null,after:PlayerObservation,signals:DecisionSignal[],estimates:ArrivalEstimates|null,reminders:AiReminder[],campaigns:Campaign[]){
  const none={immediate:signals,delayed:[] as CoalescedArrival[]};
  if(!before||!estimates||before.roomId!==after.roomId||estimates.roomId!==after.roomId||estimates.player!==after.view.player||estimates.observedSeconds>time(before)||time(before)>=time(after)||
    !signals.length||signals.some(s=>!s.key.startsWith('arrival:')))return none;
  const now=time(after),player=after.view.player,groups=new Map<string,typeof before.view.fleets>();
  for(const signal of signals){
    const f=before.view.fleets.find(f=>`arrival:${f.id}`===signal.key),known=estimates.fleets.find(a=>a.id===f?.id);
    if(!f||f.owner!==player||f.gift||f.giftPendingSeconds||f.drillers<=0||!['moving','launching'].includes(f.state)||f.destination?.kind!=='outpost'||
      !known||known.target!==f.destination.id||known.drillers!==f.drillers||
      known.arrivalSeconds<=time(before)||known.arrivalSeconds>now)return none;
    const delivered=after.activity?.some(event=>event.subject===f.id&&event.actor===player&&event.arrival?.outpost===known.target&&event.arrival.outcome==='delivered'&&event.arrival.drillers===f.drillers&&event.tick*600+event.seconds>=time(before)&&event.tick*600+event.seconds<=now);
    if(!delivered)return none;
    groups.set(known.target,[...(groups.get(known.target)??[]),f]);
  }
  const delayed:CoalescedArrival[]=[];
  for(const [target,fleets] of groups){
    const old=before.view.outposts.find(p=>p.id===target),next=after.view.outposts.find(p=>p.id===target);
    if(!old||!next||old.owner!==player||next.owner!==player||old.visibility!==2||next.visibility!==2||old.destroyed||next.destroyed||
      old.type!==next.type||old.minePending!==next.minePending||old.shieldMax!==next.shieldMax||old.shieldsEnabled!==next.shieldsEnabled||
      old.drillers===undefined||next.drillers===undefined||old.shield===undefined||next.shield===undefined||next.shield<old.shield||
      after.view.fleets.some(f=>f.owner!==player&&!f.gift&&f.destination?.kind==='outpost'&&f.destination.id===target))return none;
    const gain=fleets.reduce((n,f)=>n+f.drillers,0);
    if(next.drillers-old.drillers<gain||!routineDefenseGrowth({...old,drillers:old.drillers+gain},next,before,after,true))return none;
    const related=(r:AiReminder)=>r.entities?.includes(target)||campaigns.some(c=>activeCampaign(c)&&c.target===target&&r.id===`campaign:${c.id}`);
    const review=reminders.filter(r=>r.atSeconds>now&&r.atSeconds<=now+600&&related(r)).sort((a,b)=>a.atSeconds-b.atSeconds)[0];
    if(!review)return none;
    for(const f of fleets){
      const original=signals.find(s=>s.key===`arrival:${f.id}`)!;
      delayed.push({target,reminderId:review.id,atSeconds:review.atSeconds,signal:{...original,entities:[f.id,target],
        reason:`${ARRIVAL_COALESCED_PREFIX}${after.outpostNames?.[target]??target}可见增兵与${fleetLabel(f.id)}的${f.drillers}兵预计到账一致，已在${now/600}世界天（规则秒${now}）记录，合并至${review.atSeconds/600}世界天（规则秒${review.atSeconds}）的相关复核`}});
    }
  }
  return {immediate:[],delayed};
}
