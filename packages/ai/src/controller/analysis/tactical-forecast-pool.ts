import {Worker} from 'node:worker_threads';
import {availableParallelism} from 'node:os';
import {createHash} from 'node:crypto';
import {serialize,deserialize} from 'node:v8';
import type {PlayerObservation} from '../../../../contracts/src/index.js';
import type {BotForecastRequest,BotForecastResult} from './tactical-forecast.js';
import {RoundSearchCache,searchInputKey} from './round-search-cache.js';
export interface ForecastMetrics {queueMs:number;computeMs:number;preparationMs:number;transportMs:number;cacheHit:boolean}
export interface ForecastPoolStats {submitted:number;completed:number;cancelled:number;workerStarts:number;contextLoads:number;contextCaptures:number;captureBytes:number;cacheHits:number;queueMs:number;computeMs:number;preparationMs:number;transportMs:number}
export type PreparedForecasts=(requests:BotForecastRequest[],signal:AbortSignal,onMetrics?:((metrics:ForecastMetrics)=>void),cacheRound?:number)=>Promise<BotForecastResult[]>;
interface Job {id:number;basis:string;seat:string;observation:PlayerObservation;request:BotForecastRequest;signal:AbortSignal;resolve:(result:BotForecastResult)=>void;reject:(e:unknown)=>void;abort:()=>void;cancel:Int32Array;enqueued:number;started:number;settled:boolean;cacheRound?:number;cacheKey?:string;onMetrics?:((metrics:ForecastMetrics)=>void)}
interface Slot {worker:Worker;job:Job|null;bases:Set<string>}
export function forecastConcurrency(value=process.env.AI_FORECAST_CONCURRENCY):number{
 if(value===undefined)return Math.max(1,Math.min(8,availableParallelism()-1));
 if(!/^[0-9]+$/.test(value)||Number(value)<1||Number(value)>16)throw Error('AI_FORECAST_CONCURRENCY must be 1..16');
 return Number(value);
}
/** One bounded pool for all seats. Exact observation bytes (including room,
 * player, revision and fractional time) scope prepared worlds and result caches.
 * Seat rotation and per-seat FIFO prevent a large batch starving another bot. */
