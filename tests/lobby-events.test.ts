import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createFleetScenario,originalMapCandidate,applyGameplayMapComposition,lifecycleNotices,type FleetSetup} from '../packages/engine/src/index.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby,submitLobbyMembership} from '../packages/server/src/waiting-lobby.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {createLobbyApi} from '../packages/server/src/lobby-api.js';
import {projectLobbyEvents} from '../packages/server/src/lobby-events.js';

test("lifecycle handlers preserve priority and notification flags (local rules)",()=>{

 const joined=lifecycleNotices('join',4,2,3);assert.deepEqual(joined.map((n:{player:number})=>n.player),[0,1,2,3]);
 assert.equal(joined[3]!.text,'You joined the game (2 seats available)');assert.equal(joined[0]!.notify,false);
 assert.equal(lifecycleNotices('starting',2,2,0,28800)[0]!.priority,1);
 assert.equal(lifecycleNotices('started',2,2,0)[0]!.notify,true);
 // Preserve the original handler in extraction; local text does not reproduce
 // its accidental reuse of a previous seat's string when the leaving seat > 0.
 assert.equal(lifecycleNotices('leave',2,1,0)[0]!.text,'');
});
test('event cursor is stable across remapping, restart, repeated sync and pagination without exposing start internals',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'subterfuge-events-')),file=join(directory,'lobby.sqlite'),access=PlayerAccess.generate(4),epoch=1800000000000;
 let lobby=createWaitingLobby(access);for(const [id,player,kind] of [['host',0,'join'],['temporary',3,'join'],['leave',3,'leave'],['return',3,'join']] as const)lobby=submitLobbyMembership(lobby,{id,player,kind});
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;cfg.economy.initialTick=0;cfg.economy.players=Array.from({length:4},()=>({active:true,neptunium:0,minesCreated:0}));
 let store=new LobbyStore(file);store.commit(lobby,0,{state:createFleetScenario(cfg),scheduled:[],playerRoomId:access.roomId});
 let seed=4300;while(seed<4800&&!applyGameplayMapComposition(originalMapCandidate(2,seed),seed).valid)seed++;assert.ok(seed<4800);
 store.commitStart(store.load()!.waitingRoom!,{id:'private-start-command',player:0,seed,startedAtMs:epoch},1);
 const before=projectLobbyEvents(store.load()!,3);assert.equal(before.length,5);assert.equal(before.at(-1)!.kind,'starting');assert.equal(before.at(-1)!.priority,'urgent');
 assert.equal(before[2]!.text,'你离开了房间，剩余 3 个席位');assert.equal(before[0]!.atMs,null);
 await store.sync(epoch+300000,2);await store.sync(epoch+300000,3);
 const started=projectLobbyEvents(store.load()!,3);assert.equal(started.length,6);assert.equal(started[5]!.kind,'started');assert.equal(started[5]!.notify,true);
 assert.deepEqual(started.slice(0,5),before);assert.equal(projectLobbyEvents(store.load()!,1).length,4);
 store.close();store=new LobbyStore(file);assert.deepEqual(projectLobbyEvents(store.load()!,3),started);
 const server=createLobbyApi(store);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}/lobby/v2/events`,headers={Authorization:'Bearer '+access.credentials[3]!.token};
 try{
  assert.equal((await fetch(url)).status,401);
  const first=await(await fetch(url+'?after=0&limit=2',{headers})).json();assert.equal(first.nextCursor,2);assert.equal(first.hasMore,true);
  const second=await(await fetch(url+'?after=2&limit=200',{headers})).json();assert.deepEqual([...first.events,...second.events],started);assert.equal(second.nextCursor,6);assert.equal(second.hasMore,false);
  for(const query of ['after=-1','after=7','after=1&after=2','player=0','limit=201','after=NaN'])assert.equal((await fetch(url+'?'+query,{headers})).status,400);
  const text=JSON.stringify(second);for(const key of ['private-start-command','sourceRoom','prepared','seed','credentials'])assert.equal(text.includes(key),false);
  for(const c of access.credentials)assert.equal(text.includes(c.token),false);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(directory,{recursive:true,force:true});}
});
