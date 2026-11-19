export {actionBasisMaterial} from './action-basis.js';
export {encodePromptSections,readPromptSections,readPromptMaterial,type PromptSection,type SavedPromptSection} from './prompt-sections.js';
export {encodeModelData,decodeModelData,readPromptSectionData,MODEL_DATA_PREFIX} from './model-data.js';
export {DISPATCH_LOCK_MESSAGE,dispatchDraftsAllowed} from './dispatch-guard.js';
import type {PlayerDiplomacy,ActivityRules} from '../../rules/src/index.js';
export type {PlayerDiplomacy,RelationView,DiplomacyAction} from '../../rules/src/index.js';
import type {ManualCommandView} from './manual-commands.js';
export * from './manual-commands.js';
export { publicPlayerError } from './player-errors.js';
export {outpostMentions,aiOutpostMentions,type NamedOutpost,type OutpostMention} from './outpost-mentions.js';
export interface OutpostMetrics {
  active: boolean;
  paused: boolean;
  output: number;
  cycleMinutes: number | null;
  nextMinutes: number | null;
  progress: number;
  capacity: number | null;
  used: number | null;
  contribution: number;
  neptunium: number | null;
  mines: number;
}
/** Player protocol contains only fields the authenticated seat may observe.
 * Missing fields mean unknown; clients must not replace them with zero. */
