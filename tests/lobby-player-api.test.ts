import {test} from 'node:test';
import {TICK_MILLISECONDS} from '../packages/server/src/realtime.js';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createFleetScenario,originalMapCandidate,applyGameplayMapComposition,type FleetSetup} from '../packages/engine/src/index.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby,submitLobbyMembership} from '../packages/server/src/waiting-lobby.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {createLifecycleService} from '../packages/server/src/lifecycle-service.js';
import type {LabRoom} from '../packages/server/src/planning.js';

test('lifecycle player v2 API enforces opening, compacted identity, durable orders and scheduled execution',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-lifecycle-api-')),file=join(dir,'lobby.sqlite'),access=PlayerAccess.generate(4),epoch=1800000000000;
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let lobby=createWaitingLobby(access);for(const player of [0,3])lobby=submitLobbyMembership(lobby,{id:'join'+player,player,kind:'join'});
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;setup.economy.initialTick=0;setup.economy.players=Array.from({length:4},()=>({active:true,neptunium:0,minesCreated:0}));
 const waiting:LabRoom={state:createFleetScenario(setup),scheduled:[],playerRoomId:access.roomId};
 let store=new LobbyStore(file);store.commit(lobby,0);let seed=4300;while(seed<4800&&!applyGameplayMapComposition(originalMapCandidate(2,seed),seed).valid)seed++;assert.ok(seed<4800);
 store.commitStart(waiting,{id:'start',player:0,seed,startedAtMs:epoch},1);
 let now=epoch,service=createLifecycleService(store,{now:()=>now}),server=service.server,url='';
 const start=async()=>{server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');url=`http://127.0.0.1:${address.port}`;await service.ready;};
 const stop=async()=>{service.stopClock();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await service.drain();store.close();};
 const headers=(seat:number)=>({Authorization:'Bearer '+access.credentials[seat]!.token,'Content-Type':'application/json'});
 const observe=(seat=3)=>fetch(url+'/player/v2/owner/observation',{headers:headers(seat)});
 const post=(body:unknown)=>fetch(url+'/player/v2/owner/commands',{method:'POST',headers:headers(3),body:JSON.stringify(body)});
 try{
  await start();assert.equal((await observe()).status,200);assert.equal(store.load()!.runtime!.room.state.commands.length,0);
  assert.equal((await observe(1)).status,401);
  now=epoch+300000;const response=await observe();assert.equal(response.status,200);let observation=await response.json() as {roomId:string;revision:string;view:{player:number}};
  assert.equal(observation.view.player,1);assert.equal(observation.roomId,access.roomId);
  const target=store.load()!.runtime!.room.state.economy.outposts.find(o=>o.owner===1)!;
  const order={kind:'order',clientCommandId:'shield',expectedRevision:observation.revision,payload:{action:{kind:'set-shields',outpostId:target.id,enabled:false}}};
  let result=await post(order);assert.equal(result.status,200);observation=await result.json() as typeof observation;
  assert.equal(store.load()!.runtime!.room.state.commands[0]!.player,1);
  result=await post({kind:'schedule',clientCommandId:'restore-shield',expectedRevision:observation.revision,issueTick:2,payload:{action:{kind:'set-shields',outpostId:target.id,enabled:true}}});
  assert.equal(result.status,200);assert.equal(store.load()!.runtime!.room.scheduledOrders!.length,1);
  await stop();store=new LobbyStore(file);now+=2*TICK_MILLISECONDS;service=createLifecycleService(store,{now:()=>now});server=service.server;await start();
  result=await observe();assert.equal(result.status,200);observation=await result.json() as typeof observation;
  const state=store.load()!.runtime!.room.state;assert.equal(state.economy.tick,2);assert.equal(state.commands.length,2);
  assert.equal(state.economy.outposts.find(o=>o.id===target.id)!.shieldsEnabled,true);
  assert.equal((await post(order)).status,200);assert.equal(store.load()!.runtime!.room.state.commands.length,2);
  for(const forbidden of ['prepared','sourceLobby','sourceRoom','credentials','lobbySeat'])assert.equal(JSON.stringify(observation).includes('"'+forbidden+'"'),false);
  for(const c of access.credentials)assert.equal(JSON.stringify(observation).includes(c.token),false);
 }finally{if(store.load())await stop();}
});
