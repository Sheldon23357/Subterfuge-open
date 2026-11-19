import type {BotSettings} from './bot-settings.js';
import type {BotRuntimeTelemetry} from './bot-telemetry.js';
import type {AgentProviderPreset} from './agent-provider-presets.js';
/** Local console DTOs. These are not player/v2 wire capabilities. */
export interface ConsoleSettings {mode?:string;strategyConfig?:unknown;model:string;personality:string;provider?:string;bot?:BotSettings;reasoningEffort?:'low'|'medium'|'high';serviceTier?:'default'|'fast'}
export interface ConsoleStrategy {id:string;label:string;capabilities:{model:boolean;commander:boolean;tacticalSettings?:boolean;personalitySettings?:boolean}}
export interface ConsoleProvider {preset?:AgentProviderPreset;keySource?:'environment'|'session';kind:'offline'|'codex'|'gemini'|'openai-compatible'|'inherited';model?:string;baseUrl?:string;apiStyle?:'chat'|'responses';responseFormat?:'json_schema'|'json_object'|'none';timeoutMs?:number;hasKey:boolean}
export interface ConsoleSeat {model?:string;telemetry?:BotRuntimeTelemetry;diagnosticGeneration?:string;bound?:boolean;controllerSlot?:number;id:string;serverUrl?:string;roomId:string;lobbySeat:number;gamePlayer?:number;chatPlayer?:number;mode:string;status:string;enabled:boolean;busy:boolean;starting?:boolean;waitingForGame?:boolean;stopping?:boolean;calls:number;tokens:number;error:string|null;owned?:boolean}
export interface ConsoleConfigSeat {bound?:boolean;controllerSlot?:number;id:string;serverUrl:string;roomId:string;lobbySeat:number;gamePlayer:number;chatPlayer:number;settings:ConsoleSettings;mode:string;providerConfig:ConsoleProvider}
export interface ConsoleConfiguration {seats:ConsoleConfigSeat[];strategies?:ConsoleStrategy[]}
