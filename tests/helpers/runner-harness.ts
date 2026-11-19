import type {SeatRunner} from '../../packages/ai/src/reference.js';
import type {RunnerState} from '../../packages/ai/src/controller/runtime/runner-state.js';
import type {AiSnapshot,DecisionTask} from '../../packages/ai/src/controller/contracts/types.js';

/** Focused test seam for causes arriving during an awaited provider step.
 * Public poll remains the lifecycle entry in recovery tests. These tests need
 * exact mid-step injection, not an additional poll/observation side effect.
 * Keep the sole private-layout assertion here; never create shadow fields.
 */
type RunnerHarness={runtime:RunnerState;think:(snapshot:AiSnapshot,task:DecisionTask)=>Promise<void>};
export function runnerTestRuntime(runner:SeatRunner):Pick<RunnerState,'signals'|'latestSnapshot'|'inFlight'>{
  return (runner as unknown as RunnerHarness).runtime;
}
export function runDecisionForTest(runner:SeatRunner,snapshot:AiSnapshot,task:DecisionTask):Promise<void>{
  return (runner as unknown as RunnerHarness).think(snapshot,task);
}
