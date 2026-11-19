import type {
  PlayerObservation,
  ChatMessage,
  PlayerNotification,
} from "../../../../contracts/src/index.js";

import { AI_PERSONALITIES,observationRuleSeconds,resolveBotSettings,type ConsoleSettings } from '../../../../contracts/src/index.js';
export const PERSONALITIES = Object.fromEntries(Object.entries(AI_PERSONALITIES).map(([id,p])=>[id,p.description])) as {[K in keyof typeof AI_PERSONALITIES]:string};
export type Personality = keyof typeof PERSONALITIES;
export interface AiSettings extends Omit<ConsoleSettings,'personality'> {personality:Personality;}

export interface AiMemory {
  strategy: string;
  relations: string;
  agreements: string;
  deceptions: string;
}
export interface AiState {
  format: "ai-seat/2";
  roomId: string;
  lobbySeat: number;
  enabled: boolean;
  settings: AiSettings;
  status: "waiting" | "thinking" | "paused" | "error" | "ended";
  error: string | null;
  calls: number;
  tokens: number;
  sequence: number;
  memory: AiMemory;
  /** Player-confirmed authority; never editable through model memory tools. */
  commanderDirectives?: {version:number;text:string};
  lastThought: number | null;
  nextReview: number | null;
  lastRevision: string | null;
  chatCursor: number;
  notificationCursor: number;
  lastSpoke: number | null;
}
export interface AiSnapshot {
  /** Program-owned observed milestone, never model-authored strategy memory. */
  miningPhase?:import('../analysis/mining-phase.js').MiningPhaseContext|null;
  /** Program-owned unresolved writes and factual observers, independent of round reads. */
  executionLedger?:{pending:import('../storage/store-interfaces.js').PendingWriteEvidence[];observations:import('../execution/receipt-observation.js').ReceiptObservation[];notices:ReturnType<typeof import('../execution/execution-evidence.js').pendingExecutionEvidence>['notices']};
  /** Last ordinary finish that reconciled manual facts; never commander authority. */
  manualReviewedVersion?:number;
  manualReviewedReceiptIds?:string[];
  memoryConsistency?:import('../storage/memory-consistency.js').MemoryConsistency;
  /** At least one notification/chat page remains unread. */
  hasMore?: boolean;
  communication?:ReturnType<typeof import('../analysis/chat-budget.js').chatBudget>;
  campaigns?:import("../storage/campaign-state.js").Campaign[];
  attackScreening?:import('../analysis/attack-screening.js').AttackScreeningSummary;
  task?:DecisionTask;
  notebook?:NotebookEntry[];
  /** Internal private lifecycle index; prompt renderers only expose referenced summaries. */
  notebookDependencies?:import('../storage/notebook-dependencies.js').NotebookDependencySummary[];
  changes?:unknown;
  reminders?:AiReminder[];
  observation: PlayerObservation;
  chat: ChatMessage[];
  notifications: PlayerNotification[];
  chatCursor: number;
  notificationCursor: number;
  chatPlayer: number;
  chatCount: number;
  roster?: { chatPlayer: number; gamePlayer: number; displayName?: string }[];
}
export type DecisionCategory='strategy'|'diplomacy'|'military'|'plan';
/** Event identity is authored at the producer, never inferred from display prose. */
export type DecisionTriggerKind='opening'|'resume'|'recovery'|'diplomacy-message'|'reminder-due'|'campaign-review'|'activity-warning'|'mining-phase-change'|'construction-change'|'investment-opportunity'|'player-eliminated'|'battle-notice'|'outpost-control-change'|'fleet-state-change'|'arrival-check'|'threat-change'|'attack-premise-change'|'execution-failure'|'manual-command-change'|'memory-review'|'unknown';
export interface DecisionTriggerSource {kind:'observation'|'notification'|'chat'|'reminder'|'runtime'|'user';id:string;observedSeconds?:number}
export interface DecisionSignal {key:string;category:DecisionCategory;reason:string;urgent:boolean;entities:string[];scope?:'local'|'global';kind?:DecisionTriggerKind;sources?:DecisionTriggerSource[];role?:'new-trigger'|'inherited-trigger';relatedCampaignIds?:string[];reviewRequirements?:{factsNeeded:boolean;strategicReview:boolean;cleanupNeeded:boolean};requiresFullContext?:boolean;notebookReview?:boolean}