export interface PlayerMapView {
  format:'player-observation/2';launchCancellationLockTick?:number;profile:string;player:number;playerCount:number;teamSize:number;tick:number;
  size:{width:number;height:number};sonar:{center:{x:number;y:number};radius:number}[];fullMapVisible?:boolean;
  match:{mode:'mining'|'domination';neptuniumGoal:number;ended:boolean;activityRules?:ActivityRules}|null;
  self:{mineCreationCost:number;neptunium:number;active:boolean;drillers:number;capacity:number;outpostCount:number;funding:boolean[];activity?:{lastCheckinTime:number;inactivityWarningCount:number;autoResigned:boolean}};
  outposts:{id:string;position:{x:number;y:number};visibility:number;type?:string;destroyed?:boolean;owner?:number|null;drillers?:number;shield?:number;shieldMax?:number;shieldsEnabled?:boolean;minePending?:boolean;mineRemainingSeconds?:number;shieldDisablePending?:boolean;shieldDisableRemainingSeconds?:number;metrics?:OutpostMetrics}[];
  fleets:{id:string;owner:number;position:{x:number;y:number};drillers:number;state:string;gift:boolean;destination:{kind:string;id:string}|null;source?:string|null;secondsUntilLaunch?:number;launchRemainingSeconds?:number;giftPendingSeconds?:number;returned?:boolean;canReturn?:boolean;departureCommitted?:boolean;canCancelLaunch?:boolean;}[];
}
export interface PlayerObservation {
  diplomacy?:PlayerDiplomacy;
  /** Public global cumulative drillers lost; rows are victims, columns opponents. */
  battleLosses?:number[][];
  /** Authoritative own-seat input restriction; expires only when tick advances. */
  dispatchGuard?:{tick:number;lockedSources:string[]};
  /** Exclusive authorized activity cut; independent of transport event cursors. */
  activityCursor?:number;
  manualCommands?:ManualCommandView;
  activity?:PlayerActivityEvent[];
  /** Stable display labels only; never contains the map seed or hidden state. */
  outpostNames?:Record<string,string>;
  roomId:string;view:PlayerMapView;intel:PlayerIntelStatistics[];scheduled:QueuedOrderView[];revision:string;secondsSinceLastTick:number;historyStartTick:number;realtime:boolean;
}
export interface PlayerActivityEvent {
  id:number;kind:string;tick:number;seconds:number;actor:number|null;subject:string;
  source:string|null;destination:{kind:string;id:string}|null;
  drillers:number|null;enabled:boolean|null;
  arrival?:{outpost:string;outcome:'delivered'|'defeated';drillers:number|null};
  termination?:{outcome:'recovered'|'removed';outpost:string|null;drillers:number};
  transfer?:{from:number;to:number;reason:'gift'|'capture'};
  battle?:{attacker:{player:number|null;loss:number};defender:{player:number|null;loss:number}};
}
/** Screening timing only, not a deployment or combat prediction. */
export interface AttackRoutes {
 roomId:string;revision:string;observedTick:number;maxTicks:number;
 basis:'ordinary-speed-public-geometry';
 postTicks:Record<string,Record<string,number|null>>;fleetTicks:Record<string,number|null>;
}
/** The lobby identity remains stable when an early start compacts game seats. */
export interface PlayerLobbyView {
 roomId:string;player:number;revision:number;capacity:number;occupied:boolean[];
 status:'waiting'|'cancelled'|'starting'|'in-progress'|'ended';
 gameSeat?:number|null;secondsRemaining?:number;timing?:import('./room-timing.js').RoomTiming;
}
export interface PlayerLobbyEvent {
 id:number;kind:'joined'|'left'|'cancelled'|'starting'|'started'|'ended';
 actorLobbySeat:number|null;atMs:number|null;seatsAvailable:number|null;
 priority:'normal'|'urgent';notify:boolean;text:string;basis:'original-handler'|'local-service';
}
export function playerLobbyGameSeat(lobby:PlayerLobbyView):number|null{
 return lobby.status==='cancelled'?null:lobby.status==='waiting'?(lobby.occupied[lobby.player]?lobby.player:null):(lobby.gameSeat??null);
}
/** Map geometry shared by current and future player projections. */
export type PlayerMapGeometry=Pick<PlayerMapView,'player'|'size'|'sonar'|'outposts'|'fleets'|'fullMapVisible'>;
export interface ForecastTerminalPrediction {
 /** Determinate only within the stated forecast assumptions, never a live guarantee. */
 status:'determinate'|'conditional'|'unknown';
 firstCrossing:{tick:number;triggeringSeat:number|null;triggeringTeam:number|null}|null;
 reasons:string[];stoppedAtCrossing:boolean;
}
export interface PlayerForecastResult extends PlayerMapGeometry {
 requestedTargetTick?:number;
 terminalPrediction?:ForecastTerminalPrediction;
 format:'player-forecast/2';profile:string;playerCount:number;teamSize:number;
 observedAt:{tick:number;seconds:number};targetTick:number;certainty:'conditional';assumptions:string[];
 self:PlayerMapView['self'];
 match?:{mode:'mining'|'domination';neptuniumGoal:number;ended:{ended:boolean;triggeringSeat:number|null;triggeringTeam:number|null}|null};
 unknownArrivals:{fleetId:string;outpostId:string;tick:number;fraction:number;outcome:'unknown'}[];
 uncertainPlayers:number[];
}
export type PlayerForecastResponse={roomId:string;revision:string}&(
 {status:'unsupported';reasons:string[]}|{status:'conditional';result:PlayerForecastResult;orders:{id:string;issueTick:number;status:string;certainty:'conditional';code?:string;reason?:string}[]}
);
export interface PlayerIntelStatistics {
  player:number;active:boolean;neptunium:number;npPerDay:number;
  outposts:{mine:number;generator:number;factory:number};numOutposts:number;
  drillers:number;output:number;drillerRate:number;
}
export interface PlayerNotification {
 id:number;kind:string;tick:number;seconds:number;text:string;details:string|null;urgent:boolean;sendNotification:boolean;
 location:{kind:'outpost'|'fleet';id:string;position:{x:number;y:number}}|null;
 battle?:{attacker:{player:number|null;before:number;after:number};defender:{player:number|null;before:number;after:number};shield:{before:number;after:number};outcome:string;};
}
export interface PlayerFinalStandings {
  roomId:string;ended:boolean;endTick?:number|null;winners?:number[];teamOrder?:number[];rankingTieBreak?:string;
  players?:{seat:number;rank:number;teamRank:number|null;active:boolean;deathTick:number|null;assumedDeathTime:boolean;neptunium:number;mines:number;outposts:number;drillers:number}[];
}
export type MapGenerationMode = "quantity-priority" | "original";
export interface MatchCreation {mode:'mining'|'domination';teamSize:number;neptuniumGoal:number}
export interface GameScenarioInfo {id:string;title:string;description:string;startTick:number}
export interface MapInitialization {
  algorithm: "apk12075-rules4300" | "quantity-priority-v1";
  composition?: 'generator-45-v1';
  selection?: { territoryCounts: number[]; geometryScore: number };
  players: number;
  requestedSeed: number;
  seed: number;
  score: number;
  startingOrigins: { owner: number; outpostId: string }[];
}
/** Chat identities are credential seats: original lobby seats on the lifecycle
 * listener, game seats on direct listeners. Gameplay compaction never reassigns
 * a private conversation or its read marks to another credential. */
