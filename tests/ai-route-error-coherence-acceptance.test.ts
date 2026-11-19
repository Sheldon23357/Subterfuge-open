
import {SeatRunner} from './helpers/scripted-controller.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AttackRoutes,PlayerObservation} from '../packages/contracts/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {AiStore,initialState,executeTool,type AiSnapshot,type GameGateway} from '../packages/ai/src/index.js';
import {PlayerGateway,GameRequestError,GameTransportError,type GameRequestDiagnostic} from '../packages/ai/src/controller/transport/gateway.js';
import {prepareAttackRoutes,StaleAnalysisResultError} from '../packages/ai/src/controller/analysis/analysis-efficiency.js';
import {BatchTransportError} from '../packages/ai/src/controller/execution/batch-outcome.js';
import {recoverBatchOutcome} from '../packages/ai/src/controller/execution/batch-recovery.js';
import {encodeModelResultRows} from '../packages/ai/src/controller/presentation/model-table.js';
import {recoveryDelay} from '../packages/ai/src/controller/runtime/recovery.js';

const windows={attackTicks:108,localTicks:48,holdTicks:24};
function room(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 setup.size={width:80,height:80};
 setup.positions={'蓝方工厂':{x:0,y:0},'红方矿场':{x:1,y:0},'红方后方':{x:2,y:0}};
 return {state:createFleetScenario(setup),scheduled:[]};
}
function fixture(){
 const o=observation(room(),0,'route-coherence-acceptance');
 const state=initialState(o.roomId,0,{model:'',personality:'schemer'});
 const snapshot=(value=o):AiSnapshot=>({observation:structuredClone(value),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2});
 return {o,state,snapshot};
}
function decode(value:any):any{
 if(Array.isArray(value))return value.map(decode);
 if(!value||typeof value!=='object')return value;
 if(value.encoding==='column-groups/1')return value.groups.flatMap((g:any)=>g.rows.map((r:any)=>({index:r[0],value:Object.fromEntries(g.fields.map((key:string,i:number)=>[key,decode(r[i+1])]))}))).sort((a:any,b:any)=>a.index-b.index).map((r:any)=>r.value);
 return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,decode(child)]));
}
const diagnostic=(path='/tool/order',outcome:GameRequestDiagnostic['outcome']='rejected'):GameRequestDiagnostic=>({requestId:'acceptance-request-1',method:'POST',path,origin:'https://not-for-model.example',timeoutMs:15000,elapsedMs:17,stage:'http-response',failure:'http-error',outcome,status:409});

