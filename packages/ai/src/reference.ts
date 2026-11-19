/** Repository-only composition for embedded development scenarios.
 * Release hosts load plugins from folders and never bundle this module. */
import {AgentRuntime as HostRuntime} from './application/agent-runtime.js';
import {SeatRunner as HostSeatRunner} from './application/seat-runner.js';
import {BotModeRegistry} from './controller/contracts/mode-registry.js';
import {hybridDefinition} from '../../../plugins/hybrid/src/index.js';
export const referenceBotModes=new BotModeRegistry([hybridDefinition]);
export const resolveReferenceBotMode=referenceBotModes.resolver();
export class AgentRuntime extends HostRuntime {
 constructor(...[config,provider,env,options]:ConstructorParameters<typeof HostRuntime>){super(config,provider,env,{modes:referenceBotModes,...options});}
}
export class SeatRunner extends HostSeatRunner {
 constructor(...args:ConstructorParameters<typeof HostSeatRunner>){super(args[0],args[1],args[2],args[3],args[4],args[5],args[6]??resolveReferenceBotMode);}
}
export {agentStoreKey} from './application/runtime-entry.js';
