import {DEFAULT_BOT_SETTINGS,type PlayerObservation} from '../../../../contracts/src/index.js';
import type {KnownPredictionDraft,KnownPathEvidence} from '../../../../prediction/src/index.js';
import {createOutpostRiskAnalysis,type OutpostRiskAnalysis} from './outpost-risk.js';

// These are search preferences, never combat/safety proofs. Recompute from the
// latest authorized observation every round; do not persist a fixed garrison.
export const botBufferedForce=(minimum:number,margin=DEFAULT_BOT_SETTINGS.forceBufferRatio)=>minimum+Math.ceil(minimum*margin);
/** Current total force includes troops in transit. Launching alone never
 * frees capacity. This bounded preference cannot relax combat/defense gates. */
export function botAttackPressure(o:PlayerObservation) {
  const {drillers,capacity}=o.view.self;
  const forceRatio=capacity>0?Math.max(0,Math.min(1,drillers/capacity)):drillers>0?1:0;
  const aggression=Math.max(0,(forceRatio-0.5)/0.5);
  return {forceRatio,aggression,gainMultiplier:1-0.75*aggression,commitmentMultiplier:1-0.5*aggression};
}
export function botGarrisonPolicy(o:PlayerObservation,id:string,risks:OutpostRiskAnalysis=createOutpostRiskAnalysis(o)) {
  const v=o.view,p=v.outposts.find(p=>p.id===id);
  if(!p||p.owner!==v.player||p.destroyed||p.drillers===undefined)return {desired:0,available:0,spare:0};
  const risk=risks.get(id),available=risk.available,desired=risk.requiredGarrison;
  return {desired,available,spare:Math.max(0,available-desired)};
}

/** Price the loss of options until a dispatched force can be reused. Joint
 * launches share a single source budget. This is soft, so protecting a critical mine or
 * securing a win may still justify committing the entire garrison. */
export function botCommitmentCost(o:PlayerObservation,drafts:readonly KnownPredictionDraft[],path?:KnownPathEvidence|null,risks:OutpostRiskAnalysis=createOutpostRiskAnalysis(o)) {
  const spent=new Map<string,{troops:number;weighted:number}>();let transit=0;
  // Friendly deliveries restore the force's mobility. Charge the verified
  // unavailable time, not a full-window fee after the troops are usable again.
  // A missing/partial path, hostile destination or unresolved arrival gets no
  // discount. Source-defense shortfall remains a separate, undiscounted cost.
  const commitmentFraction=(d:KnownPredictionDraft)=>{
    if(!path?.coverage.complete||path.roomId!==o.roomId||path.basisRevision!==o.revision||path.player!==o.view.player||path.observedTick!==o.view.tick||path.observedSeconds!==o.secondsSinceLastTick
      ||!o.view.outposts.some(p=>p.id===d.action.destination&&p.owner===o.view.player&&!p.destroyed))return 1;
    const order=path.orderFleets.find(f=>f.orderId===d.id&&f.issueTick===d.issueTick&&f.status==='executed');
    if(!order)return 1;
    const observedNow=o.view.tick+o.secondsSinceLastTick/600,start=Math.max(d.issueTick,observedNow),window=path.requestedTargetTick-observedNow;
    if(window<=0)return 1;
    const arrival=path.events.find(e=>e.subject===order.fleetId&&e.kind==='unloaded'&&e.details.outpost===d.action.destination&&e.tick-1+e.fraction>=start);
    if(!arrival||path.events.some(e=>e.subject===order.fleetId&&e.kind==='battle'&&e.details.target===d.action.destination&&e.details.defenderOwner!==o.view.player))return 1;
    return Math.min(1,Math.max(1,arrival.tick-1+arrival.fraction-start)/window);
  };
  for(const d of drafts)if(d.action.kind==='launch'&&typeof d.action.source==='string'){
    const troops=Number(d.action.drillers??0);
    const weighted=troops*commitmentFraction(d);transit+=weighted*0.12;
    if(d.issueTick===o.view.tick){const prior=spent.get(d.action.source)??{troops:0,weighted:0};
      spent.set(d.action.source,{troops:prior.troops+troops,weighted:prior.weighted+weighted});}
  }
  let shortfall=0;
  for(const [id,{troops,weighted}] of spent){
    const p=botGarrisonPolicy(o,id,risks);
    // Price concentration smoothly: the last mobile troops have more option
    // value, but there is no discontinuous minimum-garrison rejection.
    transit+=0.12*weighted*Math.min(1,troops/Math.max(1,p.available));
  }
  // Debit all simultaneous departures together, then re-evaluate every own
  // point: one donor can support multiple fronts only as a potential option.
  // Credits for deliveries require the separate joint forecast above.
  if(spent.size){
    const after={...o,view:{...o.view,outposts:o.view.outposts.map(p=>spent.has(p.id)?{...p,drillers:Math.max(0,(p.drillers??0)-spent.get(p.id)!.troops)}:p)}};
    const next=createOutpostRiskAnalysis(after,risks.config,risks.routes);
    shortfall=Math.max(0,next.own().reduce((n,p)=>n+p.penalty,0)-risks.own().reduce((n,p)=>n+p.penalty,0));
  }
  return {transit,shortfall:shortfall*0.6};
}
