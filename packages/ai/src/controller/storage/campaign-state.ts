import {manualEntities,isTacticalManual} from '../execution/manual-coordination.js';
import type {PlayerObservation} from '../../../../contracts/src/index.js';
import {activeCampaign,campaignParts,composeCampaign,type Campaign} from './campaign-model.js';
import {reconcileCampaignLedger} from './campaign-ledger.js';
import {projectCampaign} from './campaign-projection.js';
export {activeCampaign,campaignParts,composeCampaign} from './campaign-model.js';
export type {Campaign,CampaignIntent,CampaignExecutionLedger,CampaignObservationProjection,CampaignParts} from './campaign-model.js';

/** The sole current-view reducer. Terminal intent is never reclassified by observation. */
export function reconcileCampaigns(plans:Campaign[],o:PlayerObservation):Campaign[]{
 return plans.map(saved=>{
  if(!activeCampaign(saved))return structuredClone(saved);
  const parts=campaignParts(saved);
  parts.ledger=reconcileCampaignLedger(parts.intent,parts.ledger,plans,o);
  parts.projection=projectCampaign(parts.intent,parts.ledger,plans,o);
  const result=composeCampaign(saved,parts);
  const entities=new Set([saved.target,...saved.allocations.map(a=>a.source),...saved.committedOrders??[]]);
  const changed=o.manualCommands?.receipts.filter(r=>isTacticalManual(r)&&r.version>(saved.manualBasisVersion??0)&&manualEntities(r,o.manualCommands).some(id=>entities.has(id)))??[];
  if(changed.length){result.comparisonInvalidated=true;result.stage='review';result.issues.push('manual-command:'+changed.map(r=>r.id).join(',')+'; human action or protection authority changed this scope, review allocations and intent before continuing; not proof of campaign completion');}
  return result;
 });
}
export function campaignReservations(plans:Campaign[]){
  const reserved:Record<string,number>={};
  for(const p of plans.filter(activeCampaign))for(const a of p.allocations)reserved[a.source]=(reserved[a.source]??0)+a.drillers;
  return reserved;
}
