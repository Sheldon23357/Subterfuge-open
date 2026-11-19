import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {tickTimeIntervals} from '../packages/contracts/src/index.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {createLifecycleService} from '../packages/server/src/lifecycle-service.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby,submitLobbyMembership} from '../packages/server/src/waiting-lobby.js';
import {PlayerProtocolClient,MemoryProtocolClientStore} from '../packages/player-sdk/src/index.js';
import {ProtocolPlayerGateway} from '../packages/ai/src/controller/transport/protocol-gateway.js';
import {validateSettings} from '../packages/ai/src/controller/contracts/types.js';

function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'server-tick-times-')),file=join(directory,'lifecycle.sqlite');
 let wall=1800000000000,elapsed=100;
 const clocks={wallNow:()=>wall,elapsedNow:()=>elapsed};
 let store=new LobbyStore(file,clocks);
 const access=PlayerAccess.generate(2);let lobby=createWaitingLobby(access);
 for(let player=0;player<2;player++)lobby=submitLobbyMembership(lobby,{id:'join-'+player,player,kind:'join'});
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;setup.economy.initialTick=0;
 const room={state:createFleetScenario(setup),scheduled:[],playerRoomId:access.roomId};
 store.commit(lobby,0,room);store.commitStart(room,{id:'start',player:0,seed:4300,startedAtMs:wall},1);
 const advance=async(ms:number)=>{wall+=ms;elapsed+=ms;await store.sync(wall,store.current()!.revision);};
 return {access,advance,get wall(){return wall;},get store(){return store;},clocks,reopen(){store.close();elapsed=0;store=new LobbyStore(file,clocks);store.observeTick();},badClock(v:boolean){elapsed=v?-1:wall-1800000000000;},close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('lifecycle timing records atomic server boundaries, pagination, batches and restart downtime',async()=>{
 const f=fixture();try{
  assert.equal(f.store.tickTimes().records.length,0,'countdown is not a gameplay tick');
  await f.advance(300000);assert.equal(f.store.tickTimes().records[0]!.kind,'observed');
  await f.advance(10000);await f.advance(10000);
  const all=f.store.tickTimes(),intervals=tickTimeIntervals(all.records);
  assert.equal(all.headTick,2);assert.equal(all.headElapsedMs,0);assert.equal(all.serverTimeMs,f.wall);
  assert.equal(intervals[0]!.status,'partial-start');assert.equal(intervals[1]!.monotonicElapsedMs,10000);
  const page=f.store.tickTimes(0,1);assert.equal(page.hasMore,true);
  assert.deepEqual([...page.records,...f.store.tickTimes(page.nextCursor).records],all.records);
  await f.advance(500);assert.equal(f.store.tickTimes().headElapsedMs,500);assert.equal(f.store.tickTimes().records.length,3);
  f.reopen();assert.deepEqual(f.store.tickTimes().records,all.records);
  await f.advance(30000);
  const batch=f.store.tickTimes().records.at(-1)!;assert.equal(batch.kind,'batch');assert.equal(batch.fromTick,2);assert.equal(batch.tick,5);
  assert.equal(f.store.tickTimes().records.length,4,'missed ticks must not be interpolated');
 }finally{f.close();}
});

test('a failed timing write rolls back the game tick and its record together',async()=>{
 const f=fixture();try{
  await f.advance(300000);const before=f.store.current()!,records=f.store.tickTimes().records;
  f.badClock(true);await assert.rejects(f.store.sync(f.wall+10000,before.revision),/timing clock/);
  assert.equal(f.store.load()!.runtime!.room.state.economy.tick,0);assert.deepEqual(f.store.tickTimes().records,records);
  f.badClock(false);await f.advance(10000);assert.equal(f.store.tickTimes().headTick,1);
 }finally{f.close();}
});

test('authenticated owner and observe-only executor receive the same server timing without a local database reader',async()=>{
 const f=fixture();const service=createLifecycleService(f.store,{now:()=>f.wall});
 await service.ready;await new Promise<void>(r=>service.server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
 try{
  await f.advance(300000);await f.advance(10000);
  const path='/player/v2/owner/tick-times',headers={Authorization:`Bearer ${f.access.credentials[0]!.token}`};
  assert.equal((await fetch(origin+path)).status,401);
  for(const query of ['after=-1','after=0&after=1','limit=0','limit=1001','roomId=other','after=1.5'])assert.equal((await fetch(origin+path+'?'+query,{headers})).status,400);
  const owner=await(await fetch(origin+path,{headers})).json();assert.equal(owner.headTick,1);assert.equal(owner.records.length,2);
  const token='synthetic_timing_executor_'+ 'x'.repeat(40),epoch=f.store.protocol.currentEpoch(f.access.roomId);
  f.store.protocol.registerGrant({grantId:'timing-fixture',roomId:f.access.roomId,roomEpoch:epoch,player:0,tokenHash:createHash('sha256').update(token).digest('hex'),scopes:['observe'],expiresAtMs:f.wall+1000000});
  const client=new PlayerProtocolClient({serverUrl:origin,token,store:new MemoryProtocolClientStore(),expectedIdentity:{roomId:f.access.roomId,gamePlayer:0},optionalCapabilities:['tick-times.read/1']});
  assert.ok((await client.connect()).capabilities.includes('tick-times.read/1'));
  const page=await client.extensionRequest('tick-times.read/1','/tick-times?after=0') as typeof owner;
  assert.deepEqual(page.records,owner.records);assert.equal(client.writable,false);
  const deniedToken='synthetic_timing_denied_'+'z'.repeat(40);
  f.store.protocol.registerGrant({grantId:'timing-denied',roomId:f.access.roomId,roomEpoch:epoch,player:1,tokenHash:createHash('sha256').update(deniedToken).digest('hex'),scopes:['events.read'],expiresAtMs:f.wall+1000000});
  assert.equal((await fetch(origin+'/player/v2/tick-times',{headers:{Authorization:`Bearer ${deniedToken}`}})).status,403);
  await assert.rejects(client.extensionRequest('core/2','/tick-times'),/UNSUPPORTED_CAPABILITY/);
  const gateway=new ProtocolPlayerGateway({id:'timing',serverUrl:origin,roomId:f.access.roomId,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'TEST_TOKEN',settings:validateSettings({model:'',personality:'schemer'})},token);
  try{const remote=await gateway.tickTimes(0);assert.equal(remote?.roomId,f.access.roomId);assert.deepEqual(remote?.records,owner.records);}finally{gateway.close();}
 }finally{service.server.closeAllConnections();await new Promise<void>(r=>service.server.close(()=>r()));await service.drain();f.close();}
});
