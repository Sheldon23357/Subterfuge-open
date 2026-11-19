import type {BotMode} from '../contracts/bot-mode.js';
import type {AiState,AiSnapshot,DecisionTask,GameGateway,AgentProvider} from '../contracts/types.js';
import type {DecisionRepository} from '../storage/store-interfaces.js';
import type {RunnerState} from './runner-state.js';
export interface ObservationHost {
 state:Pick<AiState,'roomId'|'lobbySeat'|'notificationCursor'>;
 store:Pick<DecisionRepository,'latest'|'comparisonEvidence'|'reminders'|'arrivalEstimates'|'observeMiningPhase'>;
 save:(kind:string,details?:unknown)=>void;
 saveWake:()=>void;
}
export interface DecisionHost extends ObservationHost {
 mode:BotMode;
 state:AiState;store:DecisionRepository;
 saveEvents:(events:{kind:string;details:unknown}[])=>void;
 gateway:GameGateway;provider:AgentProvider & import('../contracts/types.js').LocalComputation;
  receiptState:()=>import('../execution/receipt-observation.js').ReceiptObservationState;
 collect:(snapshot:AiSnapshot,ownEffects?:boolean)=>void;
 mergePending:(snapshot:AiSnapshot,task:DecisionTask)=>AiSnapshot;
 beginObservationBarrier:()=>()=>void;
 diagnostic:(error:unknown,phase?:RunnerState['phase'])=>unknown;
}
