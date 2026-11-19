import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {restoreLobbyStart} from '../packages/server/src/lobby-start.js';
import {createWaitingLobby,submitLobbyMembership} from '../packages/server/src/waiting-lobby.js';
import type {LabRoom} from '../packages/server/src/planning.js';
function fixture(){
 const access=PlayerAccess.generate(2);let lobby=createWaitingLobby(access);
 for(let player=0;player<2;player++)lobby=submitLobbyMembership(lobby,{id:'join-'+player,kind:'join',player});
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;setup.economy.initialTick=0;
 const room:LabRoom={state:createFleetScenario(setup),scheduled:[],playerRoomId:access.roomId};
 return{lobby,room,command:{id:'start-1',player:0,seed:4300,startedAtMs:1800000000000}};
}
test('start map, credentials, membership and timestamp survive restart as one immutable transition',()=>{
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-start-')),file=join(dir,'lobby.sqlite');let store=new LobbyStore(file);
 try{
  const {lobby,room,command}=fixture();store.commit(lobby,0);assert.equal(store.commitStart(room,command,1),2);
  const saved=store.load()!;assert.equal(saved.start!.prepared.secondsUntilGameInProgress,300);assert.equal(saved.start!.startedAtMs,command.startedAtMs);
  assert.deepEqual(saved.start!.prepared.room,room);assert.deepEqual(saved.start!.prepared.access,lobby.access);
  store.close();store=new LobbyStore(file);assert.deepEqual(store.load(),saved);
  assert.equal(store.commitStart(room,{...command,startedAtMs:command.startedAtMs+1000},1),2);
  assert.deepEqual(store.load(),saved);
  assert.throws(()=>store.commitStart(room,{...command,id:'another'},2),/already started/);
  assert.throws(()=>store.commit(submitLobbyMembership(lobby,{id:'leave',kind:'leave',player:1}),2),/already started/);
  const forged=structuredClone(saved.start!);forged.prepared.access.credentials.reverse();
  assert.throws(()=>restoreLobbyStart(JSON.stringify(forged)),/disagrees/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('failed start transaction leaves neither a partial start record nor an advanced lobby revision',()=>{
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-start-')),file=join(dir,'lobby.sqlite'),store=new LobbyStore(file),db=new DatabaseSync(file);
 try{
  const {lobby,room,command}=fixture();store.commit(lobby,0);
  // Fail the revision write after insertion of the complete start record.
  db.exec("CREATE TRIGGER reject_start_revision BEFORE UPDATE ON lobby_head BEGIN SELECT RAISE(ABORT,'injected storage failure'); END");
  assert.throws(()=>store.commitStart(room,command,1),/injected storage failure/);
  assert.equal(store.load()!.revision,1);assert.equal(store.load()!.start,undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM lobby_start').get()!.n,0);
  db.exec('DROP TRIGGER reject_start_revision');assert.equal(store.commitStart(room,command,1),2);
 }finally{db.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('a stale start cannot overwrite a concurrently changed membership or bypass host authorization',()=>{
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-start-')),file=join(dir,'lobby.sqlite'),a=new LobbyStore(file),b=new LobbyStore(file);
 try{
  const {lobby,room,command}=fixture();a.commit(lobby,0);
  b.commit(submitLobbyMembership(lobby,{id:'leave',player:1,kind:'leave'}),1);
  assert.throws(()=>a.commitStart(room,command,1),/Stale/);
  assert.throws(()=>a.commitStart(room,command,2),/two joined/);
  assert.throws(()=>a.commitStart(room,{...command,player:1},2),/Invalid/);
  assert.equal(a.load()!.revision,2);assert.equal(a.load()!.start,undefined);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
