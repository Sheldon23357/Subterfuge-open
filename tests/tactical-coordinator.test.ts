import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {computeBot,computeBotWithEntry} from '../packages/ai/src/controller/analysis/tactical-worker.js';
import {TacticalCoordinatorPool} from '../packages/ai/src/controller/analysis/tactical-coordinator-pool.js';
import {planBot,type TacticalGuidance} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {TACTICAL_VALIDATION_MS,validateTacticalProposal} from '../plugins/hybrid/src/tactical-validation.js';
const entry=new URL('./fixtures/tactical-coordinator-worker.js',import.meta.url),format='coordinator-fixture/1';
function fixture(player=0){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 setup.match={mode:'mining',neptuniumGoal:200};
 const o=observation({state:createFleetScenario(setup),scheduled:[]},player,'coordinator-test');
 return {o,routes:attackRoutes(o)};
}
const guidance=(rotation=0):TacticalGuidance=>({forbiddenPlayers:[],protectedSources:[],reserves:[],objectives:[],rotation});
const run=(rotation=0,signal?:AbortSignal)=>{const {o,routes}=fixture();return computeBotWithEntry(entry,format,o,routes,{guidance:guidance(rotation),maxElapsedMs:2000,...signal?{signal}:{}});};

test('completed and failed planners reuse loaded modules, with fresh job and forecast identities',async()=>{
 const a=await run(),b=await run();
 assert.equal(a.policyDiagnostics!.workerId,b.policyDiagnostics!.workerId);
 assert.equal(Number(b.policyDiagnostics!.round),Number(a.policyDiagnostics!.round)+1);
 await assert.rejects(run(1),/fixture planner failed/);
 const c=await run();assert.equal(c.policyDiagnostics!.workerId,a.policyDiagnostics!.workerId);
 assert.equal(c.basisRevision,fixture().o.revision);
});
test('six concurrent seats keep observations and results isolated',async()=>{
 const inputs=Array.from({length:6},(_,i)=>{const f=fixture(i%2);return {...f,o:{...f.o,roomId:`room-${i}`,revision:`revision-${i}`}};});
 const results=await Promise.all(inputs.map(({o,routes})=>computeBotWithEntry(entry,format,o,routes,{guidance:guidance(),maxElapsedMs:4000})));
 assert.equal(new Set(results.map(d=>d.policyDiagnostics!.workerId)).size,6);
 for(let i=0;i<6;i++){assert.equal(results[i]!.basisRevision,inputs[i]!.o.revision);assert.equal(results[i]!.policyDiagnostics!.player,inputs[i]!.o.view.player);}
});
test('abort and crash discard their coordinators and do not poison later work',async()=>{
 const controller=new AbortController(),f=fixture();
 await assert.rejects(computeBotWithEntry(entry,format,f.o,f.routes,{signal:controller.signal,guidance:guidance(4),maxElapsedMs:2000,onProgress:()=>controller.abort(Error('cancel-fixture'))}),/cancel-fixture/);
 await assert.rejects(run(3),/exited without a result \(17\)/);
 assert.equal((await run()).basisRevision,f.o.revision);
});
test('deadline returns only a validated checkpoint and destroys unfinished work',async()=>{
 await run();const f=fixture();let workerId:unknown;
 const result=await computeBotWithEntry(entry,format,f.o,f.routes,{guidance:guidance(2),maxElapsedMs:200,onCheckpoint:d=>{workerId=d.policyDiagnostics!.workerId;}});
 assert.equal(result.coverage.stopReason,'time-budget');assert.equal(result.coverage.complete,false);
 const next=await run();assert.notEqual(next.policyDiagnostics!.workerId,workerId);
 await assert.rejects(computeBotWithEntry(entry,format,f.o,f.routes,{guidance:guidance(7),maxElapsedMs:200}),/deadline before baseline/);
});
test('bounded pool releases cancelled waiters and never leases a busy worker twice',async()=>{
 const pool=new TacticalCoordinatorPool(1),signal=new AbortController();
 try{
  const a=await pool.acquire(entry,format,new AbortController().signal);
  const cancelled=pool.acquire(entry,format,signal.signal);signal.abort(Error('queued-cancel'));
  await assert.rejects(cancelled,/queued-cancel/);
  const next=pool.acquire(entry,format,new AbortController().signal);a.release(true);
  const b=await next;assert.equal(b.worker.threadId,a.worker.threadId);b.release(true);
 }finally{pool.close();}
});
test('real search stays deterministic across reused coordinators and validation uses 2 seconds and 32 attempts',async()=>{
 const {o,routes}=fixture(),options={maxSimulations:2,maxElapsedMs:60000,horizonTicks:12};
 const reference=planBot(o,routes,options),first=await computeBot(o,routes,options),second=await computeBot(o,routes,options);
 assert.deepEqual(first,reference);assert.deepEqual(second,reference);
 assert.equal(TACTICAL_VALIDATION_MS,2000);
 await validateTacticalProposal(first,o,routes,{},async(_o,_r,limits)=>{
  assert.ok(limits);
  assert.equal(limits.maxElapsedMs,2000);assert.equal(limits.maxSimulations,2);return first;
 });
 await validateTacticalProposal({...first,parameters:{...first.parameters,maxSimulations:80}},o,routes,{},async(_o,_r,limits)=>{
  assert.ok(limits);
  assert.equal(limits.maxElapsedMs,2000);assert.equal(limits.maxSimulations,32);return first;
 });
});
