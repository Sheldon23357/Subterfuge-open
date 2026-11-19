import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {RoomStore} from '../packages/server/src/room-store.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby,submitLobbyMembership,projectWaitingLobby,saveWaitingLobby,restoreWaitingLobby} from '../packages/server/src/waiting-lobby.js';
test('waiting membership replays original transitions, preserves credentials and duplicate command identity across restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-lobby-')),file=join(dir,'lobby.sqlite');let store:LobbyStore|undefined;
 try{
  const access=PlayerAccess.generate(4);let lobby=createWaitingLobby(access),before=JSON.stringify(lobby);
  lobby=submitLobbyMembership(lobby,{id:'host',player:0,kind:'join'});assert.notEqual(JSON.stringify(lobby),before);
  lobby=submitLobbyMembership(lobby,{id:'join-1',player:1,kind:'join'});lobby=submitLobbyMembership(lobby,{id:'leave-1',player:1,kind:'leave'});
  store=new LobbyStore(file);const revision=store.commit(lobby,0);store.close();store=new LobbyStore(file);
  const loaded=store.load()!;assert.equal(loaded.revision,revision);assert.deepEqual(loaded.lobby,lobby);
  assert.equal(new PlayerAccess(loaded.lobby.access).identity('Bearer '+access.credentials[1]!.token),1);
  assert.equal(submitLobbyMembership(loaded.lobby,{id:'join-1',player:1,kind:'join'}),loaded.lobby);
  assert.throws(()=>submitLobbyMembership(loaded.lobby,{id:'join-1',player:2,kind:'join'}),/conflict/);
  const rejoined=submitLobbyMembership(loaded.lobby,{id:'rejoin-1',player:1,kind:'join'});store.commit(rejoined,revision);
  const publicState=projectWaitingLobby(store.load()!.lobby);assert.deepEqual(publicState.occupied,[true,true,false,false]);
  assert.equal(JSON.stringify(publicState).includes(access.credentials[0]!.token),false);assert.equal('commands'in publicState,false);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('concurrent lobby commits reject stale revisions, history rewrites and identity replacement atomically',()=>{
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-lobby-')),file=join(dir,'lobby.sqlite');let a:LobbyStore|undefined,b:LobbyStore|undefined;
 try{
  a=new LobbyStore(file);b=new LobbyStore(file);const initial=createWaitingLobby(PlayerAccess.generate(2));a.commit(initial,0);
  const first=submitLobbyMembership(initial,{id:'join',player:0,kind:'join'});a.commit(first,1);
  assert.throws(()=>b!.commit(submitLobbyMembership(initial,{id:'other',player:1,kind:'join'}),1),/Stale/);
  assert.throws(()=>a!.commit(initial,2),/history/);assert.throws(()=>a!.commit(createWaitingLobby(PlayerAccess.generate(2)),2),/identity/);
  assert.deepEqual(b.load()!.lobby,first);
  const cancelled=submitLobbyMembership(first,{id:'cancel',player:0,kind:'cancel'});a.commit(cancelled,2);
  assert.throws(()=>submitLobbyMembership(cancelled,{id:'late',player:1,kind:'join'}),/rejected/);
  assert.equal(a.load()!.lobby.status,'cancelled');
 }finally{a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});
test('invalid snapshots and database identities are rejected without repair or old-save field defaults',()=>{
 const lobby=createWaitingLobby(PlayerAccess.generate(2)),data=JSON.parse(saveWaitingLobby(lobby));
 data.expected.seats[0]=1;assert.throws(()=>restoreWaitingLobby(JSON.stringify(data)),/disagree/);
 const extra=JSON.parse(saveWaitingLobby(lobby));extra.access.extra=true;assert.throws(()=>restoreWaitingLobby(JSON.stringify(extra)),/fields/);
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-lobby-')),file=join(dir,'lobby.sqlite');
 try{
  const store=new LobbyStore(file);store.commit(lobby,0);store.close();assert.throws(()=>new RoomStore(file),/format/);
  const db=new DatabaseSync(file);db.prepare('UPDATE lobby_head SET digest=?').run('corrupt');db.close();
  const damaged=new LobbyStore(file);try{assert.throws(()=>damaged.load(),/checksum/);}finally{damaged.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
