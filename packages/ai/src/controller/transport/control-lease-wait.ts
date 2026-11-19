import {setTimeout as delay} from 'node:timers/promises';

export interface LeaseStatus {mode:'manual'|'agent';expiresAt:number|null}
/** Wait for one existing lease only. A renewing owner is active: do not take
 * over, extend the wait, or issue acquisition writes while it owns the seat. */
export async function waitForControlLease(read:()=>Promise<LeaseStatus>,options:{signal:AbortSignal;onWait?:(expiresAt:number)=>void;now?:()=>number;sleep?:(ms:number)=>Promise<void>;maxWaitMs?:number}){
  const now=options.now??Date.now,maxWait=options.maxWaitMs??35_000;
  if(!Number.isSafeInteger(maxWait)||maxWait<1||maxWait>120_000)throw Error('Invalid control lease wait limit');
  const started=now(),signal=AbortSignal.any([options.signal,AbortSignal.timeout(maxWait)]);
  const sleep=options.sleep??(ms=>delay(ms,undefined,{signal}));
  // Status reads are read-only. A stalled read must not extend the wait or
  // dispatch an acquisition after pause; its eventual response is ignored.
  const bounded=<T>(operation:()=>Promise<T>)=>new Promise<T>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(options.signal.aborted?options.signal.reason:new Error('CONTROL_LEASE_WAIT_EXPIRED: control status wait timed out; no takeover attempted'));};
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
  let status=await bounded(read);signal.throwIfAborted();
  if(status.mode==='manual')return;
  const expiry=status.expiresAt;
  if(typeof expiry!=='number'||!Number.isFinite(expiry)||expiry-started>maxWait)throw Error('CONTROL_LEASE_BUSY: another agent owns the seat; no takeover attempted');
  options.onWait?.(expiry);
  // Also reread expired leases: the server, rather than the client clock,
  // decides whether ownership has expired.
  const deadline=started+maxWait;
  while(status.mode==='agent'){
    signal.throwIfAborted();
    if(now()>=deadline)throw Error('CONTROL_LEASE_WAIT_EXPIRED: lease did not become available; no takeover attempted');
    await bounded(()=>sleep(Math.max(25,Math.min(500,expiry-now()+25,deadline-now()))));
    signal.throwIfAborted();status=await bounded(read);signal.throwIfAborted();
    if(status.mode==='agent'&&typeof status.expiresAt==='number'&&status.expiresAt>expiry)
      throw Error('CONTROL_LEASE_RENEWED: another active agent renewed its lease; no takeover attempted');
  }
}
