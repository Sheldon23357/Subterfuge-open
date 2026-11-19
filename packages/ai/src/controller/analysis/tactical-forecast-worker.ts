import {parentPort} from 'node:worker_threads';
import type {PlayerObservation} from '../../../../contracts/src/index.js';
import {executeBotForecast,type BotForecastRequest} from './tactical-forecast.js';
import {prepareKnownPrediction} from '../../../../prediction/src/index.js';
import {createHash} from 'node:crypto';
import {serialize} from 'node:v8';
const bases=new Map<string,{observation:PlayerObservation;prepared:ReturnType<typeof prepareKnownPrediction>}>();
const results=new Map<string,{result:ReturnType<typeof executeBotForecast>;bytes:number}>();
let resultBytes=0;
type ForecastJob={id:number;observation:PlayerObservation;request:BotForecastRequest}|{id:number;basis:string;observation?:PlayerObservation;request:BotForecastRequest;cacheRound?:number;cancel:SharedArrayBuffer};
parentPort!.on('message',(job:ForecastJob)=>{
 // A build may replace the worker entry while the existing controller still
 // owns its previous in-memory pool. Keep those already-running seats usable
 // until their coordinated restart; this is not a saved-state migration.
 if(!('basis' in job)){parentPort!.postMessage({id:job.id,result:executeBotForecast(job.observation,job.request)});return;}
 const start=performance.now(),cancel=new Int32Array(job.cancel),cancelled=()=>Atomics.load(cancel,0)!==0;
 let preparationMs=0,cacheHit=false;
 let result:ReturnType<typeof executeBotForecast>;
 try{
  if(cancelled())throw Error('Forecast cancelled');
  let base=bases.get(job.basis);
  if(!base){
   if(!job.observation)throw Error('Forecast observation is not loaded');
   const prepareStart=performance.now();
   base={observation:job.observation,prepared:prepareKnownPrediction(job.observation)};
   preparationMs=performance.now()-prepareStart;bases.set(job.basis,base);
  }
  bases.delete(job.basis);bases.set(job.basis,base);
  while(bases.size>4){const key=bases.keys().next().value!;bases.delete(key);for(const [id,row] of results)if(id.startsWith(key+':')){results.delete(id);resultBytes-=row.bytes;}}
  // Preserve undefined properties and non-JSON numeric values too: strict
  // argument validation must never inherit a valid request's cached result.
  const key=job.basis+':'+createHash('sha256').update(serialize(job.request)).digest('hex')+':'+(job.cacheRound??'unscoped'),saved=results.get(key);
  if(saved){cacheHit=true;results.delete(key);results.set(key,saved);result=saved.result;}
  else{
   result=executeBotForecast(base.observation,job.request,base.prepared,cancelled);
   if(result.kind!=='error'&&!cancelled()){
    const bytes=Buffer.byteLength(JSON.stringify(result));
    if(bytes<=4*1024*1024){results.set(key,{result,bytes});resultBytes+=bytes;}
    while(resultBytes>4*1024*1024||results.size>32){const oldest=results.keys().next().value!;resultBytes-=results.get(oldest)!.bytes;results.delete(oldest);}
   }
  }
 }catch(error){result={kind:'error',message:error instanceof Error?error.message:'Forecast worker failed'};}
 parentPort!.postMessage({id:job.id,result,bases:[...bases.keys()],metrics:{preparationMs,computeMs:performance.now()-start,cacheHit}});
});
