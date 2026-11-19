import {ControllerSeatRunner} from '../controller/runtime/runner.js';
import type {AiState,GameGateway,AgentProvider} from '../controller/contracts/types.js';
import type {RunnerRepository} from '../controller/storage/store-interfaces.js';
import type {MechanicalKeepaliveOptions} from '../controller/runtime/mechanical-keepalive.js';
const missingMode:BotModeResolver=()=>{throw Error('A plugin mode resolver must be supplied by the host');};
import type {BotModeResolver} from '../controller/contracts/bot-mode.js';
/** Host assembly supplies loaded plugins; the runner has no strategy fallback. */
export class SeatRunner extends ControllerSeatRunner {
 constructor(state:AiState,store:RunnerRepository,gateway:GameGateway,provider:AgentProvider & import('../controller/contracts/types.js').LocalComputation,pollIntervalMs=5000,maintenance:MechanicalKeepaliveOptions={},resolveMode:BotModeResolver=missingMode){super(state,store,gateway,provider,pollIntervalMs,maintenance,resolveMode);}
}
