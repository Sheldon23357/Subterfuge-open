import {isMainThread,parentPort,workerData} from 'node:worker_threads';
import type {PlayerObservation,AttackRoutes,BotSearchProgress} from '../../../../contracts/src/index.js';
import {planBotAsync,type BotPlannerOptions,type BotDecision} from './tactical-planner.js';
import {StaleAnalysisResultError} from './analysis-efficiency.js';
import {botCandidateConcurrency,prepareBotForecasts} from './tactical-forecast-pool.js';
import type {BotForecastRequest,BotForecastResult} from './tactical-forecast.js';
import {TacticalCoordinatorPool,type CoordinatorLease} from './tactical-coordinator-pool.js';
interface Input {observation:PlayerObservation;routes:AttackRoutes;options:Omit<BotPlannerOptions,'signal'|'onCheckpoint'|'onProgress'>}
type WorkerError=string|{code:'analysis-stale';expected:StaleAnalysisResultError['expected'];actual:StaleAnalysisResultError['actual']};
interface Message {jobId:number;progress?:BotSearchProgress;kind?:string;id?:number;requests?:BotForecastRequest[];decision?:BotDecision;checkpoint?:BotDecision;error?:WorkerError}

export function runBotWorkerPlanner(planner:typeof planBotAsync):void {
 let active:number|undefined,sequence=0;
 const port=parentPort!;
 const pending=new Map<number,{resolve:(r:BotForecastResult[])=>void;reject:(e:Error)=>void}>();
 port.on('message',(message:{kind:string;jobId:number;input?:Input;id:number;results?:BotForecastResult[];error?:string})=>{
  if(message.kind==='forecast-result'){
   if(message.jobId!==active)return;
   const task=pending.get(message.id);if(!task)return;pending.delete(message.id);
   if(message.error)task.reject(Error(message.error));else task.resolve(message.results!);return;
  }
  if(message.kind!=='plan'||active!==undefined||!message.input)return;
  const {jobId,input}=message;active=jobId;sequence=0;
  const send=(data:Omit<Message,'jobId'>)=>port.postMessage({...data,jobId});
  void Promise.resolve().then(()=>planner(input.observation,input.routes,{
   ...input.options,onProgress:progress=>send({progress}),
   ...(input.options.guidance||input.options.validationCandidate?{onCheckpoint:(decision:BotDecision)=>send({checkpoint:decision})}:{}),
  },requests=>new Promise((resolve,reject)=>{
   const id=++sequence;pending.set(id,{resolve,reject});send({kind:'forecast',id,requests});
  }))).then(decision=>{
   pending.clear();active=undefined;send({decision});
  },error=>{
   pending.clear();active=undefined;
   send({error:error instanceof StaleAnalysisResultError?{code:'analysis-stale',expected:error.expected,actual:error.actual}:error instanceof Error?error.message:'Programmatic computation failed'});
  });
 });
}
if(!isMainThread&&workerData?.format==='bot-worker/1')runBotWorkerPlanner(planBotAsync);

const coordinators=new TacticalCoordinatorPool();let jobSequence=0;
/** Fresh inputs and forecast context per job; completed coordinators retain
 * loaded modules, but never a preceding round's planner or pending replies. */
export function computeBot(observation:PlayerObservation,routes:AttackRoutes,options:BotPlannerOptions={}):Promise<BotDecision>{
 return computeBotWithEntry(new URL('./tactical-worker.js',import.meta.url),'bot-worker/1',observation,routes,options);
}
export function computeBotWithEntry(entry:URL,format:string,observation:PlayerObservation,routes:AttackRoutes,options:BotPlannerOptions={}):Promise<BotDecision>{
 const {signal,onCheckpoint,onProgress,...limits}=options;signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const controller=new AbortController(),forecastsForRound=prepareBotForecasts(observation),jobId=++jobSequence;
  let settled=false,lease:CoordinatorLease|undefined,checkpoint:BotDecision|undefined;
  const forecasts={cacheHits:0,queueMs:0,computeMs:0};
  const finish=(error:unknown,decision?:BotDecision,reusable=false)=>{
   if(settled)return;settled=true;if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);
   controller.abort(error??Error('Decision completed'));
   if(lease){lease.worker.off('message',onMessage);lease.worker.off('error',onError);lease.worker.off('exit',onExit);lease.release(reusable);}
   if(error)reject(error);else{
    if(limits.forecastCacheRound!==undefined)decision!.policyDiagnostics={...decision!.policyDiagnostics,forecastReuse:{...forecasts}};
    resolve(decision!);
   }
  };
  const timer=limits.guidance||limits.validationCandidate?setTimeout(()=>{
   if(checkpoint){checkpoint.coverage.complete=false;checkpoint.coverage.stopReason='time-budget';finish(null,checkpoint);}
   else finish(Error('Tactical deadline before baseline'));
  },limits.maxElapsedMs??5000):undefined;
  const abort=()=>finish(signal?.reason??Error('Programmatic computation cancelled'));
  const onError=(error:Error)=>finish(error);
  const onExit=(code:number)=>finish(Error(`Programmatic worker exited without a result (${code})`));
  const onMessage=(message:Message)=>{
   if(settled||message.jobId!==jobId)return;
   try{
    if(message.progress){onProgress?.(message.progress);return;}
    if(message.checkpoint){checkpoint=message.checkpoint;onCheckpoint?.(checkpoint);return;}
    if(message.kind==='forecast'){
     if(!Number.isSafeInteger(message.id)||!Array.isArray(message.requests)||!message.requests.length||message.requests.length>8){finish(Error('Invalid candidate forecast batch'));return;}
     void forecastsForRound(message.requests,controller.signal,m=>{if(m.cacheHit)forecasts.cacheHits++;forecasts.queueMs+=m.queueMs;forecasts.computeMs+=m.computeMs;},limits.forecastCacheRound).then(results=>{
      if(!settled)lease!.worker.postMessage({kind:'forecast-result',jobId,id:message.id,results});
     },error=>finish(error));return;
    }
    if(message.error)finish(typeof message.error==='string'?Error(message.error):new StaleAnalysisResultError(message.error.expected,message.error.actual),undefined,true);
    else if(message.decision?.format!=='deterministic-bot-decision/1'||message.decision.basisRevision!==observation.revision)finish(Error('Invalid programmatic worker result'));
    else finish(null,message.decision,true);
   }catch(error){finish(error);}
  };
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted){abort();return;}
  void coordinators.acquire(entry,format,controller.signal).then(acquired=>{
   if(settled){acquired.release(true);return;}lease=acquired;
   lease.worker.on('message',onMessage);lease.worker.once('error',onError);lease.worker.once('exit',onExit);
   try{lease.worker.postMessage({kind:'plan',jobId,input:{observation,routes,options:{...limits,parallelism:limits.parallelism??Math.min(5,botCandidateConcurrency)}}});}catch(error){finish(error);}
  },error=>finish(error));
 });
}