test('coherence acceptance: local routes preserve their authorized snapshot while server troop counts change',async t=>{
 const live=room(),h=protocolHarness(t,{room:live}),data=h.ownerCredentials,access=h.ownerAccess;let reads=0,snapshots=0,modelCalls=0,writes=0;
 const server=await createOwnerPlayerApi(h);
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert.ok(address&&typeof address==='object');
 const client=new PlayerGateway(`http://127.0.0.1:${address.port}`,data.credentials[0]!.token,access.roomId,0,2);
 const store=new AiStore(':memory:'),state=initialState(access.roomId,0,{model:'',personality:'schemer'});
 let oldRevision='',pairedRevision='';
 const gateway:GameGateway={
  snapshot:async()=>{snapshots++;const o=await client.request('/tool/observation') as PlayerObservation;if(!oldRevision)oldRevision=o.revision;return {observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};},
  attackRoutes:async(o,w)=>{
   reads++;
   if(reads===1){const saved=h.store.load()!,setup=structuredClone(saved.room.state.initial);setup.economy.outposts[0]!.drillers+=123;h.store.commit({...saved.room,state:createFleetScenario(setup)},saved.revision,true);}
   const routes=await client.attackRoutes(o,w);pairedRevision=routes.revision;
   assert.equal(pairedRevision,oldRevision,'local computation keeps the supplied authorized revision');
   return routes;
  },
  request:async()=>{writes++;throw Error('No gameplay writes permitted by this fixture');}
 };
 try{
  await new SeatRunner(state,store,gateway,{step:async input=>{
   modelCalls++;assert.ok(JSON.parse(input.prompt).snapshot.observation.revision===pairedRevision);
   return {tokens:0,reply:{tool:'finish',arguments:{},summary:'核对当前观察后结束'}};
  }}).poll(0,true);
  assert.equal(modelCalls,1);assert.equal(reads,1,'local route computation needs no remote rebase');
  assert.equal(snapshots,1);assert.equal(state.status,'waiting');assert.equal(state.error,null);
  assert.equal(writes,0);assert.equal(h.store.load()!.revision,2);assert.equal(h.store.load()!.room.state.commands.length,0);
  const shown=store.latest<PlayerObservation>(access.roomId,0,'decision-observation')!;
  assert.equal(shown.revision,pairedRevision);assert.equal(shown.view.outposts[0]!.drillers,100);
  const latest=await client.request('/tool/observation') as PlayerObservation;
  assert.equal(latest.view.outposts[0]!.drillers,223,'new server facts require a new authorized observation');
  const screened=store.latest<any>(access.roomId,0,'attack-screening');assert.equal(screened.report.basisRevision,pairedRevision);
 }finally{store.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('coherence acceptance: visibility changes during a route fetch rebuild from the fresh pair, not the old report',async()=>{
 const f=fixture(),fresh=structuredClone(f.o);fresh.revision='after-visibility-loss';
 const removed=fresh.view.outposts.find(p=>p.owner===1)!.id;
 fresh.view.outposts=fresh.view.outposts.filter(p=>p.id!==removed);

 const store=new AiStore(':memory:');let reads=0,snapshots=0,calls=0,writes=0;
 try{
  await new SeatRunner(f.state,store,{
   snapshot:async()=>f.snapshot(++snapshots===1?f.o:fresh),
   attackRoutes:async()=>{reads++;return attackRoutes(fresh);},
   request:async()=>{writes++;return null;}
  },{step:async input=>{calls++;assert.ok(JSON.parse(input.prompt).snapshot.observation.revision===fresh.revision);return {tokens:0,reply:{tool:'finish',arguments:{},summary:'完成'}};}}).poll(0,true);
  assert.equal(calls,1);assert.equal(reads,1);assert.equal(writes,0);
  const shown=store.latest<PlayerObservation>(f.o.roomId,0,'decision-observation')!;
  assert.equal(shown.revision,fresh.revision);assert.equal(shown.view.outposts.some(p=>p.id===removed),false);
  const report=store.latest<any>(f.o.roomId,0,'attack-screening').report;
  assert.equal(report.basisRevision,fresh.revision);assert.equal(report.ranked.some((p:any)=>p.target===removed),false);
 }finally{store.close();}
});

test('coherence acceptance: disabling route caches does not repeat a freshly reconciled route request',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'route-cache-acceptance-'));
 const previous=process.env.AI_ANALYSIS_EFFICIENCY_CONFIG,path=join(directory,'efficiency.json');
 writeFileSync(path,JSON.stringify({cacheRoutes:false,cacheReports:false}));process.env.AI_ANALYSIS_EFFICIENCY_CONFIG=path;
 const f=fixture(),fresh={...structuredClone(f.o),revision:'uncached-fresh-pair'},store=new AiStore(':memory:');let snapshots=0,reads=0,calls=0;
 try{
  await new SeatRunner(f.state,store,{snapshot:async()=>f.snapshot(++snapshots===1?f.o:fresh),attackRoutes:async()=>{reads++;return attackRoutes(fresh);},request:async()=>{throw Error('No writes expected');}},
   {step:async input=>{calls++;assert.ok(JSON.parse(input.prompt).snapshot.observation.revision===fresh.revision);return {tokens:0,reply:{tool:'finish',arguments:{},summary:'完成'}};}}).poll(0,true);
  assert.equal(calls,1);assert.equal(reads,1);assert.equal(snapshots,2);assert.equal(f.state.status,'waiting');
 }finally{store.close();if(previous===undefined)delete process.env.AI_ANALYSIS_EFFICIENCY_CONFIG;else process.env.AI_ANALYSIS_EFFICIENCY_CONFIG=previous;rmSync(directory,{recursive:true,force:true});}
});