export interface DeferredEvent {key:string;summary:string;count:number;firstSeconds:number;lastSeconds:number}
export interface DecisionTask {/** Absent means pre-contract input, not permission to guess typed causes. */triggers?:DecisionSignal[];scope?:'local'|'global';timing?:{observedSeconds:number;waitingDepartures:{id:string;secondsRemaining:number}[];dueReminders:string[]};category:DecisionCategory;weight:'light'|'medium'|'heavy';reasons:string[];entities:string[];deferred:DeferredEvent[];fullContext?:boolean;notebookReview?:boolean;memoryReview?:{factsNeeded:boolean;strategicReview:boolean;cleanupNeeded:boolean}}
export interface NotebookEntry {priority?:'high'|'medium'|'low';manualIntent?:import('../execution/manual-coordination.js').ManualIntent;id:string;kind:'fact'|'plan'|'agreement'|'note';text:string;updatedAt:number;expiresAt:number|null;basis?:'observed'|'reported'|'predicted'|'inferred'|'decision';basisTick?:number;record?:MemoryRecord}
/** Optional structured records are authored explicitly, never inferred from old prose. */
export interface MemoryRecord {
  type:'relation'|'agreement'|'plan';
  status:string;
  summary:string;
  players:number[];
  entities:string[];
  links:string[];
  evidence:string[];
  reviewAt:number|null;
  scores?:{trust:number|null;hostility:number|null;threat:number|null;cooperation:number|null;confidence:number};
}
export interface AiReminder {/** System-owned provenance; ordinary authored reminders cannot manufacture it. */source?:{kind:'campaign';campaignId:string};id:string;atSeconds:number;note:string;category?:'plan'|'military'|'strategy';entities?:string[]}
export interface AgentReply {
  tool: string;
  arguments: string | Record<string,unknown>;
  summary: string;
  /** Reserved null in the commander reply envelope. */
  nextContext?:null;
}
/** Durable handoff receipt. Pending is not proof of remote execution or rejection. */
export interface ModelDispatchReceipt {
 id:string;status:'pending'|'settled';boundary:'provider-adapter-handoff';
 outcome?:'not-sent'|'rejected'|'completed'|'unknown';
 sequence?:number;step?:number;attempt?:number;
 mode?:'discuss'|'reconcile';version?:number;messageId?:string;latestPlayerMessage?:string;
}
export interface ModelOutputAudit {text:string;characters:number;clipped:boolean}
export interface AgentRequest {
  /** Host audit correlation; never included in provider prompt/body fields. */
  audit?:{callId?:string;kind?:string;task?:string;attempt?:number;lane?:'background'};
  /** Host-owned server/room/player identity, never model-authored. Codex uses it
   * to isolate reusable empty threads; absent requests retain one-shot exec. */
  providerSessionKey?:string;
  /** Stable model-task identity inside one bot. Retries and partitions retain
   * their original task; this metadata is never sent as model context. */
  providerSessionScope?:{kind:string;task:string};
  /** Only the commander worker selects an isolated discussion/reconciliation contract. */
  commanderMode?:'discuss'|'reconcile';
  /** Queue admission only: invoked after acquiring a slot and before transport. */
  beforeSend?:()=>void|Promise<void>;
  /** Actual provider handoff, not a queued/reserved request. */
  onSend?:(waitMs:number)=>void;
  /** Bounded, credential-redacted final message text for private audit before parsing. */
  onOutput?:(output:ModelOutputAudit)=>void;
  effort?:'low'|'medium'|'high';
  serviceTier?:'default'|'fast';
  /** Per-call time allowance, independent of reasoning effort; explicit provider configuration wins. */
  timeoutMs?:number;
  responseSchema?:Record<string,unknown>;
  prompt: string;
  model: string;
  provider?: string;
  signal: AbortSignal;
}
export interface ModelResult<T=Record<string,unknown>> {
  /** Verified provider termination; distinct from semantic validation/publication. */
  completion?:{protocol:'chat'|'responses';status:'completed';finishReason:'stop'|'completed';responseId?:string};
  /** Provider-reported session identity and hashes of the actual Codex inputs;
   * these describe transport, never cache hits or game/conversation identity. */
  providerContext?:{kind:'codex';sessionMode:'ephemeral'|'revert';threadId?:string;sessionScope?:{kind:string;task:string};reusedSession?:boolean;historyBefore?:number;historyAfter?:number;historyAfterReset?:number;schemaProjection?:'openai-strict/2';instructionsSha256?:string;schemaSha256?:string};
  /** Parsed transport JSON. Semantic interpretation belongs to the caller. */
  reply:T;
  tokens: number;
  usage?:{inputTokens:number;outputTokens:number;cachedInputTokens?:number};
  /** Explicit measurement availability; absent on legacy adapters, never inferred from zero. */
  usageKnown?:{provenance:'reported'|'synthetic';input:boolean;output:boolean;cached:boolean};
}
/** Action proposals are produced by strategies, never by transport parsing. */
export interface AgentResult extends ModelResult<AgentReply> {
 executionObservation?:PlayerObservation;
}
export interface AgentProvider {
  step(request: AgentRequest): Promise<ModelResult<unknown>>;
}
export interface LocalComputation {

