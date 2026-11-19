import {manualFleetIds} from '../execution/manual-coordination.js';
import type {PlayerObservation} from '../../../../contracts/src/index.js';
import type {Campaign,CampaignIntent,CampaignExecutionLedger} from './campaign-model.js';
export const assignedToOtherCampaign=(id:string,campaignId:string,plans:readonly Campaign[])=>plans.some(other=>other.id!==campaignId&&other.committedOrders?.includes(id));
/** Consume observed commitments once. Remaining reservations are ledger state, not rewritten intent. */
export function reconcileCampaignLedger(intent:Readonly<CampaignIntent>,saved:CampaignExecutionLedger,plans:readonly Campaign[],o:PlayerObservation):CampaignExecutionLedger{
 const ledger=structuredClone(saved);
 const humanFleets=manualFleetIds(o);
 for(const f of o.view.fleets.filter(f=>f.owner===o.view.player&&!humanFleets.has(f.id)&&!f.gift&&f.destination?.kind==='outpost'&&f.destination.id===intent.target&&!ledger.accountedFleets.includes(f.id)&&!assignedToOtherCampaign(f.id,intent.id,plans))){
  const allocation=ledger.allocations.find(a=>a.source===f.source);
  if(allocation){allocation.drillers=Math.max(0,allocation.drillers-f.drillers);ledger.accountedFleets.push(f.id);}
 }
 return ledger;
}

export interface CampaignExecution {plans:Campaign[];campaignId:string;source:string;debit:number;commandId:string;destination:string}

/** Accepted-command accounting; only the confirmed-response caller may invoke this. */
export function commitCampaignLedger(execution:CampaignExecution,o:PlayerObservation){
  const plans=structuredClone(execution.plans),p=plans.find(p=>p.id===execution.campaignId)!;
  if(p.accountedFleets.includes(execution.commandId))return {plans,changed:false};
  if(execution.debit>0){const a=p.allocations.find(a=>a.source===execution.source)!;a.drillers=Math.max(0,a.drillers-execution.debit);}
  const ids=[execution.commandId,...o.view.fleets.filter(f=>f.owner===o.view.player&&f.source===execution.source&&f.destination?.id===execution.destination).map(f=>f.id)];
  p.accountedFleets=[...new Set([...p.accountedFleets,...ids])];
  p.committedOrders=[...new Set([...(p.committedOrders??[]),...ids])];
  return {plans,changed:true};
}