for(const changed of ['room','player'] as const)test(`coherence acceptance: a refreshed ${changed} identity mismatch cannot establish a route pair`,async()=>{
 const f=fixture(),fresh={...structuredClone(f.o),revision:'identity-mismatch'},store=new AiStore(':memory:');let snapshots=0,reads=0,calls=0,writes=0;
 if(changed==='room')fresh.roomId='foreign-refresh-room';else fresh.view.player=1;
 const routes={...attackRoutes(f.o),revision:fresh.revision};
 const runner=new SeatRunner(f.state,store,{snapshot:async()=>f.snapshot(++snapshots===1?f.o:fresh),attackRoutes:async()=>{reads++;return routes;},request:async()=>{writes++;return null;}},{step:async()=>{calls++;throw Error('Identity mismatch must not reach model');}});
 try{
  await runner.poll(0,true);assert.equal(reads,1);assert.equal(snapshots,2);assert.equal(calls,0);assert.equal(writes,0);
  assert.equal(runner.recovering,false);assert.equal(store.latest(f.o.roomId,0,'attack-screening'),null);
 }finally{store.close();}
});

test('coherence acceptance: a newer concurrent observer wins over a delayed pair refresh',{timeout:5000},async()=>{
 const f=fixture(),paired={...structuredClone(f.o),revision:'delayed-pair'},newer=structuredClone(f.o);
 newer.revision='newer-concurrent-observation';newer.view.tick++;
 const store=new AiStore(':memory:');let snapshots=0,reads=0,calls=0,writes=0,entered!:()=>void,release!:()=>void;
 const enteredRefresh=new Promise<void>(resolve=>entered=resolve),holdRefresh=new Promise<void>(resolve=>release=resolve);
 const runner=new SeatRunner(f.state,store,{snapshot:async()=>{snapshots++;if(snapshots===1)return f.snapshot();if(snapshots===2){entered();await holdRefresh;return f.snapshot(paired);}return f.snapshot(newer);},
  attackRoutes:async()=>{reads++;return attackRoutes(paired);},request:async()=>{writes++;return null;}},{step:async()=>{calls++;throw Error('Superseded pair must not reach model');}});
 try{
  const first=runner.poll(0,true);await enteredRefresh;await runner.poll(6000,true);release();await first;
  assert.equal(snapshots,3);assert.equal(reads,1);assert.equal(calls,0);assert.equal(writes,0);assert.equal(runner.recovering,true);
  const error=store.latest<any>(f.o.roomId,0,'error');assert.equal(error.code,'analysis-stale');
  assert.equal(store.latest(f.o.roomId,0,'attack-screening'),null);
 }finally{release?.();store.close();}
});

for(const change of [{roomId:'foreign-room'},{observedTick:999999}])test(`coherence acceptance: ${Object.keys(change)[0]} mismatch never reaches computation or writes`,async()=>{
 const f=fixture(),store=new AiStore(':memory:');let reads=0,calls=0,writes=0,snapshots=0;
 const beforeMemory=structuredClone(f.state.memory);
 const runner=new SeatRunner(f.state,store,{snapshot:async()=>{snapshots++;return f.snapshot();},attackRoutes:async o=>{reads++;return {...attackRoutes(o),...change};},request:async()=>{writes++;return null;}},{step:async()=>{calls++;throw Error('Mismatched routes must never reach model');}});
 try{
  await runner.poll(0,true);
  assert.equal(calls,0);assert.equal(writes,0);assert.deepEqual(f.state.memory,beforeMemory);
  assert.equal(store.latest(f.o.roomId,0,'attack-screening'),null);
  assert.equal(store.latest(f.o.roomId,0,'decision-observation'),null);
  assert.ok(reads<=2);assert.ok(snapshots<=2,'refresh work must be bounded within one poll');
  assert.equal(runner.recovering,'roomId' in change?false:true);
 }finally{store.close();}
});

