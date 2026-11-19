import {Worker} from 'node:worker_threads';
interface Slot {worker:Worker;key:string;busy:boolean}
interface Waiting {entry:URL;format:string;key:string;signal:AbortSignal;abort:()=>void;resolve:(lease:CoordinatorLease)=>void;reject:(error:unknown)=>void}
export interface CoordinatorLease {worker:Worker;release:(reusable:boolean)=>void}
/** Only completed jobs return to the pool; interrupted synchronous planners
 * must terminate before another round can use their slot. */
export class TacticalCoordinatorPool {
 private slots=new Set<Slot>();private queue:Waiting[]=[];
 constructor(private capacity=8){if(!Number.isSafeInteger(capacity)||capacity<1||capacity>8)throw Error('Invalid coordinator capacity');}
 acquire(entry:URL,format:string,signal:AbortSignal):Promise<CoordinatorLease>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
   const waiting:Waiting={entry,format,key:JSON.stringify([entry.href,format]),signal,resolve,reject,abort:()=>{
    const at=this.queue.indexOf(waiting);if(at<0)return;this.queue.splice(at,1);reject(signal.reason);this.pump();
   }};
   signal.addEventListener('abort',waiting.abort,{once:true});this.queue.push(waiting);this.pump();
  });
 }
 private discard(slot:Slot){
  if(!this.slots.delete(slot))return;slot.worker.unref();void slot.worker.terminate();this.pump();
 }
 private pump(){
  while(this.queue.length){
   const waiting=this.queue[0]!;
   let slot=[...this.slots].find(s=>!s.busy&&s.key===waiting.key);
   if(!slot){
    if(this.slots.size>=this.capacity){const idle=[...this.slots].find(s=>!s.busy);if(!idle)return;this.slots.delete(idle);void idle.worker.terminate();}
    try{
     slot={worker:new Worker(waiting.entry,{workerData:{format:waiting.format}}),key:waiting.key,busy:false};
     this.slots.add(slot);const created=slot;
     slot.worker.on('error',()=>this.discard(created));slot.worker.on('exit',()=>this.discard(created));
    }catch(error){this.queue.shift();waiting.signal.removeEventListener('abort',waiting.abort);waiting.reject(error);continue;}
   }
   this.queue.shift();waiting.signal.removeEventListener('abort',waiting.abort);slot.busy=true;slot.worker.ref();
   const leased=slot;let released=false;
   waiting.resolve({worker:leased.worker,release:reusable=>{
    if(released)return;released=true;if(!reusable){this.discard(leased);return;}
    if(!this.slots.has(leased))return;leased.busy=false;leased.worker.unref();this.pump();
   }});
  }
 }
 close(){
  for(const waiting of this.queue.splice(0)){waiting.signal.removeEventListener('abort',waiting.abort);waiting.reject(Error('Coordinator pool closed'));}
  for(const slot of [...this.slots])this.discard(slot);
 }
}
