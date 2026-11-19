import {manualFleetIds} from '../execution/manual-coordination.js';
import type {PlayerObservation} from '../../../../contracts/src/index.js';
import type {Campaign,CampaignIntent,CampaignExecutionLedger,CampaignObservationProjection} from './campaign-model.js';
import {assignedToOtherCampaign} from './campaign-ledger.js';
/** Recompute visible movement/issues without changing author fields or accepted-command identities. */
export function projectCampaign(intent:Readonly<CampaignIntent>,ledger:Readonly<CampaignExecutionLedger>,plans:readonly Campaign[],o:PlayerObservation):CampaignObservationProjection{
 const issues:string[]=[],target=o.view.outposts.find(t=>t.id===intent.target);
 if(!target||target.destroyed)issues.push('目标已失效，取消或改定战役');
 for(const a of ledger.allocations){
  const source=o.view.outposts.find(s=>s.id===a.source&&s.owner===o.view.player&&!s.destroyed);
  if(a.drillers>0&&(!source||(source.drillers??0)<a.drillers))issues.push(`来源${a.source}兵力不足或已失去，需重排预算`);
 }
 const humanFleets=manualFleetIds(o);
 const pending=o.scheduled.filter(s=>s.player===o.view.player&&s.status==='pending'&&ledger.committedOrders?.includes(s.id));
 const assigned=o.view.fleets.filter(f=>f.owner===o.view.player&&!humanFleets.has(f.id)&&!f.gift&&(f.destination?.kind==='outpost'&&f.destination.id===intent.target&&!assignedToOtherCampaign(f.id,intent.id,plans)||ledger.committedOrders?.includes(f.id)));
 if(ledger.allocations.every(a=>a.drillers===0)&&target?.owner!==o.view.player&&!assigned.length&&!pending.length)issues.push('目标未占领且没有剩余出兵或在途力量，需重估战役');
 if(o.view.tick>=intent.reviewAtTick)issues.push('已到战役复查窗口');
 const movement={waiting:assigned.filter(f=>f.state==='waiting').length+pending.filter(s=>!assigned.some(f=>f.id===s.id)).length,moving:assigned.filter(f=>f.state!=='waiting').length};
 const stage=issues.length?'review':target?.owner===o.view.player?'holding':ledger.allocations.every(a=>a.drillers===0)?movement.moving?'underway':'waiting':'assembling';
 return {issues,movement,stage};
}