test('coherence acceptance: continuously changing reads stop without relabeling or using an incompatible snapshot',async()=>{
 const f=fixture(),store=new AiStore(':memory:');let reads=0,snapshots=0,calls=0,writes=0;
 const runner=new SeatRunner(f.state,store,{
  snapshot:async()=>{const o=structuredClone(f.o);o.revision=`snapshot-${++snapshots}`;return f.snapshot(o);},
  attackRoutes:async o=>{reads++;return {...attackRoutes(o),revision:`ahead-of-${o.revision}`};},
  request:async()=>{writes++;return null;}
 },{step:async()=>{calls++;throw Error('Unpaired route basis must not reach model');}});
 try{
  await runner.poll(0,true);assert.ok(reads<=2);assert.ok(snapshots<=2);assert.equal(calls,0);assert.equal(writes,0);
  assert.equal(runner.recovering,true);assert.equal(store.latest<any>(f.o.roomId,0,'error').code,'analysis-stale');
  assert.equal(store.latest(f.o.roomId,0,'attack-screening'),null);
 }finally{store.close();}
});

for(const code of ['REVISION_CONFLICT','query-replan-required',undefined])test(`coherence acceptance: persistent ${code??'legacy observation'} route conflicts use at most one refresh before backoff`,async()=>{
 const f=fixture(),fresh={...structuredClone(f.o),revision:'current-conflict-basis'},store=new AiStore(':memory:');let reads=0,snapshots=0,calls=0,writes=0;
 const runner=new SeatRunner(f.state,store,{
  snapshot:async()=>{if(++snapshots>4)throw Error('Sentinel prevents an unbounded conflict-refresh test');return f.snapshot(snapshots===1?f.o:fresh);},
  attackRoutes:async()=>{if(++reads>3)throw Error('Sentinel prevents an unbounded route retry test');throw new GameRequestError(409,fresh,code,undefined,diagnostic('/tool/attack-routes','read-only'));},
  request:async()=>{writes++;return null;}
 },{step:async()=>{calls++;throw Error('Failed route conflict computation must not reach model');}});
 try{
  await runner.poll(0,true);assert.equal(reads,2);assert.equal(snapshots,2);assert.equal(calls,0);assert.equal(writes,0);
  assert.equal(runner.recovering,true);const error=store.latest<any>(f.o.roomId,0,'error');assert.equal(error.code,'game-request');assert.equal(error.recovery.delayMs,15000);
  assert.equal(error.diagnostic.request.status,409);assert.equal(error.diagnostic.request.requestId,'acceptance-request-1');
  if(code)assert.equal(error.diagnostic.cause.code,code);
  assert.equal(store.latest(f.o.roomId,0,'attack-screening'),null);
 }finally{store.close();}
});

for(const code of ['manual-command-protected','PLAYER_CONTROL',undefined])test(`coherence acceptance: ${code??'uncoded generic'} route conflict does not masquerade as a refreshable revision race`,async()=>{
 const f=fixture(),store=new AiStore(':memory:');let reads=0,snapshots=0,calls=0,writes=0;
 const runner=new SeatRunner(f.state,store,{
  snapshot:async()=>{if(++snapshots>4)throw Error('Sentinel prevents an unbounded refresh test');return f.snapshot();},
  attackRoutes:async()=>{if(++reads>3)throw Error('Sentinel prevents an unbounded route retry test');throw new GameRequestError(409,code?f.o:undefined,code,undefined,diagnostic('/tool/attack-routes','read-only'));},
  request:async()=>{writes++;return null;}
 },{step:async()=>{calls++;throw Error('Non-version rejection must not reach model');}});
 try{
  await runner.poll(0,true);assert.equal(reads,1);assert.equal(snapshots,1);assert.equal(calls,0);assert.equal(writes,0);assert.equal(runner.recovering,false);
  assert.equal(store.latest<any>(f.o.roomId,0,'error').code,'game-request');
 }finally{store.close();}
});

