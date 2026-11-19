import {randomUUID,createHash} from 'node:crypto';
import {GameTransportError} from '../transport/gateway.js';
export interface WriteContext {turn:string;deadline:number;signal:AbortSignal;revision:string;instructionsVersion?:number}
export type DebugStopReason='paused'|'discarded'|'expired'|'stale'|'context-missing'|'control-lost';
export class DebugStopError extends GameTransportError {
  constructor(readonly reason:DebugStopReason){super();this.name='DebugStopError';this.message=`Debug write stopped: ${reason}`;}
  override get displayReason(){return `Debug write was not sent (${this.reason}); inspect current state and explicitly replan.`;}
}
export function debugDigest(value:unknown):string{
  const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
interface Held {id:string;requestDigest:string;context:WriteContext;expiresAt:number;path:string;data:unknown;resolve:()=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>;abort:()=>void;validating:boolean}
/** One finite, cancellable write boundary. No network or model calls of its own. */
export class WriteBreakpointGate {
  enabled=false;ttlMs=30000;
  private held:Held|null=null;
  private last:{id:string;outcome:string;reason?:string}|null=null;
  status(){const h=this.held;return {enabled:this.enabled,ttlMs:this.ttlMs,pending:h?{id:h.id,turn:h.context.turn,revision:h.context.revision,path:h.path,requestDigest:h.requestDigest,data:structuredClone(h.data),expiresAt:h.expiresAt,validating:h.validating}:null,last:this.last?{...this.last}:null};}
  async beforeWrite(path:string,data:unknown,context:WriteContext|null){
    if(!this.enabled)return;
    if(!context)throw new DebugStopError('context-missing');
    if(context.signal.aborted)throw new DebugStopError('paused');
    if(Date.now()>=context.deadline)throw new DebugStopError('expired');
    if(this.held)throw new DebugStopError('context-missing');
    const expiresAt=Math.min(context.deadline,Date.now()+this.ttlMs),id=randomUUID();
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>this.cancel('paused');
      const timer=setTimeout(()=>this.cancel('expired'),Math.max(1,expiresAt-Date.now()));
      this.held={id,requestDigest:debugDigest({path,data}),context,expiresAt,path,data:structuredClone(data),resolve,reject,timer,abort,validating:false};
      context.signal.addEventListener('abort',abort,{once:true});
      if(context.signal.aborted)this.cancel('paused');
    });
  }
  private clear(h:Held){clearTimeout(h.timer);h.context.signal.removeEventListener('abort',h.abort);this.held=null;}
  cancel(reason:DebugStopReason='discarded'){
    const h=this.held;if(!h)return;this.clear(h);this.last={id:h.id,outcome:'not-sent',reason};h.reject(new DebugStopError(reason));
  }
  rejectDispatch(reason:DebugStopReason){this.last={id:this.last?.id??'',outcome:'not-sent',reason};}
  async resume(id:string,validate:(context:WriteContext)=>Promise<void>){
    const h=this.held;if(!h||h.id!==id||h.validating)throw Error('No matching resumable breakpoint');
    h.validating=true;
    try{
      if(Date.now()>=h.expiresAt||h.context.signal.aborted)throw new DebugStopError(h.context.signal.aborted?'paused':'expired');
      await validate(h.context);
      if(this.held!==h||h.context.signal.aborted||Date.now()>=h.expiresAt)throw new DebugStopError('expired');
      this.clear(h);this.last={id:h.id,outcome:'released'};h.resolve();
    }catch(error){const stopped=error instanceof DebugStopError?error:new DebugStopError('control-lost');if(this.held===h){this.clear(h);this.last={id:h.id,outcome:'not-sent',reason:stopped.reason};h.reject(stopped);}throw stopped;}
  }
  discard(id:string){if(this.held?.id!==id)throw Error('No matching breakpoint');this.cancel('discarded');}
}
