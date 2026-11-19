import type {AiState} from '../contracts/types.js';

/** Synchronous state transition AFTER the entrypoint has authorized explicit
 * resume. The caller owns lease acquisition, terminal/busy checks, review policy
 * and the immediately following journal save. Never starts polling or a model.
 */
export function resumeSeatState(state:Pick<AiState,'enabled'|'status'|'error'|'nextReview'>,nextReview:AiState['nextReview']):void{
 state.enabled=true;
 state.status='waiting';
 state.error=null;
 state.nextReview=nextReview;
}
