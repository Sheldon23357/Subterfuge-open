import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {prepareKnownPrediction,createKnownPrediction} from '../packages/prediction/src/index.js';
import {executeBotForecast} from '../packages/ai/src/controller/analysis/tactical-forecast.js';
import {ForecastPool,forecastConcurrency} from '../packages/ai/src/controller/analysis/tactical-forecast-pool.js';
function fixture(player=0){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 return observation({state:createFleetScenario(cfg),scheduled:[]},player,'reuse');
}

test('a prepared forecast context captures once across batches and isolates caller mutations',async()=>{
 const pool=new ForecastPool(1),o=fixture(),original=structuredClone(o),signal=new AbortController().signal;
 try{
  const run=pool.prepare(o),request={targetTick:o.view.tick+4,drafts:[]};
  assert.equal(pool.snapshot().contextCaptures,1);
  o.view.outposts[0]!.drillers=1;o.roomId='changed-after-capture';
  const expected=[executeBotForecast(original,request)];
  const first=await run([request],signal,undefined,1);assert.deepEqual(first,expected);
  if(first[0]!.kind==='result'&&first[0]!.result.forecast.status==='conditional')first[0]!.result.forecast.result.outposts.length=0;
  assert.deepEqual(await run([request],signal,undefined,1),expected);
  assert.equal(pool.snapshot().contextCaptures,1);assert.equal(pool.snapshot().contextLoads,1);
  assert.equal(pool.snapshot().cacheHits,1);
  await assert.rejects(async()=>run([request],AbortSignal.abort(Error('prepared-cancel')),undefined,1),/prepared-cancel/);
  assert.deepEqual(await run([request],signal,undefined,2),expected);
  assert.equal(pool.snapshot().cacheHits,1,'next round cannot reuse result cache');
  assert.deepEqual(await pool.prepare(o)([request],signal,undefined,2),[executeBotForecast(o,request)]);
  assert.equal(pool.snapshot().contextCaptures,2);assert.equal(pool.snapshot().contextLoads,2);
 }finally{pool.close();}
});

test('prepared worlds preserve independent forecasts, future resource checks and caller isolation',()=>{
 const o=fixture(),before=structuredClone(o),prepared=prepareKnownPrediction(o),at=o.view.tick;
 const drafts=[{id:'attack',issueTick:at,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:27}}];
 for(const request of [
  {targetTick:at+72,drafts:[],collectResourceFrames:true},
  {targetTick:at+144,drafts,collectResourceFrames:true},
  {targetTick:at+144,drafts,enemyWaiting:'defend' as const},
  {targetTick:at+144,drafts:[{...drafts[0]!,issueTick:at+3}],resourcePrefix:true},
  {targetTick:at+144,drafts,predicates:[{id:'ownership',kind:'controlledAtHorizon' as const,outpostId:'红方矿场'}]},
 ])assert.deepEqual(executeBotForecast(o,request,prepared),executeBotForecast(o,request));
 const first=prepared.create().predict(at+3);if(first.status==='conditional')first.result.outposts.length=0;
 assert.deepEqual(prepared.create().predict(at+3),createKnownPrediction(o).predict(at+3));
 let cancellationChecks=0;
 const cancelled=prepared.create({cancelled:()=>++cancellationChecks>1});
 assert.throws(()=>cancelled.predict(at+144),/Forecast cancelled/);
 assert.ok(cancellationChecks>1,'cancellation must also be observed after advancement has begun');
 assert.deepEqual(prepared.create().predict(at+3),createKnownPrediction(o).predict(at+3));
 assert.deepEqual(o,before);
 o.view.outposts[0]!.drillers=1;
 assert.deepEqual(prepared.create().predict(at+3),createKnownPrediction(before).predict(at+3));
 assert.throws(()=>prepared.create({drafts:[{...drafts[0]!,issueTick:at-1}]}),/Invalid forecast draft/);
});

test('warm workers load a basis once, isolate cached results and invalidate on time, room or state changes',async()=>{
 const pool=new ForecastPool(1),o=fixture(),signal=new AbortController().signal,request={targetTick:o.view.tick+8,drafts:[]};
 try{
  const first=await pool.run(o,[request],signal);const reference=structuredClone(first);
  assert.equal(pool.snapshot().contextLoads,1);
  if(first[0]!.kind==='result'&&first[0]!.result.forecast.status==='conditional')first[0]!.result.forecast.result.outposts.length=0;
  assert.deepEqual(await pool.run(o,[request],signal),reference);
  assert.equal(pool.snapshot().cacheHits,1);assert.equal(pool.snapshot().workerStarts,1);assert.equal(pool.snapshot().contextLoads,1);
  for(const change of [()=>{o.secondsSinceLastTick=60;},()=>{o.roomId='another-room';},()=>{o.view.outposts[0]!.drillers=2;}]){
   change();assert.deepEqual(await pool.run(o,[request],signal),[executeBotForecast(o,request)]);
  }
  assert.equal(pool.snapshot().contextLoads,4);assert.equal(pool.snapshot().cacheHits,1);
  const later={...request,targetTick:request.targetTick+1};
  assert.deepEqual(await pool.run(o,[later],signal),[executeBotForecast(o,later)]);
  assert.equal(pool.snapshot().cacheHits,1);
 }finally{pool.close();}
});

