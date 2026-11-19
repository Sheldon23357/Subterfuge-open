import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createFleetScenario,originalLobbyCountdown,type FleetSetup} from '../packages/engine/src/index.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby,submitLobbyMembership} from '../packages/server/src/waiting-lobby.js';
import {prepareLobbyStart,type StoredLobbyStart} from '../packages/server/src/lobby-start.js';
import {createLobbyRuntime,advanceLobbyRuntime,saveLobbyRuntime,restoreLobbyRuntime} from '../packages/server/src/lobby-runtime.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {saveRoom,type LabRoom} from '../packages/server/src/planning.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
const epoch=1800000000123;
function fixture(){
 let lobby=createWaitingLobby(PlayerAccess.generate(2));for(let player=0;player<2;player++)lobby=submitLobbyMembership(lobby,{id:'join'+player,player,kind:'join'});
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;setup.economy.initialTick=0;
 let room:LabRoom={state:createFleetScenario(setup),scheduled:[],playerRoomId:lobby.access.roomId};
 room=scheduleOrder(room,{order:{id:'saved-action',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}},issueTick:2});
 const prepared=prepareLobbyStart(lobby,0,4300,room),start:StoredLobbyStart={format:'stored-lobby-start/1',id:'start',seed:4300,startedAtMs:epoch,sourceRoom:saveRoom(room,{trustedLocalStorage:true}),prepared};
 return{lobby,room,start,opening:epoch+prepared.secondsUntilGameInProgress*1000};
}
test('countdown matches original one-second updates, opens once, and does not consume a gameplay tick at the boundary',async()=>{
 const {start,opening}=fixture(),initial=createLobbyRuntime(start);let events=0;
 const reference={status:2,timeFactor:1,secondsSinceCreation:0,secondsSinceStarting:0,secondsUntilGameInProgress:300,listener:{handleGameStarted:()=>events++}};
 for(let i=0;i<300;i++)originalLobbyCountdown(reference,1);
 const before=await advanceLobbyRuntime(start,initial,opening-1);assert.equal(before.status,'starting');assert.equal(before.secondsRemaining,1);assert.equal(before.room.state.economy.tick,0);
 const opened=await advanceLobbyRuntime(start,before,opening);assert.equal(opened.status,'in-progress');assert.equal(opened.secondsRemaining,reference.secondsUntilGameInProgress);
 assert.equal(events,1);assert.equal(opened.room.state.economy.tick,0);assert.equal(opened.room.clock!.anchorMs,opening);
 assert.equal(await advanceLobbyRuntime(start,opened,opening+999),opened);assert.equal(await advanceLobbyRuntime(start,opened,epoch),opened);
 assert.deepEqual(restoreLobbyRuntime(saveLobbyRuntime(opened),start),opened);
 assert.equal((await advanceLobbyRuntime(start,opened,opening+10000)).room.state.economy.tick,1);
 assert.equal(initial.status,'starting');assert.equal(initial.room.clock,undefined);
});
test('offline recovery across opening equals online batches and executes only saved future commands once',async()=>{
 const {start,opening}=fixture(),initial=createLobbyRuntime(start),target=opening+30000;
 const offline=await advanceLobbyRuntime(start,initial,target);let online=initial;
 for(const now of [epoch+1000,opening-1000,opening,opening+10000,opening+20000,target])online=await advanceLobbyRuntime(start,restoreLobbyRuntime(saveLobbyRuntime(online),start),now);
 assert.deepEqual(offline,online);assert.equal(offline.room.state.economy.tick,3);assert.deepEqual(offline.room.state.commands.map(c=>c.id),['saved-action']);
 assert.equal(offline.room.scheduledOrders![0]!.status,'executed');
 const forged=JSON.parse(saveLobbyRuntime(offline));forged.syncedAtMs=opening+10000;
 assert.throws(()=>restoreLobbyRuntime(JSON.stringify(forged),start),/not caught up/);
 for(const now of [NaN,Infinity,-1,epoch+.5])await assert.rejects(advanceLobbyRuntime(start,initial,now),/wall time/);
});
test('SQLite persists opening and catch-up atomically, rejects stale syncs, and restores after restart',async()=>{
 const {lobby,room,start,opening}=fixture(),dir=mkdtempSync(join(tmpdir(),'subterfuge-runtime-')),file=join(dir,'lobby.sqlite');let store=new LobbyStore(file);
 const db=new DatabaseSync(file);
 try{
  store.commit(lobby,0);store.commitStart(room,{id:start.id,seed:start.seed,player:0,startedAtMs:epoch},1);
  db.exec("CREATE TRIGGER reject_time BEFORE UPDATE ON lobby_head BEGIN SELECT RAISE(ABORT,'time write failed'); END");
  await assert.rejects(store.sync(opening+20000,2),/time write failed/);assert.equal(store.load()!.runtime!.status,'starting');assert.equal(store.load()!.revision,2);
  db.exec('DROP TRIGGER reject_time');assert.equal(await store.sync(opening+20000,2),3);
  await assert.rejects(store.sync(opening+30000,2),/Stale/);
  const saved=store.load();store.close();store=new LobbyStore(file);assert.deepEqual(store.load(),saved);
  assert.equal(await store.sync(opening+30000,3),4);const final=store.load()!;
  assert.equal(final.runtime!.room.state.economy.tick,3);assert.equal(final.runtime!.room.state.commands.length,1);
  assert.equal(await store.sync(opening+30999,4),4);
 }finally{db.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
