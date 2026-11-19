import type {PlayerDiplomacy} from './index.js';
interface SearchAction {kind:string;source?:string;destination?:string;outpostId?:string;fleetId?:string;drillers?:number;enabled?:boolean}
interface SearchCandidate {id:string;kind:string;targets:string[];routes:{source:string;target:string;drillers:number|null}[];actions?:{issueTick:number;action:SearchAction}[];reasons?:string[]}
/** Operator diagnostics from authorized observations; never a game-write surface. */
export interface BotSearchProgress {
  basisRevision:string;observedTick:number;elapsedMs:number;stage:string;
  generated:number;evaluated:number;simulations:number;maximum:number;horizon:number;timeLimitMs:number;
  stages:Record<string,number>;
  branches:(SearchCandidate&{status:string;utility:number|null;components?:SearchCandidate[]})[];
}
export interface BotRuntimeTelemetry {
  /** Elapsed program operation time for this tick; repeated operations accumulate. */
  pipeline?:{tick:number;milliseconds:Record<'sync'|'search'|'execution'|'finish'|'readiness',number>};
  foreground?:'idle'|'observation'|'planning-sync'|'model'|'search'|'execution'|'readiness';
  round:number;phase:string;tool:string|null;tick:number|null;pendingSignals:number;background:{active:number;queued:number};
  search:({sequence:number;at:number;progress:BotSearchProgress})|null;
}
export interface BotLiveSnapshot {
  strategyDetails?:unknown;
  diplomacy?:PlayerDiplomacy;
  generation:string;round:number;observedTick:number|null;names:Record<string,string>;
  directive:{version:number;summary:string;objectives:{kind:string;targets:string[];priority:number;reason:string}[];agreements:{status:string;summary:string;forbidAttack:boolean}[]}|null;
  tasks:{id:string;kind:string;status:string;attempt:number;characters:number;error?:string}[];
  intents:{id:string;kind:string;target:string|null;status:string;reason:string;description?:string}[];
  decision:{sequence:number;finalized:boolean;observedTick:number;current:boolean;selected:string;kind:string;targets:string[];reasons:string[];coverage:{generated:number;evaluated:number;simulations:number;complete:boolean;stopReason:string;stages?:Record<string,number>};parameters:{maxSimulations:number;maxElapsedMs:number;horizonTicks:number};branches:BotSearchProgress['branches'];drafts:{kind:string;source:string|null;target:string|null;drillers:number|null}[]}|null;
  operations:{id:string;objective:string;status:string;issues:string[]}[];
  events:{id:number;kind:string;summary:string;tool:string|null;round:number|null}[];
}
