import type {HybridState} from './contracts.js';
/** Expired intent history stays in storage; execution receipts have their own lifecycle. */
export function contextIntents(state:HybridState|undefined,worldDay:number){
 return (state?.intents??[]).filter(t=>t.status!=='expired'&&t.spec.until>worldDay);
}
