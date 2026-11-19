import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {actionBasisMaterial,parseProtocolCommand,type ProtocolCommandRequest} from '../packages/contracts/src/index.js';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {createPlayerProtocolApi} from '../packages/server/src/player-protocol-api.js';
import {advanceRoom} from '../packages/server/src/planning.js';
import {SerialExecutor} from '../packages/server/src/player-access.js';
import {protocolHarness} from './player-protocol-test-helpers.js';
const launch={kind:'launch',source:'a',destination:'b',drillers:2};
function room(){const setup:FleetSetup={size:{width:40,height:40},positions:{a:{x:0,y:0},b:{x:3,y:0},c:{x:6,y:0},d:{x:9,y:0}},economy:{initialTick:0,teamSize:0,players:Array.from({length:4},()=>({active:true,neptunium:100,minesCreated:0})),outposts:['a','b','c','d'].map((id,owner)=>({id,owner,type:'generator',drillers:20,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))}};return{state:createFleetScenario(setup),scheduled:[]};}
const digest=(o:ReturnType<typeof observation>,action=launch)=>{const material=actionBasisMaterial(o,action);assert.ok(material);return createHash('sha256').update(material).digest('hex');};
async function fixture(t:TestContext,realtime=false){const initial:import('../packages/server/src/planning.js').LabRoom=room();if(realtime)initial.clock={format:'realtime-clock/1',anchorMs:1800000000000,anchorTick:0};const h=protocolHarness(t,{room:initial});let hook:(()=>void)|undefined,instructions='0';
 const server=createPlayerProtocolApi({repository:h.repository,roomId:h.roomId,serial:new SerialExecutor(),load:()=>h.store.load()!,commit:(room,rev)=>h.store.commit(room,rev),ownerIdentity:auth=>{const player=h.ownerAccess.identity(auth);return player===null?null:{roomId:h.roomId,player};},instructionsVersion:()=>instructions,afterAdmission:async()=>{hook?.();}});server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert.ok(addr&&typeof addr==='object');t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const read=()=>observation(h.store.load()!.room,0,h.roomId);
 const mutate=(action:Record<string,unknown>={kind:'launch',source:'c',destination:'d',drillers:8},player=2)=>{const saved=h.store.load()!,next=submitFleetOrder(saved.room.state,{id:'peer-order',player,action:action as never});h.store.commit({...saved.room,state:next.state},saved.revision);};
 const post=async(request:ProtocolCommandRequest)=>{const response=await fetch(`http://127.0.0.1:${addr.port}/player/v2/commands`,{method:'POST',headers:{Authorization:'Bearer '+h.first.token,'Content-Type':'application/json'},body:JSON.stringify(request)});return{status:response.status,body:await response.json()};};
 const request=(id='scoped')=>{const o=read();return h.command(id,{payload:{action:launch},expectedRevision:o.revision,actionBasis:digest(o)});};
 return{h,read,mutate,post,request,setInstructions:(value:string)=>{instructions=value;},setHook:(fn:()=>void)=>{hook=fn;}};
}
test('unrelated visible launch passes scoped admission and settlement, and replay applies only once',async t=>{const x=await fixture(t),request=x.request();x.mutate();assert.notEqual(x.read().revision,request.expectedRevision);assert.equal(digest(x.read()),request.actionBasis);const first=await x.post(request);assert.equal(first.body.state,'applied');assert.deepEqual((await x.post(request)).body,first.body);assert.equal(x.h.store.load()!.room.state.commands.filter(c=>c.player===0).length,1);});
test('unrelated change between durable admission and settlement passes',async t=>{const x=await fixture(t),request=x.request();x.setHook(()=>x.mutate());assert.equal((await x.post(request)).body.state,'applied');});
test('related incoming fleet is rejected at admission with no own command effect',async t=>{const x=await fixture(t),request=x.request();x.mutate({kind:'launch',source:'c',destination:'b',drillers:8});const result=await x.post(request);assert.equal(result.status,409);assert.equal(result.body.code,'REVISION_CONFLICT');assert.equal(x.h.store.load()!.room.state.commands.filter(c=>c.player===0).length,0);});
test('related change after admission rejects at final settlement',async t=>{const x=await fixture(t),request=x.request();x.setHook(()=>x.mutate({kind:'launch',source:'c',destination:'b',drillers:8}));const result=await x.post(request);assert.equal(result.body.state,'rejected');assert.equal(result.body.code,'REVISION_CONFLICT');});
for(const change of ['source','target','tick','manual','agreement','resource'] as const)test(`scoped basis rejects ${change} change`,async t=>{
 const x=await fixture(t),request=x.request();
 if(change==='source')x.mutate({kind:'launch',source:'a',destination:'d',drillers:1},0);
 if(change==='target')x.mutate({kind:'set-shields',outpostId:'b',enabled:false},1);
 if(change==='tick'){const saved=x.h.store.load()!;x.h.store.commit(advanceRoom(saved.room,1),saved.revision);}
 if(change==='manual'||change==='agreement'||change==='resource'){
  const before=x.read(),edited=structuredClone(before);
  if(change==='manual')edited.dispatchGuard={tick:before.view.tick,lockedSources:['a']};
  if(change==='agreement')edited.diplomacy!.agreements.push({id:'changed'} as never);
  if(change==='resource')edited.view.self.neptunium--;
  assert.notEqual(digest(before),digest(edited));return;
 }
 assert.equal((await x.post(request)).body.code,'REVISION_CONFLICT');
});
test('legacy full revision stays strict and unsupported scoped actions fail wire validation',async t=>{const x=await fixture(t),{actionBasis,...request}=x.request();x.mutate();assert.equal((await x.post(request)).body.code,'REVISION_CONFLICT');assert.throws(()=>parseProtocolCommand({...request,actionBasis,payload:{action:{kind:'set-shields',outpostId:'a',enabled:false}}}));assert.throws(()=>parseProtocolCommand({...request,actionBasis:'forged'}));});

test('return-fleet basis binds the owned fleet and its original source',async t=>{
 const x=await fixture(t);x.mutate({kind:'launch',source:'a',destination:'b',drillers:4},0);
 const o=x.read(),fleet=o.view.fleets.find(f=>f.owner===0)!;assert.ok(fleet.source);
 const action={kind:'return-fleet',fleetId:fleet.id},material=actionBasisMaterial(o,action);assert.ok(material);
 const request=x.h.command('return',{payload:{action},expectedRevision:o.revision,actionBasis:createHash('sha256').update(material).digest('hex')});
 assert.equal((await x.post(request)).body.state,'applied');
 const missing=structuredClone(o);delete missing.view.fleets.find(f=>f.id===fleet.id)!.source;assert.equal(actionBasisMaterial(missing,action),null);
});

test('confirmed instructions remain a separate final guard for scoped orders',async t=>{
 const x=await fixture(t),request=x.request();x.setHook(()=>x.setInstructions('1'));
 const result=await x.post(request);assert.equal(result.body.state,'rejected');assert.equal(result.body.code,'INSTRUCTIONS_CHANGED');
 assert.equal(x.h.store.load()!.room.state.commands.length,0);
});
test('a matching full revision cannot override an invalid scoped digest',async t=>{
 const x=await fixture(t),request=x.request();request.actionBasis='f'.repeat(64);
 assert.equal((await x.post(request)).body.code,'REVISION_CONFLICT');
 assert.throws(()=>parseProtocolCommand({...request,actionBasis:'a'.repeat(64)+'\n'}));
 assert.throws(()=>parseProtocolCommand({...request,payload:{action:{...launch,delaySeconds:1}}}));
});

for(const scoped of [false,true])for(const stage of ['admission','settlement'] as const)test(`realtime order survives tick change at ${stage}, scoped=${scoped}`,async t=>{
 const x=await fixture(t,true),original=x.request('realtime');
 const request=scoped?original:(({actionBasis,...rest})=>rest)(original);
 const advance=()=>{const saved=x.h.store.load()!;x.h.store.commit(advanceRoom(saved.room,saved.room.state.economy.tick+1),saved.revision);};
 if(stage==='admission')advance();else x.setHook(advance);
 const result=await x.post(request);assert.equal(result.body.state,'applied');assert.equal(x.h.store.load()!.room.state.commands.filter(c=>c.player===0).length,1);
 assert.deepEqual((await x.post(request)).body,result.body);
});
test('realtime current-state execution still rejects insufficient troops and changed instructions',async t=>{
 const x=await fixture(t,true),request=x.request('resources');
 x.mutate({kind:'launch',source:'a',destination:'d',drillers:20},0);
 assert.notEqual((await x.post(request)).body.state,'applied');
 const y=await fixture(t,true),other=y.request('instructions');y.setInstructions('1');assert.equal((await y.post(other)).body.code,'INSTRUCTIONS_CHANGED');
});
test('realtime owner order survives tick changes using current legality',async t=>{
 const x=await fixture(t,true),before=x.read(),saved=x.h.store.load()!;x.h.store.commit(advanceRoom(saved.room,1),saved.revision);
 const base=await (async()=>{const server=createPlayerProtocolApi({repository:x.h.repository,roomId:x.h.roomId,serial:new SerialExecutor(),load:()=>x.h.store.load()!,commit:(room,rev)=>x.h.store.commit(room,rev),ownerIdentity:auth=>{const player=x.h.ownerAccess.identity(auth);return player===null?null:{roomId:x.h.roomId,player};}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();assert.ok(address&&typeof address==='object');return `http://127.0.0.1:${address.port}`;})();
 const response=await fetch(base+'/player/v2/owner/commands',{method:'POST',headers:{Authorization:'Bearer '+x.h.ownerCredentials.credentials[0]!.token,'Content-Type':'application/json'},body:JSON.stringify({kind:'order',clientCommandId:'manual-realtime',expectedRevision:before.revision,payload:{action:launch}})});assert.equal(response.status,200);
});

test('realtime relaxation does not allow stale schedules or stale readiness ticks',async t=>{
 const x=await fixture(t,true),before=x.read(),saved=x.h.store.load()!;x.h.store.commit(advanceRoom(saved.room,1),saved.revision);
 const schedule=x.h.command('stale-schedule',{kind:'schedule',expectedRevision:before.revision,payload:{issueTick:4,action:{kind:'check-in'}}});assert.equal((await x.post(schedule)).body.code,'REVISION_CONFLICT');
 const ready=x.h.command('stale-ready',{kind:'readiness',expectedRevision:before.revision,payload:{ready:true,tick:0}});assert.equal((await x.post(ready)).body.code,'REVISION_CONFLICT');
});
