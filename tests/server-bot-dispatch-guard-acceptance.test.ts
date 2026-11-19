import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fork, type ChildProcess} from 'node:child_process';
import {createServer as createPortProbe} from 'node:net';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createFleetScenario, type FleetSetup, type FleetAction} from '../packages/engine/src/index.js';
import {advanceRoom, saveRoom, restoreRoom, scheduleLaunch, type LabRoom} from '../packages/server/src/planning.js';
import {applyCoordinatedOrder, applyCoordinatedCancellation} from '../packages/server/src/player-commands.js';
import {observation, createPlayerApi} from '../packages/server/src/player-api.js';
import {PlayerAccess, SerialExecutor} from '../packages/server/src/player-access.js';
import {DurablePlayerControl} from '../packages/server/src/durable-player-control.js';
import {RoomStore} from '../packages/server/src/room-store.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {previewPlayerLaunch} from '../packages/server/src/player-game-preview.js';
import {simulatePlayerFuture} from '../packages/server/src/player-forecast.js';
import {createKnownPrediction} from '../packages/prediction/src/index.js';
import {DISPATCH_LOCK_MESSAGE} from '../packages/contracts/src/index.js';
import {generateBotCandidates} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
import {planBotAsync} from '../packages/ai/src/controller/local/bot-planner.js';
import {executeBotForecast, type BotForecastRequest} from '../packages/ai/src/controller/analysis/tactical-forecast.js';

// Independent acceptance fixtures. They use only temporary stores and loopback
// listeners; no real room, player account, model, or live match is accessed.
const HOME='蓝方工厂', ENEMY='红方矿场', BACK='红方后方', DEPOT='蓝方后方';
type Source='manual'|'agent';
function fixture():LabRoom {
  const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  setup.size={width:80,height:80};
  setup.positions={[HOME]:{x:0,y:0},[ENEMY]:{x:4,y:0},[BACK]:{x:8,y:0},[DEPOT]:{x:0,y:4}};
  for(const p of setup.economy.outposts)p.drillers=100;
  setup.economy.outposts.push({...structuredClone(setup.economy.outposts[0]!),id:DEPOT,productionProgress:0});
  return {state:createFleetScenario(setup),scheduled:[],playerRoomId:'dispatch-acceptance-room'};
}
function launch(drillers=10,source=HOME,destination=ENEMY):FleetAction {
  return {kind:'launch',delaySeconds:600,source,destination,drillers};
}
function order(room:LabRoom,id:string,action:FleetAction,source:Source='agent',player=0,issueTick?:number):LabRoom {
  return applyCoordinatedOrder(room,{id,player,action},source,0,issueTick);
}
function locked(fn:()=>unknown) {
  assert.throws(fn,(error:unknown)=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='DISPATCH_SOURCE_LOCKED'));
}
function lockedSources(room:LabRoom,player=0) {
  return observation(room,player,room.playerRoomId??'dispatch-acceptance-room').dispatchGuard?.lockedSources??[];
}
function unchanged(room:LabRoom,fn:()=>unknown) {
  const before=saveRoom(room);locked(fn);assert.equal(saveRoom(room),before);
}

test('dispatch acceptance: initial split remains free; one real implicit resize locks only its source/seat',()=>{
  let room=fixture();
  room=order(room,'first',launch(10));
  room=order(room,'split',launch(20,HOME,BACK));
  assert.deepEqual(lockedSources(room),[]);
  assert.equal(room.state.fleets.filter(f=>f.used&&f.owner===0).length,2);
  room=order(room,'first-revision',launch(12));
  assert.equal(room.state.fleets.find(f=>f.id==='first')!.drillers,12);
  assert.deepEqual(lockedSources(room),[HOME]);
  assert.deepEqual(lockedSources(room,1),[]);
  unchanged(room,()=>order(room,'second-revision',launch(13)));
  unchanged(room,()=>order(room,'fresh-destination',launch(1,HOME,DEPOT)));
  unchanged(room,()=>order(room,'future-bypass',launch(1,HOME,DEPOT),'agent',0,102));
  room=order(room,'other-source',launch(1,DEPOT,ENEMY));
  room=order(room,'other-player',launch(1,ENEMY,HOME),'agent',1);
  assert.equal(room.state.fleets.filter(f=>f.used).length,4);
  assert.deepEqual(lockedSources(room),[HOME]);
  assert.deepEqual(lockedSources(room,1),[]);
});

