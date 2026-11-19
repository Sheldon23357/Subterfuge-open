import {PipelineTiming} from './pipeline-timing.js';
import type {CoalescedArrival} from '../observation/arrival-coalescing.js';
import type {DepartureReview} from '../observation/departure-confirmation.js';
import type {AiSnapshot,DecisionSignal,DeferredEvent,DecisionTask} from '../contracts/types.js';

/** One shared runtime state; no scheduler, copies, or persistence format of its own. */
export class RunnerState {
  readonly pipeline=new PipelineTiming();
  analysisCache:{screeningKey:string;routeKey:string;screening?:import('../analysis/attack-screening.js').AttackScreeningReport;routes?:import('../../../../contracts/src/index.js').AttackRoutes}={screeningKey:'',routeKey:''};
  busy = false;
  coalescedArrivals=new Map<string,CoalescedArrival>();
  departureReviews:DepartureReview[]=[];
  recoveryAt:number|null=null;
  recoveryAttempts=0;
  observing=false;
  /** Revisions are opaque equality tokens. Order overlapping reads by local
   * causality instead of comparing hashes or same-tick game timestamps. */
  observationGeneration=0;
  observationBarrier:Promise<void>|null=null;
  inFlight:DecisionTask|null=null;
  presentedReminders=new Map<string,string>();
  latestSnapshot:AiSnapshot|null=null;
  controller: AbortController | null = null;
  lastPoll = -Infinity;
  pendingSince: number | null = null;
  checkedTick=-Infinity;
  /** Pending causes at this tick belong to the next foreground admission. */
  deferredDecisionTick:number|null=null;
  checkedAdvanceVersion:string|undefined;
  observed:AiSnapshot['observation']|null=null;
  signals=new Map<string,DecisionSignal>();
  deferred=new Map<string,DeferredEvent>();
  pendingNotices=new Map<number,import('../../../../contracts/src/index.js').PlayerNotification>();
  phase:'observation'|'local'|'model'|'tool'='observation';
  activeTool:{id:string;tool:string}|null=null;
  localDecisionBasis:string|undefined;
}
