/** Read-only replay benchmark. Inputs are captured authorized observations;
 * no server/model connection or game writes. Select an isolated baseline build
 * with --modules=runtime/outputs/.../baseline and compare result hashes. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {availableParallelism,cpus} from 'node:os';
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const at=a.indexOf('=');return[a.slice(2,at),a.slice(at+1)];}));
if(!args.input||!args.output)throw Error('Use --input=observations.json --output=report.json [--modules=dist] [--repeat=2]');
const load=relative=>import(pathToFileURL(path.resolve(args.modules??'dist','packages',relative)).href);
const {executeBotForecast}=await load('ai/src/controller/analysis/tactical-forecast.js');
const {runBotForecasts,closeBotForecastPool,botCandidateConcurrency,botForecastPoolStats}=await load('ai/src/controller/analysis/tactical-forecast-pool.js');
const {createKnownPrediction}=await load('prediction/src/index.js');
const data=JSON.parse(fs.readFileSync(args.input,'utf8')),repeat=Number(args.repeat??2);
if(!Array.isArray(data)||!data.length||data.some(v=>!v.observation?.view||!Array.isArray(v.requests)||!v.requests.length)||!Number.isSafeInteger(repeat)||repeat<1||repeat>20)throw Error('Expected nonempty authorized observations/requests and repeat=1..20');
if((args.lanes??'serial,pool').split(',').some(lane=>!['serial','pool'].includes(lane)))throw Error('Lanes must be serial,pool');
if(args.unique==='true')for(const input of data){const seen=new Set();input.requests=input.requests.filter(r=>{const key=JSON.stringify(r);if(seen.has(key))return false;seen.add(key);return true;});}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows=[],setup=[];
try{
 for(const input of data){
  const request=input.requests[0],start=performance.now();
  const session=createKnownPrediction(input.observation,{drafts:request.drafts??[],pathPredicates:request.predicates??[],collectResourceFrames:true});
  const ready=performance.now();session.predict(request.targetTick);
  setup.push({seat:input.observation.view.player,buildMs:ready-start,advanceProjectMs:performance.now()-ready});
 }
 for(let iteration=0;iteration<repeat;iteration++){
  for(const lane of (args.lanes??'serial,pool').split(',')){
   const start=performance.now();
   const inputs=data.map(input=>({...input,requests:input.requests.map(r=>({...r,targetTick:r.targetTick-(args.vary==='true'?iteration:0)}))}));
   const results=lane==='serial'?inputs.map(input=>input.requests.map(r=>executeBotForecast(input.observation,r))):await Promise.all(inputs.map(input=>runBotForecasts(input.observation,input.requests,new AbortController().signal)));
   rows.push({iteration,lane,elapsedMs:performance.now()-start,jobs:results.flat().length,hash:hash(results),errors:results.flat().filter(r=>r.kind==='error').length});
  }
 }
}finally{closeBotForecastPool();}
const report={at:new Date().toISOString(),modules:args.modules??'dist',varyHorizon:args.vary==='true',cpu:cpus()[0].model,availableParallelism:availableParallelism(),concurrency:botCandidateConcurrency,inputHash:hash(data),setup,rows,poolStats:botForecastPoolStats?.()};
fs.mkdirSync(path.dirname(args.output),{recursive:true});fs.writeFileSync(args.output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