export class ForecastPool {
 private readonly roundCache=new RoundSearchCache<BotForecastResult>();
 private readonly slots=new Set<Slot>();private queue:Job[]=[];private sequence=0;private lastSeat='';
 private readonly stats:ForecastPoolStats={submitted:0,completed:0,cancelled:0,workerStarts:0,contextLoads:0,contextCaptures:0,captureBytes:0,cacheHits:0,queueMs:0,computeMs:0,preparationMs:0,transportMs:0};
 constructor(readonly concurrency=forecastConcurrency()){
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>16)throw Error('Invalid forecast concurrency');
 }
 snapshot(){return {...this.stats,active:[...this.slots].filter(s=>s.job).length,queued:this.queue.length,workers:this.slots.size};}
 run(observation:PlayerObservation,requests:BotForecastRequest[],signal:AbortSignal,onMetrics?:(metrics:ForecastMetrics)=>void,cacheRound?:number):Promise<BotForecastResult[]>{
  signal.throwIfAborted();
  if(!requests.length)return Promise.resolve([]);
  return this.prepare(observation)(requests,signal,onMetrics,cacheRound);
 }
 /** Private captured bytes cannot be changed by the caller or a later observer. */
 prepare(observation:PlayerObservation):PreparedForecasts{
  const bytes=serialize(observation),basis=createHash('sha256').update(bytes).digest('hex');
  const captured=deserialize(bytes) as PlayerObservation,seat=JSON.stringify([captured.roomId,captured.view.player]);
  this.stats.contextCaptures++;this.stats.captureBytes+=bytes.byteLength;
  return (requests,signal,onMetrics,cacheRound)=>this.runPrepared(captured,basis,seat,requests,signal,onMetrics,cacheRound);
 }
 private runPrepared(captured:PlayerObservation,basis:string,seat:string,requests:BotForecastRequest[],signal:AbortSignal,onMetrics?:((metrics:ForecastMetrics)=>void),cacheRound?:number):Promise<BotForecastResult[]>{
  signal.throwIfAborted();
  if(!requests.length)return Promise.resolve([]);
  // Enqueue the entire batch before dispatch so fairness sees one FIFO per seat.
  const promises=requests.map(request=>new Promise<BotForecastResult>((resolve,reject)=>{
   const cacheKey=basis+':'+searchInputKey(request),cached=cacheRound===undefined?undefined:this.roundCache.get(seat,cacheRound,cacheKey);
   if(cached){this.stats.submitted++;this.stats.completed++;this.stats.cacheHits++;onMetrics?.({queueMs:0,computeMs:0,preparationMs:0,transportMs:0,cacheHit:true});resolve(cached);return;}
   const job:Job={id:++this.sequence,basis,seat,observation:captured,request:structuredClone(request),signal,resolve,reject,abort:()=>this.cancel(job),cancel:new Int32Array(new SharedArrayBuffer(4)),enqueued:performance.now(),started:0,settled:false,...(cacheRound===undefined?{}:{cacheRound,cacheKey}),...(onMetrics?{onMetrics}:{})};
   signal.addEventListener('abort',job.abort,{once:true});this.queue.push(job);this.stats.submitted++;
  }));
  this.pump();return Promise.all(promises);
 }
 private settle(job:Job,error:unknown,result?:BotForecastResult){
  if(job.settled)return;job.settled=true;job.signal.removeEventListener('abort',job.abort);
  if(error)job.reject(error);else{this.stats.completed++;job.resolve(result!);}
 }
 private cancel(job:Job){
  if(job.settled)return;this.stats.cancelled++;Atomics.store(job.cancel,0,1);
  const index=this.queue.indexOf(job);if(index>=0)this.queue.splice(index,1);
  // A running worker observes the flag between engine chunks and is retained.
  // Keep its slot busy until acknowledgement; never overlap independent jobs.
  this.settle(job,job.signal.reason??Error('Forecast cancelled'));this.pump();
 }
 private create():Slot {
  const slot:Slot={worker:new Worker(new URL('./tactical-forecast-worker.js',import.meta.url)),job:null,bases:new Set()};this.slots.add(slot);this.stats.workerStarts++;
  slot.worker.on('message',(message:{id:number;result:BotForecastResult;bases:string[];metrics:{computeMs:number;preparationMs:number;cacheHit:boolean}})=>{
   if(!this.slots.has(slot)||!slot.job)return;const job=slot.job;
   if(message.id!==job.id||!['result','early','error'].includes(message.result?.kind)||!Array.isArray(message.bases)){this.fail(slot,Error('Invalid forecast worker response'));return;}
   slot.bases=new Set(message.bases);slot.job=null;slot.worker.unref();
   const metrics:ForecastMetrics={...message.metrics,queueMs:job.started-job.enqueued,transportMs:Math.max(0,performance.now()-job.started-message.metrics.computeMs)};
   this.stats.queueMs+=metrics.queueMs;this.stats.computeMs+=metrics.computeMs;this.stats.preparationMs+=metrics.preparationMs;this.stats.transportMs+=metrics.transportMs;if(metrics.cacheHit)this.stats.cacheHits++;
   if(!job.settled){if(job.cacheRound!==undefined&&job.cacheKey&&message.result.kind!=='error')this.roundCache.set(job.seat,job.cacheRound,job.cacheKey,message.result);job.onMetrics?.(metrics);this.settle(job,null,message.result);}this.pump();
  });
  slot.worker.on('error',error=>this.fail(slot,error));
  slot.worker.on('exit',code=>{if(this.slots.has(slot))this.fail(slot,Error(`Forecast worker exited (${code})`));});
  slot.worker.unref();return slot;
 }
 private fail(slot:Slot,error:unknown){
  if(!this.slots.delete(slot))return;const job=slot.job;slot.job=null;void slot.worker.terminate();if(job)this.settle(job,error);this.pump();
 }
 private pump(){
  while(this.queue.length){
   const seats=[...new Set(this.queue.map(j=>j.seat))],previous=seats.indexOf(this.lastSeat),seat=seats[(previous+1)%seats.length]!;
   const index=this.queue.findIndex(j=>j.seat===seat),job=this.queue[index]!;
   const idle=[...this.slots].filter(s=>!s.job),slot=idle.find(s=>s.bases.has(job.basis))??idle[0]??(this.slots.size<this.concurrency?this.create():undefined);
   if(!slot)return;
   this.queue.splice(index,1);this.lastSeat=seat;
   if(job.signal.aborted){this.cancel(job);continue;}
   slot.job=job;slot.worker.ref();job.started=performance.now();
   const load=!slot.bases.has(job.basis);if(load)this.stats.contextLoads++;
   try{slot.worker.postMessage({id:job.id,basis:job.basis,...(load?{observation:job.observation}:{}),request:job.request,cacheRound:job.cacheRound,cancel:job.cancel.buffer});}catch(error){this.fail(slot,error);}
  }
 }
 close(){
  this.roundCache.clear();
  for(const job of this.queue.splice(0)){Atomics.store(job.cancel,0,1);this.settle(job,Error('Forecast pool closed'));}
  // Remove all slots before termination so shutdown cannot create replacements.
  const slots=[...this.slots];this.slots.clear();
  for(const slot of slots){if(slot.job){Atomics.store(slot.job.cancel,0,1);this.settle(slot.job,Error('Forecast pool closed'));}void slot.worker.terminate();}
 }
}
const pool=new ForecastPool();
export const botCandidateConcurrency=pool.concurrency;
export function runBotForecasts(o:PlayerObservation,requests:BotForecastRequest[],signal:AbortSignal,onMetrics?:(metrics:ForecastMetrics)=>void,cacheRound?:number){return pool.run(o,requests,signal,onMetrics,cacheRound);}
export function prepareBotForecasts(o:PlayerObservation){return pool.prepare(o);}
export function botForecastPoolStats(){return pool.snapshot();}
export function closeBotForecastPool(){pool.close();}
