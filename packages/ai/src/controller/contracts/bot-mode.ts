import type {AiState,AiSettings,AiSnapshot,AgentRequest,AgentResult,AgentProvider,DecisionSignal} from './types.js';
import type {PlayerObservation,AttackRoutes,CommanderThread,CommanderMessage} from '../../../../contracts/src/index.js';
import type {AnalysisEfficiency} from '../analysis/analysis-efficiency.js';
import type {PreparedDecisionContext} from './decision-context.js';
import type {BatchEffect} from './batch-effect.js';
/** Modes propose instructions; only the controller validates and commits effects. */
export interface BotModeInput {
 state:Readonly<AiState>;snapshot:Readonly<AiSnapshot>;history:unknown[];feedback:unknown[];
 efficiency:AnalysisEfficiency;suffix:string;routes:AttackRoutes|undefined;
}
export interface BotModeServices {
 /** Host-admitted model calls; strategies never receive credentials or raw transports. */
 model:Pick<AgentProvider,'step'>;
 /** Program-only audit/fact channels; never exposed as model history recall. */
 receipt?:(id:string)=>unknown;
 attemptReceipt?:(kind:string,id:string)=>{requestId:string;receipt:unknown}|undefined;
 readActivity?:(after:number,through:number)=>Promise<unknown>;
 refreshSnapshot?:()=>Promise<AiSnapshot>;
 local:(request:AgentRequest,compute:(admitted:AgentRequest)=>Promise<AgentResult>)=>Promise<AgentResult>;
 latest:<T>(kind:string)=>T|undefined;
 record:(kind:string,details:Record<string,unknown>)=>void;
 markAssessed:()=>void;
}
/** Managed background work has no game-write or private-memory authority. */
export interface BotBackgroundServices {
 receipt?:(id:string)=>unknown;
 fail?:(error:unknown)=>void;
 state:Readonly<AiState>;
 model:Pick<AgentProvider,'step'>;
 latest:<T>(kind:string)=>T|undefined;
 record:(kind:string,details:Record<string,unknown>)=>void;
 wake:()=>void;
}
export interface BotBackground {
  readonly activity?:{active:number;queued:number};
 observe(snapshot:Readonly<AiSnapshot>):void;
 readonly settling:boolean;
 pause():void;
 drain():Promise<void>;
}
/** Controller-owned communication runs outside tactical round admission. */
export interface CommunicationResult {
 status:'accepted'|'rejected'|'unknown';requestId:string;result:unknown;
}
export interface BotCommunicationServices {
 state:Readonly<AiState>;snapshot:AiSnapshot;
 latest:<T>(kind:string)=>T|undefined;
 record:(kind:string,details:Record<string,unknown>)=>void;
 wake:()=>void;
 send:(id:string,args:{to:number|number[]|null;text:string})=>Promise<CommunicationResult>;
}
/** Durable receipt projection only: no model calls, searches or remote writes. */
export interface BotReceiptServices {
 requestIds:readonly string[];
 latest:BotModeServices['latest'];
 record:BotModeServices['record'];
 attemptReceipt:NonNullable<BotModeServices['attemptReceipt']>;
 wake:()=>void;
}
/** Strategies orchestrate local work and host-admitted model calls for one round. */
export interface BotModeStep {
 context:PreparedDecisionContext;
 run:(request:AgentRequest,services:BotModeServices)=>Promise<AgentResult>;
}
export interface BotModeDiagnosticsInput {observation:PlayerObservation|undefined;latest:<T>(name:string)=>T|undefined}
export interface CommanderPromptInput {
 mode:'discuss'|'reconcile';state:Readonly<AiState>;thread:CommanderThread;message:CommanderMessage|null;observation:PlayerObservation;roster:NonNullable<AiSnapshot['roster']>;
}
export interface BotMode {
 /** Whole-batch guards are sufficient when the server prevents interleaving. */
 readonly serverBatch?:boolean;
 readonly reviewReminders?:readonly string[];
 readonly commanderContextLimit?:number;
 readonly commanderReconciliationReceipt?:string;
 /** Explicit route-analysis policy; no strategy-name checks in the controller. */
 readonly analysisWindows?:{attackTicks:number;localTicks:number};
 /** Fix planning input within its tick; defer expired/rejected work to the next tick. */
 readonly deferStaleUntilNextTick?:boolean;
 /** Deterministic receipt bookkeeping after one action; never searches again. */
 afterAction?:(input:BotModeInput,latest:BotModeServices['latest'],record:BotModeServices['record'])=>AgentResult;
 /** Review only when the last completed search is older than this many world ticks. */
 readonly tacticalReviewAfterTicks?:number|((settings:Readonly<AiSettings>)=>number);
 communicate?:((services:BotCommunicationServices)=>Promise<void>)|undefined;
 onReceipt?:(services:BotReceiptServices)=>void;
 /** Incoming chat is durably ingested by the background, without a foreground wake. */
 readonly backgroundHandlesChat?:boolean;
 commanderPrompt?:(input:CommanderPromptInput & {latest:<T>(kind:string)=>T|undefined})=>string;
 createBackground?:(services:BotBackgroundServices)=>BotBackground;
 beforeExecute?:(input:{state:Readonly<AiState>;snapshot:AiSnapshot;tool:string;arguments:Record<string,unknown>;batchEffect?:BatchEffect;latest:<T>(kind:string)=>T|undefined})=>void;
 readonly id:string;
 /** Stable private journal namespace; mode records cannot impersonate command receipts. */
 readonly recordPrefix:string;
 readonly usesModelProvider:boolean;
 readonly supportsCommander:boolean;
 diagnostics?:(input:BotModeDiagnosticsInput)=>Record<string,unknown>;
 readonly automaticEventCoalesceMs:number|undefined;
 retainSignals:(signals:readonly DecisionSignal[])=>readonly DecisionSignal[];
 needsAnalysis:(feedback:readonly unknown[],context?:{state:Readonly<AiState>;latest:<T>(kind:string)=>T|undefined})=>boolean;
 prepare:(input:BotModeInput)=>BotModeStep;
}
export type BotModeResolver=(settings:AiSettings,owner?:object)=>BotMode;
/** Source extension contract. Factories must return a fresh seat-owned instance. */
export interface BotModeDefinition {
 readonly id:string;
 readonly label:string;
 readonly capabilities:BotModeSummary['capabilities'];
 validateConfig:(config:unknown)=>void;
 create:(config:unknown)=>BotMode;
}
export type BotModeSummary=import('../../../../contracts/src/index.js').ConsoleStrategy;
