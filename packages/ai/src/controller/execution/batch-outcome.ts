import type {PlayerObservation} from '../../../../contracts/src/index.js';
import {GameTransportError} from '../transport/gateway.js';

export interface BatchUnknownOutcome {
 status:'unknown';complete:false;requested:number;processed:number;
 results:Record<string,unknown>[];
}
/** Preserve the accepted prefix and untouched suffix while retaining the
 * transport error's stop/retry policy. Never turn uncertainty into rejection. */
export class BatchTransportError extends GameTransportError {
 constructor(cause:GameTransportError,readonly outcome:BatchUnknownOutcome,readonly observation:PlayerObservation){
  super(cause.diagnostic);
 }
}