for(const changed of ['room','player'] as const)test(`coherence acceptance: HTTP409 cannot authorize a different ${changed} observation`,async()=>{
 const f=fixture(),foreign=structuredClone(f.o),store=new AiStore(':memory:');let reads=0,snapshots=0,calls=0;
 if(changed==='room')foreign.roomId='foreign-conflict-room';else foreign.view.player=1;
 const runner=new SeatRunner(f.state,store,{snapshot:async()=>{snapshots++;return f.snapshot();},attackRoutes:async()=>{if(++reads>3)throw Error('Sentinel');throw new GameRequestError(409,foreign,'REVISION_CONFLICT');},request:async()=>{throw Error('No writes permitted');}},
  {step:async()=>{calls++;throw Error('Foreign conflict observation must not reach model');}});
 try{
  await runner.poll(0,true);assert.equal(reads,1);assert.equal(snapshots,1);assert.equal(calls,0);assert.equal(runner.recovering,false);
 }finally{store.close();}
});

test('coherence acceptance: route caching rebases only matching dependencies and never stores rejected fresh reads',async()=>{
 const f=fixture(),cache:{routeKey:string;routes?:AttackRoutes}={routeKey:''};let reads=0;
 const read=async(o:PlayerObservation)=>{reads++;return attackRoutes(o);};
 assert.equal((await prepareAttackRoutes(f.o,windows,cache,read,true)).hit,false);
 const garrison=structuredClone(f.o);garrison.revision='changed-garrison';garrison.view.outposts[0]!.drillers!++;
 assert.equal((await prepareAttackRoutes(garrison,windows,cache,read,true)).hit,true);assert.equal(reads,1);assert.equal(cache.routes!.revision,garrison.revision);
 const tick=structuredClone(garrison);tick.revision='next-tick';tick.view.tick++;
 assert.equal((await prepareAttackRoutes(tick,windows,cache,read,true)).hit,false);assert.equal(reads,2);
 const previous=structuredClone(cache),unseen=structuredClone(tick);unseen.revision='geometry-changed';unseen.view.outposts.pop();
 await assert.rejects(prepareAttackRoutes(unseen,windows,cache,async o=>({...attackRoutes(o),revision:'not-the-requested-basis'}),true),StaleAnalysisResultError);
 assert.deepEqual(cache,previous,'a fresh bad response cannot be relabeled or poison a valid cache');
 assert.equal((await prepareAttackRoutes(tick,windows,cache,read,false)).hit,false);assert.equal(reads,3,'disabled caches still fetch and strictly validate');
});

for(const code of ['manual-replan-required','manual-command-protected','PLAYER_CONTROL','REVISION_CONFLICT','DISPATCH_SOURCE_LOCKED'])test(`error acceptance: HTTP 409 preserves ${code} as its actual error identity`,()=>{
 const error=new GameRequestError(409,undefined,code,undefined,diagnostic());
 assert.equal(error.message,code);assert.equal(error.code,code);
 if(code!=='REVISION_CONFLICT')assert.notEqual(error.message,'stale-observation');
});

