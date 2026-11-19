export interface Campaign {
  id:string;target:string;objective:string;holdPlan:string;cancelWhen:string;
  stage:'assembling'|'waiting'|'underway'|'holding'|'review'|'completed'|'cancelled';
  authoredAtTick?:number;
  /** Last explicit AI revision based on human manual authority. */
  manualBasisVersion?:number;
  movement?:{waiting:number;moving:number};
  createdTick:number;reviewAtTick:number;allocations:{source:string;drillers:number}[];
  defenseOverrides?:{source:string;retainDrillers:number;reason:string}[];
  accountedFleets:string[];issues:string[];
  /** Confirmed command/fleet identities associated with this campaign only. */
  committedOrders?:string[];
  comparison?:{resultRef:string;planId:string};
  comparisonInvalidated?:boolean;
}
export type CampaignExecutionLedger=Pick<Campaign,'allocations'|'accountedFleets'|'committedOrders'|'comparisonInvalidated'>;
export type CampaignObservationProjection=Pick<Campaign,'stage'|'movement'|'issues'>;
export type CampaignIntent=Omit<Campaign,keyof CampaignExecutionLedger|keyof CampaignObservationProjection> & {
 terminalStage?:'completed'|'cancelled';
};
export interface CampaignParts {intent:CampaignIntent;ledger:CampaignExecutionLedger;projection:CampaignObservationProjection}
/** Internal views only; optional-field presence and the persisted flat shape stay unchanged. */
export function campaignParts(saved:Campaign):CampaignParts{
 const {allocations,accountedFleets,committedOrders,comparisonInvalidated,stage,movement,issues,...intent}=structuredClone(saved);
 return {intent:{...intent,...(stage==='completed'||stage==='cancelled'?{terminalStage:stage}:{})},
  ledger:{allocations,accountedFleets,...(Object.hasOwn(saved,'committedOrders')?{committedOrders:committedOrders!}:{}),...(Object.hasOwn(saved,'comparisonInvalidated')?{comparisonInvalidated:comparisonInvalidated!}:{})},
  projection:{stage,issues,...(Object.hasOwn(saved,'movement')?{movement:movement!}:{})}};
}
export function composeCampaign(base:Campaign,parts:CampaignParts):Campaign{
 const {terminalStage,...intent}=parts.intent;
 return Object.assign(structuredClone(base),intent,parts.ledger,parts.projection,...(terminalStage?[{stage:terminalStage}]:[]));
}
export const activeCampaign=(p:Pick<Campaign,'stage'>)=>p.stage!=='completed'&&p.stage!=='cancelled';