test('dispatch acceptance: direct cancellation locks immediately, further cancellations remain possible',()=>{
  let room=order(order(fixture(),'first',launch(10)),'split',launch(20,HOME,BACK));
  room=order(room,'cancel-first',{kind:'cancel-launch',fleetId:'first'});
  assert.deepEqual(lockedSources(room),[HOME]);
  unchanged(room,()=>order(room,'cancel-relaunch',launch(10)));
  room=order(room,'cancel-split',{kind:'cancel-launch',fleetId:'split'});
  assert.equal(room.state.fleets.filter(f=>f.used&&f.owner===0).length,0);
  assert.deepEqual(lockedSources(room),[HOME]);
  // Non-dispatch rules are not accidentally converted into a seat-wide pause.
  assert.doesNotThrow(()=>order(room,'unrelated-shields',{kind:'set-shields',outpostId:HOME,enabled:false}));
});

test('dispatch acceptance: manual and agent origins share one universal lock without weakening manual priority',()=>{
  let room=order(fixture(),'ai-initial',launch(10));
  room=order(room,'human-revision',launch(12),'manual');
  assert.deepEqual(lockedSources(room),[HOME]);
  unchanged(room,()=>order(room,'human-new',launch(1,HOME,DEPOT),'manual'));
  unchanged(room,()=>order(room,'human-resize',launch(13),'manual'));
  // Use an unrelated route so a pre-existing human route protection cannot
  // accidentally make this assertion pass instead of the dispatch guard.
  unchanged(room,()=>order(room,'agent-new',launch(1,HOME,BACK),'agent'));
  room=order(room,'human-cancel',{kind:'cancel-launch',fleetId:'ai-initial'},'manual');
  assert.deepEqual(lockedSources(room),[HOME]);
  unchanged(room,()=>order(room,'human-after-cancel',launch(1,HOME,DEPOT),'manual'));
});

test('dispatch acceptance: failed writes and exact retries are free, fresh-ID same-loadout reissue locks',()=>{
  let room=order(fixture(),'initial',launch(10));
  const before=saveRoom(room);
  for(const action of [launch(10000),launch(10,'missing-source'),{kind:'cancel-launch',fleetId:'missing-fleet'}] as FleetAction[]) {
    assert.throws(()=>order(room,'invalid-'+JSON.stringify(action),action));
    assert.equal(saveRoom(room),before);
  }
  room=order(room,'initial',launch(10));
  assert.equal(saveRoom(room),before,'same-ID exact replay has no command/event/world effect');
  assert.deepEqual(lockedSources(room),[]);
  room=order(room,'split-after-retry',launch(5,HOME,BACK));
  assert.deepEqual(lockedSources(room),[]);
  room=order(room,'same-count-new-id',launch(10));
  assert.deepEqual(lockedSources(room),[HOME]);
  const committed=saveRoom(room);
  room=order(room,'same-count-new-id',launch(10));
  room=order(room,'initial',launch(10));
  assert.equal(saveRoom(room),committed,'historical exact replay cannot reapply the old fleet amount or alter the lock');
  unchanged(room,()=>order(room,'next-fresh-id-same-count',launch(10)));
  assert.throws(()=>order(room,'same-count-new-id',launch(12)));
  assert.equal(saveRoom(room),committed);
});