test('cancellation keeps the warm worker and another seat gets a fair queue turn',async()=>{
 const pool=new ForecastPool(1),o=fixture(),signal=new AbortController().signal,short={targetTick:o.view.tick+1,drafts:[]};
 try{
  await pool.run(o,[short],signal);
  const controller=new AbortController(),long={targetTick:o.view.tick+1440,drafts:[]};
  const running=pool.run(o,[long,long],controller.signal),rejected=assert.rejects(running,/cancel-warm/);
  controller.abort(Error('cancel-warm'));await rejected;
  assert.deepEqual(await pool.run(o,[short],signal),[executeBotForecast(o,short)]);
  assert.equal(pool.snapshot().workerStarts,1);
  const order:string[]=[],other={...structuredClone(o),roomId:'fair-other-seat'};
  const a=pool.run(o,[long,{...long,targetTick:long.targetTick-1},{...long,targetTick:long.targetTick-2}],signal,()=>{order.push('a');});
  const b=pool.run(other,[short],signal,()=>{order.push('b');});
  await Promise.all([a,b]);assert.deepEqual(order.slice(0,2),['a','b']);
  assert.equal(pool.snapshot().active,0);assert.equal(pool.snapshot().queued,0);
 }finally{pool.close();}
});

test('forecast concurrency configuration is bounded and rejects malformed values',()=>{
 for(const value of ['1','5','8','12','16'])assert.equal(forecastConcurrency(value),Number(value));
 for(const value of ['0','17','NaN','1.5','-1',''])assert.throws(()=>forecastConcurrency(value),/AI_FORECAST_CONCURRENCY/);
});

test('an already-running controller can still dispatch its original worker envelope after a build',async()=>{
 const worker=new Worker(new URL('../packages/ai/src/controller/analysis/tactical-forecast-worker.js',import.meta.url));
 const o=fixture(),request={targetTick:o.view.tick+8,drafts:[]};
 try{
  const reply=await new Promise<{id:number;result:unknown}>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.postMessage({id:1,observation:o,request});});
  assert.equal(reply.id,1);assert.deepEqual(reply.result,executeBotForecast(o,request));
 }finally{await worker.terminate();}
});

test('result caches separate player knowledge, predicates, assumptions and evict old requests',async()=>{
 const pool=new ForecastPool(1),o=fixture(),signal=new AbortController().signal;
 try{
  const first={targetTick:o.view.tick+1,drafts:[]};
  await pool.run(o,[first],signal);
  const other=fixture(1);other.revision=o.revision;
  assert.deepEqual(await pool.run(other,[first],signal),[executeBotForecast(other,first)]);
  assert.equal(pool.snapshot().cacheHits,0);assert.equal(pool.snapshot().contextLoads,2);
  const alternatives=[{...first,enemyWaiting:'defend' as const},{...first,predicates:[{id:'hold',kind:'controlledAtHorizon' as const,outpostId:'蓝方工厂'}]}];
  assert.deepEqual(await pool.run(o,alternatives,signal),alternatives.map(r=>executeBotForecast(o,r)));
  assert.equal(pool.snapshot().cacheHits,0);
  const valid={targetTick:o.view.tick+8,drafts:[{id:'strict',issueTick:o.view.tick,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:27}}]};
  await pool.run(o,[valid],signal);
  const invalid=structuredClone(valid);Object.assign(invalid.drafts[0]!.action,{unexpected:undefined});
  assert.deepEqual(await pool.run(o,[invalid],signal),[executeBotForecast(o,invalid)]);
  assert.equal(pool.snapshot().cacheHits,0,'undefined extra fields must not collide with a valid cached action');
  const requests=Array.from({length:36},(_,i)=>({...first,targetTick:o.view.tick+2+i}));
  await pool.run(o,requests,signal);
  await pool.run(o,[first],signal);assert.equal(pool.snapshot().cacheHits,0,'the oldest request must have been evicted');
 }finally{pool.close();}
});
