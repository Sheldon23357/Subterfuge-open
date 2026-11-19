/** Public host composition entry. Custom strategies import extension.ts instead. */
export {AgentRuntime} from './application/agent-runtime.js';
export {startAgentConsole} from './application/agent-console.js';
export {parseAgentConfig} from './controller/contracts/agent-config.js';
export type {AgentRuntimeConfig,AgentSeatConfig} from './controller/contracts/agent-config.js';
export type {AgentConsoleOptions} from './application/agent-console.js';
export type {ConsoleService} from './application/console-service.js';