test('dispatch acceptance: queued launch cancellation and direct legacy launch scheduling cannot bypass the lock',()=>{
  let room=order(fixture(),'queued-first',launch(10),'agent',0,102);
  room=order(room,'queued-split',launch(5,HOME,BACK),'agent',0,103);
  assert.deepEqual(lockedSources(room),[]);
  room=applyCoordinatedCancellation(room,'queued-first',0,'agent');
  assert.deepEqual(lockedSources(room),[HOME]);
  unchanged(room,()=>order(room,'new-queued',launch(1,HOME,DEPOT),'manual',0,104));
  unchanged(room,()=>scheduleLaunch(room,{order:{id:'legacy-bypass',player:0,action:launch(1,HOME,DEPOT)},departureTick:104},0,{source:'manual'}));
  room=applyCoordinatedCancellation(room,'queued-split',0,'agent');
  assert.equal(room.scheduledOrders!.every(p=>p.status==='cancelled'),true);
  const before=saveRoom(room);
  assert.equal(saveRoom(applyCoordinatedCancellation(room,'queued-first',0,'agent')),before);
});

test('dispatch acceptance: unrelated queue cancellation does not lock any launch source',()=>{
  let unrelated=order(fixture(),'shield-later',{kind:'set-shields',outpostId:HOME,enabled:false},'agent',0,102);
  unrelated=applyCoordinatedCancellation(unrelated,'shield-later',0,'agent');
  assert.deepEqual(lockedSources(unrelated),[]);
  assert.doesNotThrow(()=>order(unrelated,'first-after-unrelated-cancel',launch(1)));
});

test('dispatch acceptance: explicit queued fleet resize consumes the same first revision',()=>{
  let room=order(fixture(),'queued-first',launch(10),'agent',0,102);
  room=order(room,'queued-edit',{...launch(12),fleetId:'queued-first'} as FleetAction,'agent',0,102);
  assert.deepEqual(lockedSources(room),[HOME]);
  unchanged(room,()=>order(room,'queued-edit-again',{...launch(13),fleetId:'queued-first'} as FleetAction,'agent',0,102));
  unchanged(room,()=>order(room,'new-after-queued-edit',launch(1,HOME,BACK),'manual',0,103));
});

test('dispatch acceptance: lock survives portable and SQLite restart; only authoritative tick advancement renews source',t=>{
  let room=order(fixture(),'first',launch(10));
  room=order(room,'revision',launch(11));
  room=restoreRoom(saveRoom(room));
  assert.deepEqual(lockedSources(room),[HOME]);
  const dir=mkdtempSync(join(tmpdir(),'dispatch-acceptance-')),path=join(dir,'room.sqlite');
  let store=new RoomStore(path);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.commit(room,0);store.close();store=new RoomStore(path);
  room=store.load()!.room;
  assert.deepEqual(lockedSources(room),[HOME]);
  // An unrelated opponent write changes the room revision but not world time.
  room=order(room,'opponent-event',launch(1,ENEMY,HOME),'agent',1);
  room=order(room,'owner-unrelated',{kind:'set-shields',outpostId:DEPOT,enabled:false},'manual');
  unchanged(room,()=>order(room,'fresh-id-same-tick',launch(1,HOME,BACK),'manual'));
  assert.equal(room.state.economy.tick,100);
  const next=advanceRoom(room,101);
  assert.equal(next.state.economy.tick,101);
  assert.deepEqual(lockedSources(next),[]);
  assert.doesNotThrow(()=>order(next,'new-tick',launch(1,HOME,BACK),'manual'));
  assert.deepEqual(lockedSources(fixture()),[],'new isolated room does not inherit another room lock');
});

