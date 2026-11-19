import {GameRequestError,GameTransportError,isReadOnlyRequest} from '../transport/gateway.js';
import {StaleAnalysisResultError,AttackRouteConflictError} from '../analysis/analysis-efficiency.js';


/** Only failures with no unconfirmed game write may resume automatically. */
export function recoveryDelay(error:unknown,attempt:number):number|null {
  if(error instanceof StaleAnalysisResultError){
    if(!error.retryable||attempt>3)return null;
  }else if(error instanceof AttackRouteConflictError){
    if(attempt>3)return null;
  }else if(error instanceof GameTransportError){
    // The durable receipt already confirms the write. Only refresh/reconcile;
    // the gateway fences new writes until an authorized snapshot succeeds.
    if(error.diagnostic?.failure==='accepted-write-followup-failed')return Math.min(300_000,15_000*2**Math.min(attempt-1,5));
    if(error.diagnostic?.outcome!=='read-only'||!['timeout','connection-reset','connection-refused','connection','dns','TRANSPORT_UNCONFIRMED'].includes(error.diagnostic.failure))return null;
  }else if(error instanceof GameRequestError){
    const d=error.diagnostic;
    if(!d||!isReadOnlyRequest(d.method,d.path)||![408,429,500,502,503,504].includes(error.status))return null;
  }else return null;
  return Math.min(300_000,15_000*2**Math.min(attempt-1,5));
}
