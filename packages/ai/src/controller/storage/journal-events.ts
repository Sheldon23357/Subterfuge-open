import type {CompactGameError} from '../transport/gateway.js';
import type {AiMemory,AiSnapshot,NotebookEntry,AiReminder,DecisionSignal,DeferredEvent,DecisionTask} from '../contracts/types.js';
import type {Campaign} from './campaign-state.js';
import type {ReviewReceipt} from './memory-consistency.js';
import type {CoalescedArrival} from '../observation/arrival-coalescing.js';
import type {DepartureReview} from '../observation/departure-confirmation.js';
export interface LocalEventPayloads {
 'commander-cleanup-requested':{requestId:string;cleanup:import('../../../../contracts/src/index.js').CommanderCleanup};
 'manual-intent-reconciled':import('../execution/manual-coordination.js').ManualReview;
 'memory-archived':{memory:AiMemory;seconds:number;reason:'finish'|'remember'|'notebook'};
 'memory-maintained':{seconds:number};
 'notebook-removed':{id:string};
 'notebook-set':NotebookEntry;
 'reminder-cancelled':{id:string};
 'reminder-fired':{id:string};
 'reminder-set':AiReminder;
 'memory-reviewed':ReviewReceipt;
 'full-memory-review':{seconds:number;records:number;reason:string|undefined};
 'campaign-state':{plans:Campaign[]};
}

export interface JournalEventPayloads extends LocalEventPayloads {
 'foreground-closed':{tick:number};
 'runtime-poll-timing':{startedAt:number;durationMs:number;snapshotMs:number;snapshotReads:number;decisionMs:number;admissionMs:number;startedDecision:boolean;observeOnly:boolean;backgroundOnly?:boolean;tick:number|null;sequence:number};
 'runtime-readiness-timing':{startedAt:number;durationMs:number;operation:'readiness-clear'|'readiness-report';tick:number|null};
 'snapshot-repeated':{kind:string;ref:number};
 'activity-facts-origin':{roomId:string;player:number;cursor:number;manualVersion?:number};
 'execution-evidence-provided':{references:import('../execution/execution-evidence.js').ExecutionEvidenceReference[]};
 'write-reconciled':import('../execution/write-reconciliation.js').WriteResolution;
 'batch-recovered':{id:string;tool:'batch';result:ReturnType<typeof import('../execution/batch-recovery.js').recoverBatchOutcome>};
 'round-materials-changed':import('../execution/round-workset.js').RoundMaterialChange;
 'round-workset':{workset:import('../execution/round-workset.js').RoundWorkset|null};
 'wake-observation':AiSnapshot['observation'];
 'provider-dispatch-commander':import('../contracts/types.js').ModelDispatchReceipt;
 'wake-state':{signals:DecisionSignal[];deferred:DeferredEvent[];coalescedArrivals:CoalescedArrival[];departureReviews:DepartureReview[];observed?:AiSnapshot['observation']|null;inFlight:DecisionTask|null;notices:AiSnapshot['notifications']};
 'tool-intent':{id:string;tool:string;summary:string;arguments:unknown;invalidArguments?:boolean};
 'tool-result':{id:string;tool:string;summary:string;result:unknown};
 'tool-rejected':{id:string;tool:string;summary:string;arguments?:unknown;result:unknown;diagnostic?:unknown};
 'comparison-evidence':{id:string;planId:string;evidence:import('../../../../prediction/src/index.js').KnownDefenseEvidence};
 'arrival-estimates':import('../observation/arrival-coalescing.js').ArrivalEstimates;
 'observation-baseline':AiSnapshot['observation'];
 'query-result':{id:string;tool:string;arguments:unknown;result:unknown};
 'prediction-detail':{id:string;tool:string;arguments:unknown;result:unknown};
 'campaign-detail':{id:string;tool:string;arguments:unknown;result:unknown};
 'batch-item-unknown':{id:string;index:number}&Partial<CompactGameError>;
 'recovery-completed':{attempts:number;at:string};
 'chat-handled':import('../observation/chat-wake.js').ChatHandled;
 'completed':{sequence:number;nextReview:null;durationMs:number;reason:string};
 'batch-item-result':{id:string;index:number;tool:unknown;status:string;revision?:string;error?:string;detail?:unknown}&Partial<CompactGameError>;
 'batch-item-intent':{id:string;index:number;tool?:unknown;arguments?:unknown};
 'context-restored':{category:string;scope?:string};
}
export type JournalEvent<K extends keyof JournalEventPayloads=keyof JournalEventPayloads>={
 [P in K]:{kind:P;details:JournalEventPayloads[P]}
}[K];
export function journalPayload<K extends keyof JournalEventPayloads>(kind:K,details:JournalEventPayloads[K]):JournalEventPayloads[K]{return details;}
export type JournalPurpose='private-state'|'business-recovery'|'business-evidence'|'diagnostic';
/** Classification is documentation/typing, NOT a deletion or retention policy.
 * Unknown/historical events remain readable and must not be assumed disposable.
 * Even diagnostic journal rows may be joined to business traces by row ID.
 */
export const JOURNAL_PURPOSE={
 'foreground-closed':'business-recovery',
 'execution-evidence-provided':'business-recovery',
 'write-reconciled':'business-recovery',
 'batch-recovered':'business-recovery',
 'commander-cleanup-requested':'business-recovery','manual-intent-reconciled':'private-state',
 'memory-archived':'private-state','memory-maintained':'private-state','notebook-removed':'private-state','notebook-set':'private-state',
 'reminder-cancelled':'private-state','reminder-fired':'private-state','reminder-set':'private-state','memory-reviewed':'private-state','full-memory-review':'private-state','campaign-state':'private-state',
 'comparison-evidence':'business-evidence','arrival-estimates':'business-evidence','observation-baseline':'business-recovery','query-result':'business-evidence','prediction-detail':'business-evidence','campaign-detail':'business-evidence','batch-item-unknown':'business-recovery',
 'runtime-poll-timing':'diagnostic','runtime-readiness-timing':'diagnostic',
 'snapshot-repeated':'business-recovery','recovery-completed':'business-recovery','chat-handled':'business-recovery','completed':'business-recovery','batch-item-result':'business-evidence','batch-item-intent':'business-recovery',
 'round-materials-changed':'diagnostic','round-workset':'business-recovery','provider-dispatch-commander':'business-recovery',
 'activity-facts-origin':'business-recovery','wake-observation':'business-recovery','wake-state':'business-recovery','tool-intent':'business-recovery','tool-result':'business-evidence','tool-rejected':'business-evidence','context-restored':'diagnostic',
} as const satisfies Record<keyof JournalEventPayloads,JournalPurpose>;
export function journalPurpose(kind:string):JournalPurpose|'unclassified-preserve'{
 return Object.hasOwn(JOURNAL_PURPOSE,kind)?JOURNAL_PURPOSE[kind as keyof typeof JOURNAL_PURPOSE]:'unclassified-preserve';
}