async function ownerFixture(t:TestContext) {
  const h=protocolHarness(t,{room:fixture()}),credentials=h.ownerCredentials,access=h.ownerAccess,server=await createOwnerPlayerApi(h),control=new DurablePlayerControl(h.repository),sessions=['dispatch-agent-seat-zero','dispatch-agent-seat-one'];
  for(let player=0;player<2;player++)control.command(access.roomId,player,{action:'acquire',sessionId:sessions[player]!});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const call=async(path:string,body?:unknown,player=0,source:Source='agent',extra:Record<string,string>={})=>{
    const headers={authorization:'Bearer '+credentials.credentials[player]!.token,...(source==='agent'?{'x-subterfuge-controller':'agent','x-subterfuge-control-session':sessions[player]!}:{}),...extra};
    const response=await fetch(`http://127.0.0.1:${address.port}`+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const send=(id:string,action:FleetAction,player=0,source:Source='agent')=>call('/player/v2/owner/commands',{kind:'order',clientCommandId:id,expectedRevision:observation(h.store.load()!.room,player,access.roomId).revision,payload:{action}},player,source);
  return {call,send,control,sessions,access,get room(){return h.store.load()!.room;},set room(next:LabRoom){h.store.commit(next,h.store.load()!.revision);}};
}

test('dispatch acceptance: actual two-seat HTTP cycle terminates cancel/relaunch without readiness or forced time',async t=>{
  const h=await ownerFixture(t);
  for(const [seat,source,destination] of [[0,HOME,ENEMY],[1,ENEMY,HOME]] as const) {
    const first=await h.send(`first-${seat}`,launch(10,source,destination),seat);assert.equal(first.status,200);
    const split=await h.send(`split-${seat}`,launch(5,source,seat===0?BACK:DEPOT),seat);assert.equal(split.status,200);
  }
  for(const [seat,source,destination] of [[0,HOME,ENEMY],[1,ENEMY,HOME]] as const) {
    const revision=await h.send(`revision-${seat}`,launch(11,source,destination),seat);assert.equal(revision.status,200);
    assert.deepEqual(revision.body.dispatchGuard,{tick:100,lockedSources:[source]});
    for(const actor of ['manual','agent'] as const) {
      const denied=await h.send(`blocked-${seat}-${actor}`,launch(12,source,destination),seat,actor);
      assert.equal(denied.status,409);assert.equal(denied.body.code,'DISPATCH_SOURCE_LOCKED');
      assert.equal(h.room.state.economy.tick,100);
    }
    const fleets=h.room.state.fleets.filter(f=>f.used&&f.owner===seat);
    for(const f of fleets)assert.equal((await h.send(`cancel-${f.id}`,{kind:'cancel-launch',fleetId:f.id},seat)).status,200);
  }
  assert.equal(h.room.state.economy.tick,100);
  assert.equal(h.room.state.fleets.filter(f=>f.used).length,0);
  for(let seat=0;seat<2;seat++)assert.equal(h.control.readyToAdvance(h.access.roomId,seat,observation(h.room,seat,h.access.roomId).revision,0),false);
  h.room=advanceRoom(restoreRoom(saveRoom(h.room)),101);
  assert.equal((await h.send('next-cycle-0',launch(1),0)).status,200);
  assert.equal((await h.send('next-cycle-1',launch(1,ENEMY,HOME),1)).status,200);
});

test('dispatch acceptance: v2 owner omitted/manual source and reconnection cannot bypass the shared persisted rule',async t=>{
  const h=await ownerFixture(t);
  const first=await h.send('first',launch());assert.equal(first.status,200);
  const fleet=h.room.state.fleets.find(f=>f.used&&f.owner===0)!;
  assert.equal((await h.send('cancel',{kind:'cancel-launch',fleetId:fleet.id})).status,200);
  h.room=restoreRoom(saveRoom(h.room));
  for(const headers of [{},{'x-subterfuge-controller':'manual'}]) {
    const reply=await h.call('/player/v2/owner/commands',{kind:'order',clientCommandId:'attempt-'+Object.keys(headers).length,expectedRevision:observation(h.room,0,h.access.roomId).revision,payload:{action:launch(1,HOME,BACK)}},0,'manual',headers);
    assert.equal(reply.status,409);assert.equal(reply.body.code,'DISPATCH_SOURCE_LOCKED');
  }
  const takeover=await h.call('/player/v2/owner/control',{action:'takeover',mode:'agent',sessionId:'dispatch-agent-reconnected'},0,'manual');assert.equal(takeover.status,200);
  const reply=await h.call('/player/v2/owner/commands',{kind:'order',clientCommandId:'after-reconnect',expectedRevision:observation(h.room,0,h.access.roomId).revision,payload:{action:launch(1,HOME,BACK)}},0,'manual',{'x-subterfuge-controller':'agent','x-subterfuge-control-session':'dispatch-agent-reconnected','x-subterfuge-manual-version':'0'});
  assert.equal(reply.status,409);assert.equal(reply.body.code,'DISPATCH_SOURCE_LOCKED');
});

test('dispatch acceptance: simultaneous owner/agent edits admit one revision only',async t=>{
  const h=await ownerFixture(t);assert.equal((await h.send('initial',launch(10))).status,200);
  const replies=await Promise.all([h.send('agent-revision',launch(11)),h.send('owner-revision',launch(12),0,'manual')]);
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
  assert.deepEqual(lockedSources(h.room),[HOME]);
  const value=h.room.state.fleets.find(f=>f.used&&f.owner===0)!.drillers;assert.ok(value===11||value===12);
  const committed=saveRoom(h.room);
  const retry=await h.send('new-owner-after-race',launch(13),0,'manual');assert.equal(retry.status,409);assert.equal(retry.body.code,'DISPATCH_SOURCE_LOCKED');
  assert.equal(saveRoom(h.room),committed);
});

async function v2Fixture(t:TestContext) {
  const h=protocolHarness(t),owners=PlayerAccess.generate(2),access=new PlayerAccess({...owners,roomId:'fixture-room'}),serial=new SerialExecutor();
  const server=createPlayerApi({protocol:{repository:h.repository,roomId:'fixture-room',serial,load:()=>h.store.load()!,commit:(room,rev)=>h.store.commit(room,rev),
      ownerIdentity:header=>{const player=access.identity(header);return player===null?null:{roomId:access.roomId,player};}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const call=async(path:string,body:unknown,token=h.first.token,headers:Record<string,string>={})=>{
    const response=await fetch(`http://127.0.0.1:${address.port}`+path,{method:'POST',headers:{authorization:'Bearer '+token,...headers},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  return {h,call,owners};
}

test('dispatch acceptance: v2 executor and owner share guard; denied receipt is durable and exact retries do not execute again',async t=>{
  const x=await v2Fixture(t),{h}=x;
  const firstRequest=h.command('first',{payload:{action:launch(10)}});
  const first=await x.call('/player/v2/commands',firstRequest);assert.equal(first.status,200);assert.equal(first.body.state,'applied');
  const resizeRequest=h.command('resize',{payload:{action:launch(11)}});
  const revision=await x.call('/player/v2/commands',resizeRequest);assert.equal(revision.body.state,'applied');
  const stable=saveRoom(h.store.load()!.room);
  assert.deepEqual((await x.call('/player/v2/commands',resizeRequest)).body,revision.body);
  assert.equal(saveRoom(h.store.load()!.room),stable);
  const deniedRequest=h.command('denied',{payload:{action:launch(12)}});
  const denied=await x.call('/player/v2/commands',deniedRequest,h.first.token,{'x-subterfuge-controller':'manual'});
  assert.equal(denied.body.state,'rejected');assert.equal(denied.body.code,'DISPATCH_SOURCE_LOCKED');assert.equal(denied.body.effectCommitted,false);
  assert.deepEqual((await x.call('/player/v2/commands',deniedRequest)).body,denied.body);
  const lookup=await x.call('/player/v2/commands/lookup',{roomEpoch:h.authority.roomEpoch,idempotencyKeys:['denied']});
  assert.equal(lookup.body.results[0].receipt.code,'DISPATCH_SOURCE_LOCKED');
  const room=h.store.load()!.room;
  const owner=await x.call('/player/v2/owner/commands',{kind:'order',clientCommandId:'owner-escape',expectedRevision:observation(room,0,'fixture-room').revision,payload:{action:launch(1,HOME,BACK)}},x.owners.credentials[0]!.token);
  assert.equal(owner.status,409);assert.equal(owner.body.code,'DISPATCH_SOURCE_LOCKED');
  assert.equal(saveRoom(h.store.load()!.room),stable);
  const fleet=room.state.fleets.find(f=>f.used&&f.owner===0)!;
  const cancel=await x.call('/player/v2/commands',h.command('cancel',{payload:{action:{kind:'cancel-launch',fleetId:fleet.id}}}));assert.equal(cancel.body.state,'applied');
  assert.deepEqual(lockedSources(h.store.load()!.room),[HOME]);
  const previous=h.store.load()!;h.store.commit(advanceRoom(previous.room,101),previous.revision);
  assert.deepEqual((await x.call('/player/v2/commands',deniedRequest)).body,denied.body,'terminal rejected retry cannot become new intent after tick advance');
  assert.equal((await x.call('/player/v2/commands',h.command('fresh-next-tick',{payload:{action:launch(1)}}))).body.state,'applied');
});

test('dispatch acceptance: locked launch candidates never reach expensive forecast execution, including repeated reviews',async()=>{
  let room=order(fixture(),'first',launch(10));room=order(room,'cancel',{kind:'cancel-launch',fleetId:'first'});
  const observed=observation(room,0,room.playerRoomId!),routes=attackRoutes(observed);
  assert.deepEqual(observed.dispatchGuard,{tick:100,lockedSources:[HOME]});
  const unlocked=structuredClone(observed);delete unlocked.dispatchGuard;
  const before=generateBotCandidates(unlocked,attackRoutes(unlocked));
  assert.ok(before.some(c=>c.drafts.some(d=>d.action.kind==='launch'&&d.action.source===HOME)),'fixture must provide an otherwise valid launch candidate');
  for(let pass=0;pass<2;pass++) {
    const candidates=generateBotCandidates(observed,routes);
    assert.equal(candidates.some(c=>c.drafts.some(d=>d.action.kind==='launch'&&d.action.source===HOME)),false);
    let executed=0;
    const decision=await planBotAsync(observed,routes,{maxSimulations:8,maxElapsedMs:30000,horizonTicks:8},async(requests:BotForecastRequest[])=>{
      for(const request of requests) {
        assert.equal(request.drafts?.some(d=>d.action.kind==='launch'&&d.action.source===HOME)??false,false,'locked launch must be excluded before simulation, not rejected after paying for it');
        executed++;
      }
      return requests.map(request=>executeBotForecast(observed,request));
    });
    assert.ok(executed>0,'actual planner/forecast integration must have been exercised');
    assert.equal(decision.selected.drafts.some(d=>d.action.kind==='launch'&&d.action.source===HOME),false);
  }
});

async function freePort() {
  const probe=createPortProbe();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const address=probe.address();assert.ok(address&&typeof address==='object');
  await new Promise<void>(done=>probe.close(()=>done()));return address.port;
}

test('dispatch acceptance: actual main schedule/cancel routes persist the lock across process restart',{timeout:30000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dispatch-main-acceptance-'));
  const store=new RoomStore(join(dir,'subterfuge.sqlite'));store.commit(fixture(),0);store.close();
  const port=await freePort(),playerPort=await freePort(),base=`http://127.0.0.1:${port}`;
  let child:ChildProcess|undefined,logs='';
  const stop=async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}};
  t.after(async()=>{await stop();rmSync(dir,{recursive:true,force:true});});
  const get=async()=>{const response=await fetch(base+'/api/state');assert.equal(response.status,200);return response.json();};
  const post=async(path:string,body:unknown)=>{
    const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const start=async()=>{
    child=fork(resolve('dist/packages/server/src/main.js'),[],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,LAB_DATA_DIR:dir,LAB_PORT:String(port),PLAYER_PORT:String(playerPort),GAME_CLOCK:'manual',NO_PROXY:'127.0.0.1,localhost'}});
    child.stdout!.on('data',chunk=>{logs+=chunk;});child.stderr!.on('data',chunk=>{logs+=chunk;});
    const until=Date.now()+12000;
    while(true){if(child.exitCode!==null)throw Error(logs);try{return await get();}catch(error){if(Date.now()>=until)throw Error(String(error)+' '+logs);await new Promise<void>(done=>setTimeout(done,30));}}
  };
  const initial=await start();assert.equal(initial.tick,100);assert.equal(initial.autoAdvance.enabled,false);
  const original=await post('/api/schedule',{order:{id:'main-original',player:0,action:launch(5)},departureTick:103});assert.equal(original.status,200);
  const futureOrder={id:'main-preserved-future',player:0,action:launch(1,HOME,DEPOT)};
  assert.equal((await post('/api/schedule-order',{order:futureOrder,issueTick:103})).status,200);
  const cancelled=await post('/api/cancel-schedule',{id:'main-original',player:0});assert.equal(cancelled.status,200);
  const beforeMalformed=await get();
  const malformed=await post('/api/schedule-order',{order:futureOrder});
  assert.ok(malformed.status>=400,'omitting issueTick must not execute an existing future command early');
  const afterMalformed=await get();
  assert.deepEqual(afterMalformed.predictionSource,beforeMalformed.predictionSource,'malformed schedule retry must not persist any world/queue change');
  assert.equal((await post('/api/schedule-order',{order:futureOrder,issueTick:103})).status,200,'exact legitimate scheduled retry remains allowed under the lock');
  const deniedBody={id:'main-after-cancel',player:0,action:launch(1,HOME,BACK)};
  for(const path of ['/api/order','/api/schedule-order','/api/schedule']) {
    const payload=path==='/api/order'?deniedBody:path==='/api/schedule-order'?{order:deniedBody,issueTick:103}:{order:deniedBody,departureTick:104};
    const denied=await post(path,payload);assert.equal(denied.status,409,path+' '+JSON.stringify(denied.body));assert.equal(denied.body.code,'DISPATCH_SOURCE_LOCKED');
  }
  await stop();const recovered=await start();assert.equal(recovered.tick,100);assert.equal(recovered.autoAdvance.enabled,false);
  const denied=await post('/api/order',{...deniedBody,id:'main-after-process-restart'});assert.equal(denied.status,409);assert.equal(denied.body.code,'DISPATCH_SOURCE_LOCKED');
  const next=await post('/api/step',{ticks:1});assert.equal(next.status,200);assert.equal(next.body.tick,101);
  assert.equal((await post('/api/order',{...deniedBody,id:'main-next-tick'})).status,200);
});


test('dispatch acceptance: invalid explicit fleet identity cannot lock a claimed source or another seat',()=>{
  const room=order(fixture(),'actual-fleet',launch(10)),before=saveRoom(room);
  assert.throws(()=>order(room,'forged-source',{...launch(11,DEPOT,ENEMY),fleetId:'actual-fleet'} as FleetAction));
  assert.throws(()=>order(room,'forged-owner',{...launch(11),fleetId:'actual-fleet'} as FleetAction,'agent',1));
  assert.equal(saveRoom(room),before);
  assert.deepEqual(lockedSources(room),[]);assert.deepEqual(lockedSources(room,1),[]);
  assert.doesNotThrow(()=>order(room,'legitimate-depot',launch(1,DEPOT,ENEMY)));
  assert.doesNotThrow(()=>order(room,'legitimate-enemy',launch(1,ENEMY,HOME),'agent',1));
});


test('dispatch acceptance: scheduled execution locks its actual tick but never cancels previously accepted edits',()=>{
  let room=order(fixture(),'long-wait',{...launch(10),delaySeconds:3000} as FleetAction);
  room=order(room,'preaccepted-first',{...launch(12),fleetId:'long-wait'} as FleetAction,'agent',0,103);
  assert.deepEqual(lockedSources(room),[HOME]);
  room=advanceRoom(room,101);assert.deepEqual(lockedSources(room),[]);
  room=order(room,'preaccepted-second',{...launch(14),fleetId:'long-wait'} as FleetAction,'agent',0,103);
  room=advanceRoom(restoreRoom(saveRoom(room)),103);
  assert.deepEqual(room.scheduledOrders!.map(p=>p.status),['executed','executed'],'accepted agenda must not be retroactively rejected by the first execution lock');
  assert.equal(room.state.fleets.find(f=>f.used&&f.id==='long-wait')!.drillers,14);
  assert.deepEqual(observation(room,0,room.playerRoomId!).dispatchGuard,{tick:103,lockedSources:[HOME]});
  unchanged(room,()=>order(room,'fresh-after-agenda',launch(1,HOME,BACK),'manual'));
  room=order(room,'cancel-after-agenda',{kind:'cancel-launch',fleetId:'long-wait'});
  assert.equal(room.state.fleets.find(f=>f.id==='long-wait')!.used,false);
  const fresh=advanceRoom(order(fixture(),'preaccepted-new',launch(10),'agent',0,103),103);
  assert.equal(fresh.scheduledOrders![0]!.status,'executed');
  assert.deepEqual(lockedSources(fresh),[],'executing an initial dispatch is not a revision');
});

test('dispatch acceptance: locked new preview drafts reject before future simulation while accepted agenda remains readable',()=>{
  let room=order(fixture(),'queued-preserved',launch(1,HOME,BACK),'agent',0,103);
  room=order(room,'current',launch(10));room=order(room,'current-cancel',{kind:'cancel-launch',fleetId:'current'});
  const before=saveRoom(room),observed=observation(room,0,room.playerRoomId!);
  for(const tick of [100,101,103]) {
    const action=launch(1,HOME,DEPOT),id='blocked-preview-'+tick;
    locked(()=>previewPlayerLaunch(room,0,{id,player:0,action},tick===100?undefined:tick,'manual'));
    locked(()=>simulatePlayerFuture(room,0,104,[{id,player:0,issueTick:tick,action}]));
    assert.throws(()=>createKnownPrediction(observed,{drafts:[{id,issueTick:tick,action}]}),error=>error instanceof Error&&error.message===DISPATCH_LOCK_MESSAGE);
  }
  assert.doesNotThrow(()=>simulatePlayerFuture(room,0,104));
  assert.doesNotThrow(()=>createKnownPrediction(observed).predict(104));
  assert.equal(saveRoom(room),before,'all previews remain read-only and cannot clear or create authoritative locks');
});

test('dispatch acceptance: invalid saved guard metadata cannot silently reopen a source budget',()=>{
  let room=order(fixture(),'first',launch());room=order(room,'revision',launch(11));
  const saved=saveRoom(room);
  for(const patch of [
    (raw:Record<string,unknown>)=>{raw.dispatchLocks={tick:101,locks:[{player:0,source:HOME}]};},
    (raw:Record<string,unknown>)=>{raw.dispatchLocks={tick:100,locks:[{player:0,source:'unknown-outpost'}]};},
    (raw:Record<string,unknown>)=>{raw.dispatchLocks={tick:100,locks:[{player:2,source:HOME}]};},
    (raw:Record<string,unknown>)=>{raw.dispatchLocks={tick:100,locks:[{player:0,source:HOME},{player:0,source:HOME}]};},
  ]) {const raw=JSON.parse(saved) as Record<string,unknown>;patch(raw);assert.throws(()=>restoreRoom(JSON.stringify(raw)),/dispatch lock/);}
  assert.deepEqual(restoreRoom(saved),room);
});


test('dispatch acceptance: missing issue tick cannot turn an accepted future schedule ID into an immediate replay',()=>{
  const queuedAction=launch(2,HOME,DEPOT);
  let room=order(fixture(),'future-id',queuedAction,'agent',0,103);
  room=order(room,'current-first',launch(10));room=order(room,'current-edit',launch(11));
  const before=saveRoom(room);
  assert.throws(()=>order(room,'future-id',queuedAction,'manual'));
  assert.equal(saveRoom(room),before);
  assert.equal(room.state.commands.some(c=>c.id==='future-id'),false);
  const replay=order(room,'future-id',queuedAction,'agent',0,103);
  assert.equal(saveRoom(replay),before);
});

test('dispatch acceptance: frozen lifecycle recall cannot become a launch-loop bypass',()=>{
  const setup=structuredClone(fixture().state.initial);setup.economy.initialTick=0;
  let room:LabRoom={state:createFleetScenario(setup),scheduled:[]};
  room=order(room,'initial-zero',launch(10),'manual');
  room=order(room,'internal-recall',{kind:'recall-waiting-fleet',fleetId:'initial-zero'},'manual');
  assert.deepEqual(lockedSources(room),[HOME]);
  unchanged(room,()=>order(room,'after-internal-recall',launch(1,HOME,BACK),'manual'));
});
