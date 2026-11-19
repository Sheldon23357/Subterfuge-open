import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {readNotifications} from '../packages/engine/src/notification-journal.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {RoomStore} from '../packages/server/src/room-store.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby,submitLobbyMembership} from '../packages/server/src/waiting-lobby.js';

function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'subterfuge-verified-cut-')),path=join(directory,'room.sqlite');
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 setup.economy.initialTick=0;
 const access=PlayerAccess.generate(setup.economy.players.length),room={state:createFleetScenario(setup),scheduled:[],playerRoomId:access.roomId};
 let lobby=createWaitingLobby(access);
 for(let player=0;player<access.credentials.length;player++)lobby=submitLobbyMembership(lobby,{id:`join-${player}`,player,kind:'join'});
 return{directory,path,room,lobby};
}

test('lobby readers share a frozen verified cut while mutable loads retain event journals',()=>{
 const f=fixture(),store=new LobbyStore(f.path);
 try{
  store.commit(f.lobby,0,f.room);
  const first=store.current()!;
  assert.ok(Object.isFrozen(first));assert.ok(Object.isFrozen(first.waitingRoom!.state));
  for(let i=0;i<20;i++)assert.equal(store.current(),first);
  const copy=store.load()!;
  copy.lobby.access.roomId='caller-change';copy.waitingRoom!.state.economy.players[0]!.neptunium=99;
  assert.equal(store.current(),first);assert.equal(first.waitingRoom!.state.economy.players[0]!.neptunium,0);
  assert.notEqual(readNotifications(copy.waitingRoom!.state,0),null);
  assert.throws(()=>{first.lobby.seats[0]=0;},TypeError);
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('lobby caches follow external writes and reject corrupt payloads without revision changes',()=>{
 const f=fixture(),store=new LobbyStore(f.path),other=new LobbyStore(f.path);
 try{
  store.commit(f.lobby,0,f.room);const before=store.current()!;
  other.commit(submitLobbyMembership(f.lobby,{id:'leave',player:1,kind:'leave'}),1);
  assert.notEqual(store.current(),before);assert.equal(store.current()!.lobby.seats[1],0);
  const raw=new DatabaseSync(f.path);raw.exec("UPDATE lobby_waiting_world SET payload='corrupt'");raw.close();
  assert.throws(()=>store.current(),/checksum/);assert.throws(()=>store.load(),/checksum/);
 }finally{other.close();store.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('lobby incremental runtime validation retains strict expected-state verification and explicit audits',async()=>{
 const f=fixture(),store=new LobbyStore(f.path),epoch=1800000000000;
 try{
  store.commit(f.lobby,0,f.room);store.commitStart(f.room,{id:'start',player:0,seed:99,startedAtMs:epoch},1);
  const opening=epoch+store.current()!.start!.prepared.secondsUntilGameInProgress*1000;
  await store.sync(opening+10000,2);const first=store.current()!;
  assert.equal(first.runtime!.room.state.economy.tick,1);
  await store.sync(opening+10500,first.revision);assert.equal(store.current(),first);
  await store.sync(opening+11000,first.revision);const phase=store.current()!;
  assert.equal(phase.runtime!.room,first.runtime!.room);
  assert.equal(phase.runtime!.syncedAtMs,opening+11000);
  await store.sync(opening+20000,phase.revision);
  assert.equal(store.current()!.runtime!.room.state.economy.tick,2);
  assert.deepEqual(store.verify(),store.load());
  const raw=new DatabaseSync(f.path),row=raw.prepare('SELECT payload FROM lobby_runtime').get()!;
  const runtime=JSON.parse(String(row.payload)),room=JSON.parse(runtime.room),snapshot=JSON.parse(room.snapshot);
  snapshot.expected.economy.players[0].neptunium+=1;room.snapshot=JSON.stringify(snapshot);runtime.room=JSON.stringify(room);
  const payload=JSON.stringify(runtime);raw.prepare('UPDATE lobby_runtime SET payload=?,digest=?').run(payload,createHash('sha256').update(payload).digest('hex'));raw.close();
  assert.throws(()=>store.current(),/disagree/);assert.throws(()=>store.verify(),/disagree/);
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('failed lobby observer transactions do not publish cached uncommitted state',()=>{
 const f=fixture(),store=new LobbyStore(f.path);
 try{
  store.commit(f.lobby,0,f.room);const before=store.current()!;
  const unsubscribe=store.onCommit(()=>{assert.equal(store.current()!.revision,2);throw Error('rollback observer');});
  assert.throws(()=>store.commit(submitLobbyMembership(f.lobby,{id:'leave',player:1,kind:'leave'}),1),/rollback observer/);
  unsubscribe();assert.deepEqual(store.current(),before);
  store.commit(submitLobbyMembership(f.lobby,{id:'cancel',player:0,kind:'cancel'}),1);
  assert.equal(store.current()!.lobby.status,'cancelled');assert.equal(store.current()!.revision,2);
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('live lobby commands invalidate shared rooms and subsequent clock phases preserve the new facts',async()=>{
 const f=fixture(),store=new LobbyStore(f.path),epoch=1800000000000;
 try{
  store.commit(f.lobby,0,f.room);store.commitStart(f.room,{id:'start',player:0,seed:99,startedAtMs:epoch},1);
  const opening=epoch+store.current()!.start!.prepared.secondsUntilGameInProgress*1000;
  await store.sync(opening+10000,2);const before=store.current()!,room=before.runtime!.room;
  const changed={...room,state:submitFleetOrder(room.state,{id:'live-shield',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}).state};
  store.commitRoom(changed,before.revision);const committed=store.current()!;
  assert.notEqual(committed.runtime!.room,room);
  assert.equal(committed.runtime!.room.state.commands.at(-1)!.id,'live-shield');
  await store.sync(opening+11000,committed.revision);
  assert.equal(store.current()!.runtime!.room,committed.runtime!.room);
  assert.deepEqual(store.verify(),store.load());
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('room cut cache distinguishes different contents at the same revision after rollback',()=>{
 const f=fixture(),store=new RoomStore(f.path);
 try{
  store.commit(f.room,0);store.current();
  const order=(id:string,enabled:boolean)=>({...f.room,state:submitFleetOrder(f.room.state,{id,player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled}}).state});
  const unsubscribe=store.onCommit(()=>{assert.equal(store.current()!.revision,2);throw Error('rollback observer');});
  assert.throws(()=>store.commit(order('rolled-back',false),1),/rollback observer/);unsubscribe();
  store.commit(order('committed',false),1);
  assert.equal(store.current()!.room.state.commands[0]!.id,'committed');
 }finally{store.close();rmSync(f.directory,{recursive:true,force:true});}
});
