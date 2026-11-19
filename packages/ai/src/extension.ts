/** Public source extension entry. No application composition or concrete storage. */
export {BotModeRegistry} from './controller/contracts/mode-registry.js';
export type {BotMode,BotModeDefinition,BotModeSummary,BotModeResolver,BotModeInput,BotModeServices,BotModeStep,BotModeDiagnosticsInput,BotBackground,BotBackgroundServices,BotCommunicationServices,CommunicationResult,CommanderPromptInput} from './controller/contracts/bot-mode.js';
export type {AiSettings,AiSnapshot,AiState,AiMemory,NotebookEntry,AiReminder,MemoryRecord,AgentRequest,AgentResult,AgentReply,AgentProvider,ModelResult,DecisionSignal,DecisionTask} from './controller/contracts/types.js';
export type {PreparedDecisionContext} from './controller/contracts/decision-context.js';
export {buildLocalModeContext} from './controller/contracts/local-mode-context.js';
export {parseAgentReply} from './controller/contracts/reply-protocol.js';
export {agentReplySchema} from './controller/contracts/reply-protocol.js';
export type {PlayerObservation} from '../../contracts/src/index.js';
export {parseModelJson} from './controller/contracts/model-json.js';
export {ProviderError,classifyProviderFailure,type ProviderFailure,type ProviderDiagnostic} from './controller/contracts/provider-error.js';
