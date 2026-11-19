import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {parseRoomTiming,type RoomTiming} from '../packages/contracts/src/index.js';
import {createFleetScenario,submitFleetOrder,generateOriginalMap,hasGameplayMapComposition,applyGameplayMapComposition,type FleetSetup} from '../packages/engine/src/index.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {createLifecycleService} from '../packages/server/src/lifecycle-service.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby,submitLobbyMembership} from '../packages/server/src/waiting-lobby.js';
import {startRealtime,catchUpRealtime,realtimeSeconds} from '../packages/server/src/realtime.js';
import {restoreRoom,saveRoom} from '../packages/server/src/planning.js';
import {PlayerProtocolClient,MemoryProtocolClientStore} from '../packages/player-sdk/src/index.js';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
async function fixture(timing:RoomTiming,players=2,joined=players){
 const dir=mkdtempSync(join(tmpdir(),'room-modes-')),path=join(dir,'room.sqlite'),access=PlayerAccess.generate(players);
 let lobby=createWaitingLobby(access);for(const player of (players===3&&joined===2?[0,2]:Array.from({length:joined},(_,i)=>i)))lobby=submitLobbyMembership(lobby,{id:'join'+player,player,kind:'join'});
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;cfg.economy.initialTick=0;cfg.match={mode:'mining',neptuniumGoal:200};
 if(players===3){cfg.economy.players.push({active:true,neptunium:0,minesCreated:0});cfg.economy.outposts[2]!.owner=2;}
 if(timing.mode==='realtime')cfg.match.realtimeTickMilliseconds=timing.tickSeconds*1000;
 const room={state:createFleetScenario(cfg),scheduled:[],playerRoomId:access.roomId,timing};
 let now=1000000;const store=new LobbyStore(path,{wallNow:()=>now});store.commit(lobby,0,room);const service=createLifecycleService(store,{now:()=>now});await service.ready;
 const seed=joined<players?(await generateOriginalMap(joined,4300,()=>Promise.resolve(),hasGameplayMapComposition,applyGameplayMapComposition)).seed:4300;
 store.commitStart(room,{id:'start',player:0,seed,startedAtMs:now},1);now+=300000;await service.synchronize();
 return {store,service,path,dir,access,setNow:(value:number)=>{now=value;},close:async()=>{service.stopClock();service.server.close();await service.drain();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('turn lobby executes durable batch children on its shared database and passes cold replay audit',async()=>{
 const f=await fixture({mode:'turn-based'}),token='synthetic-lobby-batch-token-0001';
 try{
  const repository=f.store.protocol,roomId=f.access.roomId;
  repository.registerGrant({grantId:'lobby-batch-grant',roomId,roomEpoch:repository.currentEpoch(roomId),player:0,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAtMs:5000000,scopes:['observe','events.read','commands.write','control.lease']});
  f.service.server.listen(0,'127.0.0.1');await once(f.service.server,'listening');const address=f.service.server.address() as {port:number};
  const client=new PlayerProtocolClient({serverUrl:`http://127.0.0.1:${address.port}`,token,store:new MemoryProtocolClientStore(),expectedIdentity:{roomId,gamePlayer:0},optionalCapabilities:['actions.batch/1']});
  await client.acquire();const snapshot=await client.snapshot(),revision=(snapshot.observation as {revision:string}).revision;
  const result=await client.commandBatch({idempotencyKey:'lobby-batch',clientCommandId:'lobby-batch',expectedRevision:revision,instructionsVersion:'0',commands:[false,true].map((enabled,i)=>({idempotencyKey:'lobby-child-'+i,clientCommandId:'lobby-child-'+i,expectedRevision:revision,instructionsVersion:'0',payload:{action:{kind:'set-shields',outpostId:'蓝方工厂',enabled}}}))});
  assert.deepEqual(result.receipt.effects!.batchReceipts!.map(r=>r.state),['applied','applied']);assert.equal(f.store.current()!.runtime!.room.state.commands.length,2);
  await client.release();const audit=new LobbyStore(f.path,undefined,{buildId:'batch-test-audit',auditOnly:true});try{assert.deepEqual(audit.verify(),f.store.load());}finally{audit.close();}
 }finally{await f.close();}
});
test('room timing validates bounds; custom realtime phase, cold restore and tick cadence use the room duration',async()=>{
 assert.deepEqual(parseRoomTiming(),{mode:'realtime',tickSeconds:10});
 for(const value of [{mode:'realtime',tickSeconds:0},{mode:'realtime',tickSeconds:3601},{mode:'realtime',tickSeconds:1.5},{mode:'turn-based',tickSeconds:10}])assert.throws(()=>parseRoomTiming(value));
 const f=await fixture({mode:'realtime',tickSeconds:30});
 try{assert.equal(realtimeSeconds(f.store.current()!.runtime!.room,1315000),300);f.setNow(1330000);await f.service.synchronize();assert.equal(f.store.current()!.runtime!.room.state.economy.tick,1);assert.deepEqual(restoreRoom(saveRoom(f.store.current()!.runtime!.room)),f.store.current()!.runtime!.room);}
 finally{await f.close();}
});
test('turn-based play waits for every living human, does not catch up wall time, and advances exactly once',async()=>{
 const f=await fixture({mode:'turn-based'});
 try{f.setNow(30000000);await f.service.synchronize();assert.equal(f.store.current()!.runtime!.room.state.economy.tick,0);assert.equal(f.store.current()!.runtime!.room.clock,undefined);
 f.store.setTurnReady(0,0,true);await f.service.synchronize();assert.equal(f.store.current()!.runtime!.room.state.economy.tick,0);
 f.store.setTurnReady(1,0,true);await f.service.synchronize();assert.equal(f.store.current()!.runtime!.room.state.economy.tick,1);assert.ok(f.store.turnPlayers().players.every(p=>!p.ready));
 assert.throws(()=>f.store.setTurnReady(0,0,true));await f.service.synchronize();assert.equal(f.store.current()!.runtime!.room.state.economy.tick,1);assert.deepEqual(f.store.verify(),f.store.load());}
 finally{await f.close();}
});
test('an AI seat blocks advancement until its existing protocol readiness is acknowledged',async()=>{
 const f=await fixture({mode:'turn-based'});
 try{const id=f.access.roomId,sessionId='turn-agent-session-0001';f.store.protocol.ownerControl(id,1,{action:'acquire',sessionId,ttlMs:120000});
 f.store.setTurnReady(0,0,true);assert.throws(()=>f.store.setTurnReady(1,0,true),/AI controls/);await f.service.synchronize();assert.equal(f.store.current()!.runtime!.room.state.economy.tick,0);
 f.store.protocol.ownerReadiness(id,1,{ready:true,revision:'a'.repeat(64),chatCursor:0},{'x-subterfuge-controller':'agent','x-subterfuge-control-session':sessionId});await f.service.synchronize();assert.equal(f.store.current()!.runtime!.room.state.economy.tick,1);await f.service.synchronize();assert.equal(f.store.current()!.runtime!.room.state.economy.tick,1);}
 finally{await f.close();}
});
import type {AddressInfo} from 'node:net';
import {createRoomHub} from '../packages/server/src/room-hub.js';
import {shouldAutoResign} from '../packages/engine/src/lifecycle.js';
test('variable realtime cadence keeps the inactivity limit at three real hours',()=>{
 assert.equal(shouldAutoResign(359,0,false,'realtime-3h',30000),false);assert.equal(shouldAutoResign(360,0,false,'realtime-3h',30000),true);
});
test('turn endpoint authenticates owners, rejects arbitrary seat selection and stale duplicate readiness',async()=>{
 const f=await fixture({mode:'turn-based'});
 try{await new Promise<void>(r=>f.service.server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(f.service.server.address() as AddressInfo).port}`;
 const send=(player:number,body:unknown)=>fetch(origin+'/lobby/v2/turn',{method:'POST',headers:{Authorization:`Bearer ${f.access.credentials[player]!.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await fetch(origin+'/lobby/v2/turn')).status,401);
 assert.equal((await send(0,{tick:0,ready:true,player:1})).status,400);
 const first=await send(0,{tick:0,ready:true});assert.equal(first.status,200);assert.equal((await first.json()).tick,0);
 const second=await send(1,{tick:0,ready:true});assert.equal(second.status,200);assert.equal((await second.json()).tick,1);
 const stale=await send(1,{tick:0,ready:true});assert.equal(stale.status,409);await stale.body?.cancel();assert.equal(f.store.current()!.runtime!.room.state.economy.tick,1);
 }finally{await f.close();}
});
test('committed human readiness survives cold restore without offline turn advancement',async()=>{
 const f=await fixture({mode:'turn-based'});f.store.setTurnReady(0,0,true);f.service.server.close();await f.service.drain();f.store.close();
 const store=new LobbyStore(f.path),service=createLifecycleService(store,{now:()=>2000000});
 try{await service.ready;await service.synchronize();assert.equal(store.current()!.runtime!.room.state.economy.tick,0);assert.equal(store.turnPlayers().players.find(p=>p.player===0)!.ready,true);store.setTurnReady(1,0,true);await service.synchronize();assert.equal(store.current()!.runtime!.room.state.economy.tick,1);}
 finally{service.server.close();await service.drain();store.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('public room creation persists both timing modes and rejects invalid tick duration and conflicting retry', {timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-timing-'));const hub=await createRoomHub({directory:dir,webRoot:resolve('packages/client/public')});
 try{await new Promise<void>(r=>hub.server.listen(0,'127.0.0.1',r));await hub.ready;const origin=`http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
 const create=(key:string,timing:unknown)=>fetch(origin+'/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,name:'模式测试',capacity:2,timing})});
 const invalid=await create('f'.repeat(64),{mode:'realtime',tickSeconds:0});assert.equal(invalid.status,400);await invalid.body?.cancel();
 for(const [key,timing]of [['a'.repeat(64),{mode:'realtime',tickSeconds:30}],['b'.repeat(64),{mode:'turn-based'}]] as const){const response=await create(key,timing);assert.equal(response.status,200);assert.deepEqual((await response.json()).timing,timing);}
 const conflict=await create('a'.repeat(64),{mode:'turn-based'});assert.equal(conflict.status,409);await conflict.body?.cancel();
 const rooms=(await(await fetch(origin+'/api/rooms')).json()).rooms;assert.equal(rooms.length,2);
 const turn=rooms.find((r:any)=>r.timing.mode==='turn-based');const joined=await fetch(`${origin}/api/rooms/${turn.code}/join`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'c'.repeat(64),seat:1})});assert.equal(joined.status,200);assert.equal((await joined.json()).player,1);
 }finally{await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('only living seats form the barrier; check-in keeps readiness while a gameplay edit cancels it',async()=>{
 const f=await fixture({mode:'turn-based'},3);
 try{
  const change=(player:number,id:string,action:Parameters<typeof submitFleetOrder>[1]['action'])=>{const current=f.store.current()!,room=current.runtime!.room;f.store.commitRoom({...room,state:submitFleetOrder(room.state,{id,player,action}).state},current.revision);};
  change(2,'retire-third',{kind:'resign'});assert.deepEqual(f.store.turnPlayers().players.map(p=>p.player),[0,1]);
  f.store.setTurnReady(0,0,true);change(0,'maintenance',{kind:'check-in'});assert.equal(f.store.turnPlayers().players[0]!.ready,true);
  change(0,'edit',{kind:'set-shields',outpostId:'蓝方工厂',enabled:false});assert.equal(f.store.turnPlayers().players[0]!.ready,false);
  f.store.setTurnReady(0,0,true);f.store.setTurnReady(1,0,true);await f.service.synchronize();assert.equal(f.store.current()!.runtime!.room.state.economy.tick,1);
 }finally{await f.close();}
});

test('early start seat compaction keeps the selected realtime duration and strict restore',async()=>{
 const f=await fixture({mode:'realtime',tickSeconds:30},3,2);
 try{const saved=f.store.current()!;assert.equal(saved.start!.prepared.recreated,true);assert.equal(saved.runtime!.room.state.economy.players.length,2);assert.equal(saved.runtime!.room.state.initial.match!.realtimeTickMilliseconds,30000);assert.deepEqual(saved.runtime!.room.timing,{mode:'realtime',tickSeconds:30});assert.deepEqual(f.store.verify(),f.store.load());}finally{await f.close();}
});

test('turn readiness keeps original owner credentials mapped to the compacted game seat',async()=>{
 const f=await fixture({mode:'turn-based'},3,2);
 try{await new Promise<void>(r=>f.service.server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(f.service.server.address() as AddressInfo).port}`;
 const request=(owner:number,data?:unknown)=>fetch(origin+'/lobby/v2/turn',{method:data?'POST':'GET',headers:{Authorization:`Bearer ${f.access.credentials[owner]!.token}`,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
 const own=await request(2);assert.equal(own.status,200);assert.equal((await own.json()).self,1);
 const absent=await request(1);assert.equal(absent.status,409);await absent.body?.cancel();
 const last=await request(2,{tick:0,ready:true});assert.equal(last.status,200);assert.equal((await last.json()).tick,0);
 const host=await request(0,{tick:0,ready:true});assert.equal(host.status,200);assert.equal((await host.json()).tick,1);
 }finally{await f.close();}
});

test('manual terminal actions in a waiting turn record their actual ending time',async()=>{
 const f=await fixture({mode:'turn-based'});
 try{f.setNow(1500000);const current=f.store.current()!,room=current.runtime!.room;
 f.store.commitRoom({...room,state:submitFleetOrder(room.state,{id:'finish',player:1,action:{kind:'resign'}}).state},current.revision);
 assert.equal(f.store.current()!.runtime!.status,'ended');assert.equal(f.store.current()!.runtime!.syncedAtMs,1500000);assert.deepEqual(f.store.verify(),f.store.load());}
 finally{await f.close();}
});
