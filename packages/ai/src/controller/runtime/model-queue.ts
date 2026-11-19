import {ProviderError} from '../contracts/provider-error.js';

/** A typed, definitely-unsent rejection. Never use this for transport failures. */
export class ModelAdmissionStale extends Error {
  readonly code='queued-stale-before-send';
  readonly sent=false;
  constructor(readonly reason:string){super(`Model request became stale before send: ${reason}`);}
}

/** One runtime shares this queue across seats and commander calls. Admission is
 * FIFO within a seat, round-robin across seats; reserved capacity keeps discussions responsive.
 * Provider timeouts start after admission; round/abort signals still apply. */
export class ModelCallQueue {
  private active=0;
  private decisions=0;
  private waiting:{interactive:boolean;fairnessKey?:string;admit:()=>void}[]=[];
  private served=new Map<string,number>();
  private activeSeats=new Set<string>();
  private serial=0;
  private rateLimitCeiling=Infinity;
  private cooldownUntil=0;
  private recoveringSuccesses=0;
  private rateLimitStreak=0;
  private recoveryProbe=false;
  private cooldownTimer:ReturnType<typeof setTimeout>|undefined;
  constructor(private readonly capacity:number|(()=>number)=3,readonly reservedForInteractive=0){
    if(!Number.isSafeInteger(this.limit)||this.limit<1||this.limit>32)throw Error('AI_MODEL_CONCURRENCY must be an integer from 1 to 32');
    if(!Number.isSafeInteger(reservedForInteractive)||reservedForInteractive<0||reservedForInteractive>=this.limit)throw Error('Invalid reserved model capacity');
  }
  get limit(){return Math.min(this.rateLimitCeiling,typeof this.capacity==='function'?this.capacity():this.capacity);}
  get status(){return {limit:this.limit,active:this.active,waiting:this.waiting.length,...(Number.isFinite(this.rateLimitCeiling)?{rateLimit:{ceiling:this.rateLimitCeiling,retryAt:this.cooldownUntil}}:{})};}
  /** Feedback from actual HTTP 429 only, never a guessed provider quota. */
  reportRateLimit(cooldownMs=30000){
    // Failures from the same in-flight wave share one cooldown. Only a new
    // rejection after that cooldown doubles the delay (up to five minutes).
    if(Date.now()>=this.cooldownUntil||this.rateLimitStreak===0)this.rateLimitStreak++;
    const delay=Math.min(300000,cooldownMs*2**Math.min(4,this.rateLimitStreak-1));
    const automatic=Math.max(1,this.limit-this.reservedForInteractive);
    this.rateLimitCeiling=this.reservedForInteractive+Math.max(1,Math.floor(automatic/2));
    this.recoveringSuccesses=0;this.recoveryProbe=true;this.cooldownUntil=Math.max(this.cooldownUntil,Date.now()+delay);
  }
  private recovered(){
    this.recoveryProbe=false;
    if(!Number.isFinite(this.rateLimitCeiling)||++this.recoveringSuccesses<2)return;
    this.rateLimitStreak=0;
    this.recoveringSuccesses=0;this.rateLimitCeiling++;
    const requested=typeof this.capacity==='function'?this.capacity():this.capacity;
    if(this.rateLimitCeiling>=requested)this.rateLimitCeiling=Infinity;
  }
  private pump(){
    if(this.cooldownTimer){clearTimeout(this.cooldownTimer);this.cooldownTimer=undefined;}
    if(Date.now()<this.cooldownUntil){
      if(this.waiting.length){this.cooldownTimer=setTimeout(()=>{this.cooldownTimer=undefined;this.pump();},this.cooldownUntil-Date.now());this.cooldownTimer.unref();}
      return;
    }
    while(this.active<this.limit){
      // A reserved discussion slot must not create another burst while testing
      // recovery. Existing in-flight calls are allowed to finish normally.
      if(this.recoveryProbe&&this.active>0)return;
      const eligible=(t:typeof this.waiting[number])=>(t.fairnessKey===undefined||!this.activeSeats.has(t.fairnessKey))&&(t.interactive||this.decisions<this.limit-this.reservedForInteractive);
      let index=this.waiting.findIndex(eligible);
      if(index<0)return;
      const first=this.waiting[index]!;
      if(!first.interactive&&first.fairnessKey!==undefined){
        for(let i=index+1;i<this.waiting.length;i++){
          const ticket=this.waiting[i]!;
          if(eligible(ticket)&&!ticket.interactive&&ticket.fairnessKey!==undefined
            &&(this.served.get(ticket.fairnessKey)??0)<(this.served.get(this.waiting[index]!.fairnessKey!)??0))index=i;
        }
      }
      const selected=this.waiting[index]!;
      if(!selected.interactive&&selected.fairnessKey!==undefined)this.served.set(selected.fairnessKey,++this.serial);
      this.waiting.splice(index,1)[0]!.admit();
    }
  }
  async run<T>(signal:AbortSignal,call:()=>Promise<T>,options:{interactive?:boolean;fairnessKey?:string;beforeSend?:()=>void|Promise<void>;onStart?:(waitMs:number)=>void;onQueueWait?:(waitMs:number,admitted:boolean)=>void}={}):Promise<T>{
    const started=Date.now();
    const interactive=options.interactive===true;
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{const i=this.waiting.indexOf(ticket);if(i>=0)this.waiting.splice(i,1);signal.removeEventListener('abort',abort);options.onQueueWait?.(Date.now()-started,false);reject(new ProviderError('cancelled',undefined,{stage:'queue-admission',outcome:'not-sent'}));};
      const admit=()=>{signal.removeEventListener('abort',abort);if(signal.aborted){options.onQueueWait?.(Date.now()-started,false);reject(new ProviderError('cancelled',undefined,{stage:'queue-admission',outcome:'not-sent'}));return;}this.active++;if(options.fairnessKey!==undefined)this.activeSeats.add(options.fairnessKey);if(!interactive)this.decisions++;options.onQueueWait?.(Date.now()-started,true);resolve();};
      const ticket={interactive,...(options.fairnessKey!==undefined?{fairnessKey:options.fairnessKey}:{}),admit};
      if(signal.aborted){abort();return;}
      this.waiting.push(ticket);signal.addEventListener('abort',abort,{once:true});this.pump();
    });
    try{
      if(signal.aborted)throw new ProviderError('cancelled',undefined,{stage:'queue-admission',outcome:'not-sent'});
      // This callback runs inside the acquired slot, before diagnostics or any
      // provider transport. A rejection releases the slot and does not retry it.
      await options.beforeSend?.();
      if(signal.aborted)throw new ProviderError('cancelled',undefined,{stage:'queue-admission',outcome:'not-sent'});
      options.onStart?.(Date.now()-started);
      const result=await call();this.recovered();return result;
    }
    catch(error){
      if(error instanceof ProviderError&&(error.diagnostic?.httpStatus===429||error.diagnostic?.reason==='rate-limit'))this.reportRateLimit();
      throw error;
    }
    finally{this.active--;if(options.fairnessKey!==undefined)this.activeSeats.delete(options.fairnessKey);if(!interactive)this.decisions--;this.pump();}
  }
}