export interface ChatMessage {
  id: string;
  from: number;
  to: number | number[] | null;
  text: string;
  tick: number;
  sentAt: number;
}
export interface ChatConversation {id:string;members:number[]|null;unread:number;messageCount:number;lastMessage:ChatMessage|null}
export function chatMembers(message:Pick<ChatMessage,'from'|'to'>):number[]|null{
  return message.to===null?null:[message.from,...(Array.isArray(message.to)?message.to:[message.to])].sort((a,b)=>a-b);
}
export function chatConversationKey(message:Pick<ChatMessage,'from'|'to'>){return chatMembers(message)?.join(',')??'public';}
/** Explicit omniscient research DTO. Never use this as a multiplayer player view. */
export interface LabView {
  diplomacy?:PlayerDiplomacy;
  battleLosses?:number[][];
  manualCommandsByPlayer?:Record<number,ManualCommandView>;
  /** Stable identity used to scope private commander discussion threads. */
  commanderRoomId?: string;
  /** Private admin-browser prediction source, separate from player observations. */
  predictionSource?: {roomId:string;revision:string};
  autoAdvance?:{enabled:boolean;error:string|null};
  intel?:PlayerIntelStatistics[];
  scenario?:GameScenarioInfo;
  realtime?:boolean;
  orders?:QueuedOrderView[];
  match?: {mode:'mining'|'domination';neptuniumGoal:number;teamSize:number;ended:boolean};
  map?: MapInitialization;
  scheduled: ScheduledLaunch[];
  tick: number;
  size: { width: number; height: number };
  players: { neptunium: number; active: boolean; minesCreated: number }[];
  funding: boolean[][];
  outposts: {
    id: string;
    name: string;
    owner: number | null;
    type: string;
    drillers: number;
    shield: number;
    shieldMax: number;
    metrics: OutpostMetrics;
    shieldsEnabled: boolean;
    minePending: boolean;
    position: { x: number; y: number };
  }[];
  fleets: {
    id: string;
    owner: number;
    drillers: number;
    destination: string;
    position: { x: number; y: number };
    state: string;
    gift: boolean;
    canCancelLaunch: boolean;
    returned?: boolean;
    canReturn?: boolean;
    departureCommitted?: boolean;
    departureMinutes: number;
    arrivalMinutes: number | null;
  }[];
  events: { tick: number; kind: string; subject: string; details: string }[];
  activity?:PlayerActivityEvent[];
  secondsSinceLastTick?:number;
}
export interface QueuedOrderView {
  failed?:boolean;
  id:string;player:number;issueTick:number;status:'pending'|'executed'|'failed'|'cancelled';reason?:string;
  action:{kind:string;[key:string]:unknown};
}
export interface ScheduledLaunch {
  launchSlot?:number;
  failed?:boolean;
  id: string;
  player: number;
  issueTick: number;
  departureTick: number;
  status: "pending" | "executed" | "failed" | "cancelled";
  reason?: string;
  action: {
    kind: "launch";
    source: string;
    destination: string;
    drillers: number;
    delaySeconds?: number;
    fleetId?:string;
  };
}
export { AI_PERSONALITIES, COMMANDER_VOICES } from './ai-personalities.js';
export {AGENT_PROVIDER_PRESETS,type AgentProviderPreset} from './agent-provider-presets.js';
export {diagnosticText,errorDiagnostic,type ErrorDiagnostic} from './diagnostics.js';
export { PLAYER_NAMES } from './player-names.js';

export * from "./world-time.js";

export {ruleNotificationWorldTime,type RuleNotificationWorldTime} from './notification-world-time.js';

export * from "./commander.js";

export * from './player-protocol-wire.js';
export * from './tick-times.js';
export * from './lobby-policy.js';
export {BOT_SETTINGS_SCHEMA_VERSION,BOT_UTILITY_SCALE,DEFAULT_BOT_SETTINGS,LEGACY_BOT_SETTINGS_DEFAULTS,BOT_SETTING_LIMITS,resolveBotSettings,botEffectiveWeights,type BotSettings,type BotSettingsInput,type BotSettingKey,type BotNumericSettings,type LegacyBotSettings} from './bot-settings.js';

export type {BotSearchProgress,BotRuntimeTelemetry,BotLiveSnapshot} from './bot-telemetry.js';
export type {ConsoleSettings,ConsoleStrategy,ConsoleProvider,ConsoleSeat,ConsoleConfigSeat,ConsoleConfiguration} from './ai-console.js';
export type {HubBotLink,HubBotLinks,HubBotLinkCommand,HubSeatIdentity} from './hub-bot-link.js';

export type {HubRoomSummary} from './hub-room.js';

export * from './room-timing.js';