  /** Runtime checkpoint/admission hook for local computation; never a model transport. */
  computeLocal?(request:AgentRequest,compute:(admitted:AgentRequest)=>Promise<AgentResult>):Promise<AgentResult>;
}
export interface GameGateway {
  readonly batchAvailable?:boolean;
  orderBatch?(id:string,actions:readonly Record<string,unknown>[],revision:string):Promise<{observation:PlayerObservation;results:Record<string,unknown>[];requested:number;processed:number;complete:boolean}>;
 readActivity?(after:number,through:number):Promise<unknown>;
  factBaseline?(read:(current:PlayerObservation)=>import('../observation/activity-facts.js').FactBaseline|undefined):void;
  reconcileWrites?(requests:readonly import('../execution/write-reconciliation.js').PendingWriteRequest[]):Promise<import('../execution/write-reconciliation.js').WriteResolution[]>;
  writeContext?(context:{turn:string;deadline:number;signal:AbortSignal;revision:string;instructionsVersion?:number}|null):void;
  withWriteContext?<T>(context:{turn:string;deadline:number;signal:AbortSignal;revision:string;instructionsVersion?:number},run:()=>Promise<T>):Promise<T>;
  /** Local test scheduler token. Never sent to the model or player API. */
  advanceVersion?(): string;
  /** Check the server authority before committing a model-authored effect. */
  authorityCheck?(commanderVersion:number,manualVersion:number):Promise<void>;
  commanderCheck?(version:number):Promise<void>;
  manualCheck?(version:number):Promise<void>;
  forecastBatch?(observation:PlayerObservation,scenarios:{id:string;targetTick:number;drafts:unknown[]}[]):Promise<{roomId:string;revision:string;scenarios:{id:string;targetTick:number;drafts:unknown[];result:unknown}[]}>;
  attackRoutes?(observation:PlayerObservation,windows?:{attackTicks:number;localTicks:number;holdTicks:number}):Promise<import('../../../../contracts/src/index.js').AttackRoutes>;
  snapshot(chatCursor: number, notificationCursor: number, backgroundOnly?:boolean): Promise<AiSnapshot>;
  request(path: string, data: unknown): Promise<unknown>;
}
export function validateSettings(raw: unknown): AiSettings {
  const s = raw as AiSettings;
  if (
    !s ||
    typeof s !== "object" ||
    !Object.keys(s).every(key => key === 'strategyConfig' || key === 'mode' || key === 'model' || key === 'personality' || key === 'provider' || key === 'bot' || key === 'reasoningEffort' || key === 'serviceTier') ||
    s.mode!==undefined&&(typeof s.mode!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(s.mode)) ||
    s.provider==='programmatic' ||
    !Object.hasOwn(s, 'model') || !Object.hasOwn(s, 'personality') ||
    typeof s.model !== "string" ||
    s.model.length > 100 ||
    !Object.hasOwn(PERSONALITIES, s.personality) ||
    s.provider !== undefined && (typeof s.provider !== 'string' || s.provider.length > 60) ||
    s.reasoningEffort !== undefined && !['low','medium','high'].includes(s.reasoningEffort) ||
    s.serviceTier !== undefined && !['default','fast'].includes(s.serviceTier)
  )
    throw Error("Invalid AI settings");
  return { ...s, mode:s.mode??'hybrid', model: s.model.trim(), ...(s.provider !== undefined ? { provider: s.provider.trim() } : {}),...(s.bot!==undefined?{bot:resolveBotSettings(s.bot)}:{}) };
}
export function initialState(
  roomId: string,
  lobbySeat: number,
  settings: AiSettings,
): AiState {
  return {
    format: "ai-seat/2",
    roomId,
    lobbySeat,
    enabled: true,
    settings: validateSettings(settings),
    status: "waiting",
    error: null,
    calls: 0,
    tokens: 0,
    sequence: 0,
    memory: { strategy: "", relations: "", agreements: "", deceptions: "" },
    lastThought: null,
    nextReview: null,
    lastRevision: null,
    chatCursor: 0,
    notificationCursor: 0,
    lastSpoke: null,
  };
}
export function gameSeconds(s: AiSnapshot) {
  return observationRuleSeconds(s.observation);
}
