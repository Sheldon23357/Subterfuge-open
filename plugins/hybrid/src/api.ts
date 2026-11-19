/** Official strategy with explicitly replaceable components. */
export {createHybridMode,defineHybridMode,hybridDefinition,type HybridModeOptions} from './index.js';
export {makeBrief,type BriefTask} from './brief.js';
export {hybridBriefPrompt,hybridCommanderInstructions} from './prompts.js';
export {hybridCommanderPrompt} from './commander.js';
export {computeBot} from '@subterfuge/bot-sdk/analysis/tactical-worker';
export {botStep} from '@subterfuge/bot-sdk/local/bot-step';
export type {HybridState,StrategicDirective,IntentTask,IntentSpec,SituationBrief} from './contracts.js';
export type {BotDecision,BotPlannerOptions,TacticalGuidance} from '@subterfuge/bot-sdk/analysis/tactical-planner';
