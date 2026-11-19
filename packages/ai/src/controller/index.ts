/** Stable foundation for bot modes. No concrete mode or provider implementations. */
export type {BotMode,BotModeResolver,BotModeInput,BotModeStep,BotModeServices,BotModeDiagnosticsInput} from './contracts/bot-mode.js';
export type {AiState,AiSettings,AiSnapshot,AgentRequest,AgentResult,AgentReply,DecisionSignal,DecisionTask,GameGateway} from './contracts/types.js';
export type {PreparedDecisionContext} from './contracts/decision-context.js';
export {memoryContextMetrics} from './contracts/decision-context.js';
export {ControllerSeatRunner} from './runtime/runner.js';
export * as analysis from './analysis/index.js';

export {DEFAULT_EVENT_COALESCE_MS,type SeatPollOptions} from './runtime/runner.js';

export type {AiState as BotState,AiSettings as BotSeatSettings,AiSnapshot as BotSnapshot,AgentRequest as BotStepRequest,AgentResult as BotStepResult,AgentReply as BotInstruction} from './contracts/types.js';
