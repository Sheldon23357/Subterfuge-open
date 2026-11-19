/** Shared gameplay constants. Durations are rules, never negotiable terms. */
export const DIPLOMACY_RULES = Object.freeze({
  ceasefireTicks: 100,
  jointAttackTicks: 200,
  proposalTicks: 50,
  jointCaptureGoal: 1,
  jointFulfillmentTrust: 10,
  jointUnfulfilledPenalty: 10,
  maxOpenAgreements: 32,
  maxActiveCeasefires: 2,
  maxActiveJointAttacks: 2,
  recentAgreements: 8,
  recentReceipts: 64,
  signingTrust: 2,
  ceasefireTrust: 6,
  signingCooldown: 72,
  ceasefireCooldown: 100,
  attackCooldown: 24,
  attackPenalty: 6,
  capturePenalty: 4,
  mineCapturePenalty: 8,
  ordinaryPenaltyCap: 20,
  peaceDelay: 72,
  peaceStep: 24,
});

export type AgreementTerms =
  | {kind:'ceasefire';outposts:string[]}
  | {kind:'joint-attack';enemy:number};
export interface AgreementSubsidy {payer:number;amount:number}
export type AgreementStatus = 'proposed'|'active'|'completed'|'unfulfilled'|'violated'|'rejected'|'withdrawn'|'superseded'|'expired'|'terminated';
export interface RuleAgreement {
  id:string;players:[number,number];terms:AgreementTerms;subsidy:AgreementSubsidy|null;
  proposedAt:number;startedAt:number|null;deadline:number;status:AgreementStatus;
  progress:[number,number];fulfilled:[boolean,boolean];
  protectedSince:Record<string,number>;reason:string|null;endedAt:number|null;
}
export interface DiplomacyReceipt {
  id:number;time:number;players:[number,number];agreementId:string|null;kind:string;
  actor:number|null;details:Record<string,string|number|boolean|null>;
}
export type DiplomacyAction =
  | {kind:'propose-agreement';peer:number;terms:AgreementTerms;subsidy:AgreementSubsidy|null;counterTo:string|null}
  | {kind:'respond-agreement';agreementId:string;response:'accept'|'reject'|'withdraw'};
export interface RelationView {from:number;to:number;history:number;borderPressure:number;competitionPressure:number;trust:number}
/** Authorized seat projection; callers must not return the private global relation matrix. */
export interface PlayerDiplomacy {
  time:number;receiptCount:number;agreementCount:number;relations:RelationView[];competition:{player:number;score:number;rank:number}[];
  agreements:Omit<RuleAgreement,'protectedSince'>[];receipts:DiplomacyReceipt[];
}

function integer(n:unknown,min:number,max=Number.MAX_SAFE_INTEGER,path='value'):asserts n is number {
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<min||n>max)throw Error(`Invalid diplomacy integer: ${path} must be an integer in [${min},${max}]`);
}
function fields(v:unknown,keys:string[]):asserts v is Record<string,unknown>{
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==[...keys].sort().join())throw Error('Invalid diplomacy fields');
}
function identifier(v:unknown):asserts v is string {if(typeof v!=='string'||!v.length||v.length>128)throw Error('Invalid agreement identifier');}

export function parseDiplomacyAction(raw:unknown):DiplomacyAction {
  if(!raw||typeof raw!=='object')throw Error('Invalid diplomacy action');
  const v=raw as Record<string,unknown>;
  if(v.kind==='propose-agreement'){
    fields(v,['kind','peer','terms','subsidy','counterTo']);integer(v.peer,0,9,'peer');
    const t=v.terms as Record<string,unknown>;
    if(t?.kind==='ceasefire'){
      fields(t,['kind','outposts']);
      if(!Array.isArray(t.outposts)||!t.outposts.length||t.outposts.length>1000)throw Error('Invalid ceasefire scope');
      t.outposts.forEach(identifier);if(new Set(t.outposts).size!==t.outposts.length)throw Error('Duplicate ceasefire outpost');
    }else if(t?.kind==='joint-attack'){
      fields(t,['kind','enemy']);integer(t.enemy,0,9,'terms.enemy');
    }else throw Error('Unsupported agreement type');
    if(v.subsidy!==null){fields(v.subsidy,['payer','amount']);integer(v.subsidy.payer,0,9,'subsidy.payer');integer(v.subsidy.amount,0,Number.MAX_SAFE_INTEGER,'subsidy.amount');}
    if(v.counterTo!==null)identifier(v.counterTo);
  }else if(v.kind==='respond-agreement'){
    fields(v,['kind','agreementId','response']);identifier(v.agreementId);
    if(!['accept','reject','withdraw'].includes(String(v.response)))throw Error('Invalid agreement response');
  }else throw Error('Unsupported diplomacy action');
  return structuredClone(v) as DiplomacyAction;
}
