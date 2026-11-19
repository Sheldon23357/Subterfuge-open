import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {planBot,planBotAsync} from '../packages/ai/src/controller/local/bot-planner.js';
import {executeBotForecast} from '../packages/ai/src/controller/analysis/tactical-forecast.js';
import {computeBot} from '../packages/ai/src/controller/local/bot-worker.js';
import {closeBotForecastPool,runBotForecasts,botCandidateConcurrency} from '../packages/ai/src/controller/analysis/tactical-forecast-pool.js';
function fixture(){const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;setup.match={mode:'mining',neptuniumGoal:200};const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'parallel');return {o,routes:attackRoutes(o)};}
test('parallel discovery and stress preserve serial decisions, ordering and shared simulation budget',async()=>{
 const {o,routes}=fixture(),before=structuredClone(o);let largest=0;
 for(const maximum of [2,12,50]){
  const options={maxSimulations:maximum,maxElapsedMs:60000};const expected=planBot(o,routes,options);
  for(const parallelism of [4,5]){
  const result=await planBotAsync(o,routes,{...options,parallelism},async requests=>{
   largest=Math.max(largest,requests.length);
   // Deliberately complete later queue entries before earlier entries.
   return Promise.all(requests.map((request,i)=>new Promise<ReturnType<typeof executeBotForecast>>(resolve=>setTimeout(()=>resolve(executeBotForecast(o,request)),requests.length-i))));
  });assert.deepEqual(result,expected);assert.ok(result.coverage.simulations<=maximum);
  }
 }
 assert.equal(largest,5,'five independent candidates must actually be batched');assert.deepEqual(o,before);
});
test('real candidate pool returns reference results, cancellation clears jobs, and later seats keep working',async t=>{
 t.after(closeBotForecastPool);const {o,routes}=fixture();
 const expected=planBot(o,routes,{maxSimulations:12,maxElapsedMs:60000});
 assert.deepEqual(await computeBot(o,routes,{maxSimulations:12,maxElapsedMs:60000}),expected);
 const controller=new AbortController(),requests=Array.from({length:botCandidateConcurrency+2},()=>({targetTick:o.view.tick+144,drafts:[]}));
 const pending=runBotForecasts(o,requests,controller.signal),rejection=assert.rejects(pending,/cancel-parallel-test/);
 controller.abort(Error('cancel-parallel-test'));await rejection;
 const next=[{targetTick:o.view.tick+1,drafts:[]}];assert.deepEqual(await runBotForecasts(o,next,new AbortController().signal),next.map(r=>executeBotForecast(o,r)));
});

test('cancelling one seat leaves another independent seat and its search budget intact',async t=>{
 t.after(closeBotForecastPool);const {o,routes}=fixture(),controller=new AbortController();
 const cancelled=computeBot(o,routes,{maxSimulations:50,maxElapsedMs:60000,signal:controller.signal});
 const rejection=assert.rejects(cancelled,/cancel-one-seat/);
 const other={...structuredClone(o),roomId:'other-parallel-room'},otherRoutes={...structuredClone(routes),roomId:other.roomId};
 const expected=planBot(other,otherRoutes,{maxSimulations:12,maxElapsedMs:60000});
 const running=computeBot(other,otherRoutes,{maxSimulations:12,maxElapsedMs:60000});
 controller.abort(Error('cancel-one-seat'));await rejection;assert.deepEqual(await running,expected);
});