test('error acceptance: an uncoded generic conflict is not called stale without a current-observation basis',()=>{
 const generic=new GameRequestError(409);assert.equal(generic.message,'request-conflict');assert.equal(generic.code,undefined);
 assert.equal(generic.displayReason.includes('情报版本冲突'),false);
 const current=fixture().o,legacy=new GameRequestError(409,current);
 assert.equal(legacy.message,'stale-observation');assert.equal(legacy.observation,current);assert.equal(legacy.displayReason.includes('情报版本冲突'),true);
});

test('error acceptance: accepted, rejected and untouched batch items retain compact failure evidence through model projection and recovery',async()=>{
 const f=fixture(),audits:{kind:string;details:any}[]=[];let writes=0;
 const after={...structuredClone(f.o),revision:'accepted-prefix'};
 const error=new GameRequestError(409,after,'manual-command-protected','人工指令保护',diagnostic());
 const gateway:GameGateway={snapshot:async()=>f.snapshot(after),request:async()=>{if(++writes===2)throw error;return after;}};
 const args={actions:Array.from({length:3},()=>({tool:'order',arguments:{action:{kind:'check-in'}}}))};
 const result=await executeTool('batch',args,{state:f.state,snapshot:f.snapshot(),gateway,id:'acceptance-batch',now:0,spoken:0,audit:(kind,details)=>audits.push({kind,details})}) as any;
 assert.deepEqual(result.results.map((r:any)=>r.status),['accepted','rejected','not-executed']);assert.equal(writes,2);
 const rejected=result.results[1];assert.equal(rejected.code,error.code);assert.equal(rejected.httpStatus,409);assert.equal(rejected.requestId,'acceptance-request-1');
 assert.equal(rejected.expectedRevision,after.revision);assert.equal(rejected.currentRevision,after.revision);
 assert.equal(rejected.diagnostic.path,'/tool/order');assert.equal(rejected.outcome,'rejected');
 const projected=decode(JSON.parse(JSON.stringify(encodeModelResultRows(result))));
 assert.deepEqual(projected.results,result.results);
 const text=JSON.stringify(projected);assert.ok(!text.includes('not-for-model.example'));
 const recovered=recoverBatchOutcome('acceptance-batch',args,result.results.map((r:any,index:number)=>({id:r.id,intentRecorded:index<2,evidence:index<2?{kind:'batch-item-result',result:r}:{kind:'no-durable-outcome'}})),[]);
 assert.deepEqual(recovered.results.slice(0,2),result.results.slice(0,2));assert.equal(recovered.results[2]!.status,'not-executed');
 assert.equal(audits.filter(a=>a.kind==='batch-item-intent').length,2);
});

test('error acceptance: unknown batch transport preserves exact request identities and is not made retryable by diagnostics',async()=>{
 const f=fixture();let writes=0;
 const cause=new GameTransportError({...diagnostic('/tool/order','unknown'),failure:'connection-reset',stage:'connect-or-send'});
 const after={...structuredClone(f.o),revision:'accepted-prefix'};
 const gateway:GameGateway={snapshot:async()=>f.snapshot(after),request:async()=>{if(++writes===2)throw cause;return after;}};
 const args={actions:Array.from({length:3},()=>({tool:'order',arguments:{action:{kind:'check-in'}}}))};
 await assert.rejects(executeTool('batch',args,{state:f.state,snapshot:f.snapshot(),gateway,id:'unknown-batch',now:0,spoken:0}),(error:unknown)=>{
  assert.ok(error instanceof BatchTransportError);assert.equal(recoveryDelay(error,1),null);
  assert.deepEqual(error.outcome.results.map(r=>r.id),['unknown-batch-item-0','unknown-batch-item-1','unknown-batch-item-2']);
  assert.deepEqual(error.outcome.results.map(r=>r.status),['accepted','unknown','not-executed']);
  assert.equal(error.outcome.results[1]!.requestId,'acceptance-request-1');assert.equal(error.outcome.results[1]!.outcome,'unknown');
  assert.equal(error.outcome.results[1]!.expectedRevision,after.revision);return true;
 });
 assert.equal(writes,2);
});
