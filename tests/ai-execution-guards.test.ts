
import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {ModelCallQueue} from '../packages/ai/src/controller/runtime/model-queue.js';
import {waitForControlLease} from '../packages/ai/src/controller/transport/control-lease-wait.js';
import {diplomacyCooldown} from '../packages/ai/src/controller/analysis/chat-budget.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {AiStore,initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {ProtocolPlayerGateway} from '../packages/ai/src/controller/transport/protocol-gateway.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import type {TestContext} from 'node:test';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('shared model queue bounds execution, is FIFO, and releases slots after errors',async()=>{
 const queue=new ModelCallQueue(2),signal=new AbortController().signal,first=deferred(),second=deferred(),order:number[]=[];
 const a=queue.run(signal,async()=>{order.push(1);await first.promise;throw Error('synthetic failure');});const caught=assert.rejects(a,/synthetic failure/);
 const b=queue.run(signal,async()=>{order.push(2);await second.promise;return 2;});
 const c=queue.run(signal,async()=>{order.push(3);return 3;});const d=queue.run(signal,async()=>{order.push(4);return 4;});
 await turn();assert.deepEqual(order,[1,2]);assert.deepEqual(queue.status,{limit:2,active:2,waiting:2});
 first.resolve();await caught;assert.equal(await c,3);assert.equal(await d,4);assert.deepEqual(order,[1,2,3,4]);
 second.resolve();assert.equal(await b,2);assert.deepEqual(queue.status,{limit:2,active:0,waiting:0});
});
test('queued cancellation never starts a provider or holds a slot',async()=>{
 const queue=new ModelCallQueue(1),hold=deferred(),cancel=new AbortController();let calls=0;
 const active=queue.run(new AbortController().signal,()=>hold.promise);
 const queued=queue.run(cancel.signal,async()=>{calls++;});const rejected=assert.rejects(queued,e=>(e as {code:string}).code==='cancelled');
 cancel.abort();await rejected;hold.resolve();await active;assert.equal(calls,0);assert.equal(queue.status.waiting,0);assert.equal(queue.status.active,0);
 assert.throws(()=>new ModelCallQueue(0));assert.throws(()=>new ModelCallQueue(1.5));
});
test('reserved discussion capacity admits interactive calls ahead of blocked automatic decisions',async()=>{
 const queue=new ModelCallQueue(3,1),signal=new AbortController().signal,hold=deferred(),order:string[]=[];
 const a=queue.run(signal,async()=>{order.push('ai1');await hold.promise;});
 const b=queue.run(signal,async()=>{order.push('ai2');await hold.promise;});
 const c=queue.run(signal,async()=>{order.push('ai3');});
 const chat=queue.run(signal,async()=>{order.push('commander');},{interactive:true});
 await chat;assert.deepEqual(order,['ai1','ai2','commander']);
 hold.resolve();await Promise.all([a,b,c]);assert.deepEqual(order,['ai1','ai2','commander','ai3']);assert.equal(queue.status.active,0);
 const single=new ModelCallQueue(1);await single.run(signal,async()=>{});assert.equal(single.status.active,0);
});
test('lease wait polls availability without writes and stops if the other owner renews',async()=>{
 let now=0,reads=0,waits=0;
 await waitForControlLease(async()=>{reads++;return now<1000?{mode:'agent',expiresAt:1000}:{mode:'manual',expiresAt:null};},
  {signal:new AbortController().signal,now:()=>now,sleep:async ms=>{now+=ms;},onWait:()=>{waits++;}});
 assert.ok(reads>=3);assert.equal(waits,1);assert.ok(now>=1000&&now<1500);
 now=0;reads=0;
 await assert.rejects(waitForControlLease(async()=>({mode:'agent',expiresAt:++reads===1?1000:2000}),
  {signal:new AbortController().signal,now:()=>now,sleep:async ms=>{now+=ms;}}),/CONTROL_LEASE_RENEWED/);
 assert.equal(reads,2);
});
test('lease wait is bounded and pause cancels waiting before any acquisition',async()=>{
 let now=0;
 await assert.rejects(waitForControlLease(async()=>({mode:'agent',expiresAt:100}),
  {signal:new AbortController().signal,now:()=>now,maxWaitMs:200,sleep:async ms=>{now+=ms;}}),/CONTROL_LEASE_WAIT_EXPIRED/);
 const cancel=new AbortController();let reads=0;
 await assert.rejects(waitForControlLease(async()=>{reads++;return {mode:'agent',expiresAt:1000};},
  {signal:cancel.signal,now:()=>0,sleep:async()=>{cancel.abort();}}),{name:'AbortError'});
 assert.equal(reads,1);
});
test('lease wait deadline includes a stalled read and ignores its late response',async()=>{
 let finished=false;
 await assert.rejects(waitForControlLease(async()=>{await new Promise(resolve=>setTimeout(resolve,50));finished=true;return {mode:'manual',expiresAt:null};},
  {signal:new AbortController().signal,maxWaitMs:10}),/CONTROL_LEASE_WAIT_EXPIRED/);
 assert.equal(finished,false);
});
async function heldLeaseFixture(t:TestContext){
 const h=protocolHarness(t),server=await createOwnerPlayerApi(h),foreign=h.grant(),session=h.repository.createSession(foreign.principal,'foreign-executor',['core/2']);
 const lease=h.repository.controlOperation(foreign.principal,'acquire',{roomEpoch:h.authority.roomEpoch,sessionId:session,idempotencyKey:'foreign-acquire'});
 const token=h.grant().token,requests:string[]=[];server.on('request',req=>requests.push(`${req.method} ${req.url}`));
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as {port:number};
 const gateway=new ProtocolPlayerGateway({id:'test',serverUrl:`http://127.0.0.1:${address.port}`,roomId:h.roomId,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'TEST',settings:{model:'',personality:'schemer'}},token);
 return{h,server,gateway,requests,foreign,session,lease,close:async()=>{gateway.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
test('gateway waits for the old lease, then sends exactly one acquire and never takeover',async t=>{
 const f=await heldLeaseFixture(t);let reads=0;
 f.server.on('request',req=>{if(req.url?.startsWith('/player/v2/control?')&&++reads===3){f.h.elapsed+=31000;f.h.wall+=31000;}});
 try{await f.gateway.acquire();assert.equal(f.gateway.writable,true);assert.equal(f.requests.filter(r=>r==='POST /player/v2/control/acquire').length,1);assert.ok(reads>=3);assert.ok(!f.requests.some(r=>r.includes('/owner/')));await f.gateway.release();}
 finally{await f.close();}
});
test('pause cancels gateway acquisition while waiting and cannot release a foreign lease',async t=>{
 const f=await heldLeaseFixture(t);let readReady!:()=>void;
 const reading=new Promise<void>(resolve=>{readReady=resolve;});
 f.server.on('request',req=>{if(req.url?.startsWith('/player/v2/control?'))readReady();});
 try{
  const task=f.gateway.acquire(),rejected=assert.rejects(task,{name:'AbortError'});await reading;f.gateway.cancelAcquire();await rejected;await f.gateway.release();assert.ok(!f.requests.some(r=>/^POST \/player\/v2\/control\//.test(r)));assert.equal(f.gateway.writable,false);assert.equal(f.h.repository.control(f.foreign.principal,f.session).generation,f.lease.generation);
 }finally{await f.close();}
});
test('diplomacy availability matches the first-message cooldown and reply exception',()=>{
 const status=diplomacyCooldown(1200,1100,0,[{from:1,to:0}],0);
 assert.equal(status.remainingSeconds,200);assert.equal(status.nextUnsolicitedAtSeconds,1400);assert.deepEqual(status.replyAllowedTargets,[1]);assert.equal(status.publicReplyAllowed,false);
 assert.equal(diplomacyCooldown(1200,1100,1,[],0).remainingSeconds,0);
 assert.equal(diplomacyCooldown(1200,null,0,[],0).remainingSeconds,0);
});
function fixture(){
 const room={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]};
 const snapshot:AiSnapshot={observation:observation(room,0,'room'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 return {snapshot,state:initialState('room',0,{model:'',personality:'schemer'})};
}
test('retired campaign adoption cannot read stale private evidence or execute a game operation',async()=>{
 const {snapshot,state}=fixture(),o=snapshot.observation,target=o.view.outposts[0]!.id,own=o.view.outposts.find(p=>p.owner===0)!;
 const evidence:any={roomId:o.roomId,player:0,basisRevision:'old',observedTick:o.view.tick,observedSeconds:o.secondsSinceLastTick,drafts:[],targets:[],fleets:[]};
 const archive={tool:'campaignCompare',arguments:{targetTick:o.view.tick+1,plans:[{id:'plan',drafts:[],targets:[target]}]},result:{scenarios:[{id:'plan',status:'conditional',targets:[{id:target,outcome:'controlled-at-horizon'}],outcome:{terminalPrediction:{verified:true}},sourceDefense:[{id:own.id,before:{id:own.id,drillers:-1}}]},{id:'hold',status:'conditional'}]}};
 let requests=0,archiveReads=0;
 await assert.rejects(executeTool('campaigns',{set:[{id:'test',target,objective:'Protect',holdPlan:'Retain',cancelWhen:'Changes',reviewAtTick:o.view.tick+1,allocations:[{source:own.id,drillers:1}],comparison:{resultRef:'ref',planId:'plan'}}]},
  {state,snapshot,gateway:{snapshot:async()=>snapshot,request:async()=>{requests++;throw Error('No requests');}},id:'adopt',spoken:0,now:0,readToolResult:()=>{archiveReads++;return archive;},readComparisonEvidence:()=>{archiveReads++;return evidence;}}),/Tool not available/);
 assert.equal(requests,0);assert.equal(archiveReads,0);
});
test('repeated unavailable actions cause no transport and a corrected finish can end the round',async()=>{
 const {snapshot,state}=fixture(),store=new AiStore(':memory:');let calls=0,writes=0;
 try{
  const runner=new SeatRunner(state,store,{snapshot:async()=>structuredClone(snapshot),request:async()=>{writes++;throw Error('No game write expected');}},
   {step:async()=>({tokens:0,reply:++calls<=3?{tool:'order',arguments:{action:{kind:'resign'}},summary:'synthetic invalid action'}:{tool:'finish',arguments:{},summary:'finish'}})});
  await runner.poll(0,true);
  const rejections=store.history('room',0,100).filter(r=>r.kind==='tool-rejected');
  assert.equal(calls,4);assert.equal(writes,0);assert.equal(rejections.length,3);
  assert.ok(JSON.stringify(rejections).includes('Action not available'));assert.ok(store.latest('room',0,'completed'));
 }finally{store.close();}
});
test('cooldown rejection returns retry time and sends no chat, while actual replies remain allowed',async()=>{
 const {snapshot,state}=fixture();state.lastSpoke=1000;let writes=0;
 const context={state,snapshot,gateway:{snapshot:async()=>snapshot,request:async()=>{writes++;return {accepted:true};}},id:'message',spoken:0,now:1100};
 await assert.rejects(executeTool('say',{to:1,text:'Synthetic message'},context),e=>{const d=JSON.parse((e as Error).message);return d.code==='DIPLOMACY_COOLDOWN'&&d.nextUnsolicitedAtSeconds===1300;});
 assert.equal(writes,0);
});
