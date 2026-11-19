import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {RoomStore} from '../packages/server/src/room-store.js';
import {realtimeSeconds} from '../packages/server/src/realtime.js';
function fresh(){const setup=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;return {state:createFleetScenario(setup),scheduled:[]};}
test('lightweight metadata reuses only a verified unchanged head, isolates callers and retains clock semantics',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-metadata-')),path=join(dir,'room.sqlite'),store=new RoomStore(path);
 try{
  assert.throws(()=>store.metadata(),/No active room/);
  const initial=fresh(),room={...initial,playerRoomId:'public-room',clock:{format:'realtime-clock/1' as const,anchorMs:1000,anchorTick:initial.state.economy.tick}};
  let revision=store.commit(room,0);
  const internal=store as unknown as {readRoom:(key:string)=>typeof room},read=internal.readRoom;let reads=0;
  internal.readRoom=function(key){reads++;return read.call(this,key);};
  const first=store.metadata();assert.equal(first.roomId,'public-room');assert.equal(reads,1);
  first.state.economy.tick=999;first.clock!.anchorMs=999;
  for(let i=0;i<10;i++)assert.equal(realtimeSeconds(store.metadata(),4321),realtimeSeconds(room,4321));
  assert.equal(realtimeSeconds(store.metadata(),4321),199);
  assert.equal(reads,1);
  const next={...room,state:advanceFleetScenario(room.state,room.state.economy.tick+1)};revision=store.commit(next,revision);
  assert.equal(store.metadata().state.economy.tick,next.state.economy.tick);
  revision=store.commit(fresh(),revision,true);assert.equal(store.metadata().state.economy.tick,room.state.economy.tick);
  const raw=new DatabaseSync(path);raw.exec("UPDATE snapshots SET payload='corrupt' WHERE room_id=(SELECT room_id FROM active_room)");raw.close();
  assert.throws(()=>store.metadata(),/checksum/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('metadata rejects external journal corruption even when revision and digest are unchanged',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-metadata-journal-')),path=join(dir,'room.sqlite'),store=new RoomStore(path);
 try{
  const room=fresh();room.state=submitFleetOrder(room.state,{id:'shield',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}).state;
  store.commit(room,0);store.metadata();const raw=new DatabaseSync(path);raw.exec('DELETE FROM commands');raw.close();
  assert.throws(()=>store.metadata(),/journal/);assert.throws(()=>store.load(),/journal/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('metadata validated in a rolled back commit cannot replace the committed clock basis',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-metadata-rollback-')),store=new RoomStore(join(dir,'room.sqlite'));
 try{
  const room=fresh(),revision=store.commit(room,0),prior=store.metadata();
  const unsubscribe=store.onCommit(()=>{assert.equal(store.metadata().state.economy.tick,room.state.economy.tick+1);throw Error('observer rollback');});
  assert.throws(()=>store.commit({...room,state:advanceFleetScenario(room.state,room.state.economy.tick+1)},revision),/observer rollback/);
  unsubscribe();assert.deepEqual(store.metadata(),prior);assert.equal(store.load()!.revision,revision);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('SQLite persists atomic head and journals, rejects stale writes and immutable history changes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-db-')),path=join(dir,'room.sqlite');let store=new RoomStore(path);
 try{
  assert.equal(store.load(),null);let room=fresh(),revision=store.commit(room,0);assert.equal(revision,1);
  room={...room,state:submitFleetOrder(room.state,{id:'launch',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方后方',drillers:10}},599).state};revision=store.commit(room,revision);
  const second=new RoomStore(path);try{assert.throws(()=>second.commit(room,1),/Stale/);assert.deepEqual(second.load()!.room,room);}finally{second.close();}
  const invalid=structuredClone(room);invalid.state.commands[0]!.id='changed';assert.throws(()=>store.commit(invalid,revision),/Historical/);assert.deepEqual(store.load(),{room,revision});
  const other=structuredClone(room);other.state.initial.size.width+=1;assert.throws(()=>store.commit(other,revision),/identity/);
  room={...room,state:advanceFleetScenario(room.state,104)};revision=store.commit(room,revision);store.close();store=new RoomStore(path);assert.deepEqual(store.load(),{room,revision});
  const reset=fresh();revision=store.commit(reset,revision,true);assert.deepEqual(store.load(),{room:reset,revision});
  const raw=new DatabaseSync(path);try{assert.equal(Number(raw.prepare('SELECT count(*) AS count FROM rooms').get()!.count),2);assert.equal(Number(raw.prepare('SELECT count(*) AS count FROM commands').get()!.count),1);}finally{raw.close();}
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('SQLite rollback leaves prior committed state intact after failed or abandoned transaction',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-db-rollback-')),path=join(dir,'room.sqlite'),store=new RoomStore(path);
 try{
  const room=fresh();store.commit(room,0);
  const writer=new DatabaseSync(path);writer.exec("BEGIN IMMEDIATE; UPDATE snapshots SET digest='incomplete'; UPDATE active_room SET revision=99;");writer.close();
  assert.deepEqual(store.load(),{room,revision:1});
  const raw=new DatabaseSync(path);raw.exec("UPDATE snapshots SET payload='corrupt'");raw.close();assert.throws(()=>store.load(),/checksum/);assert.throws(()=>store.commit(room,1),/checksum/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('unknown database versions and corrupt journal metadata fail closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-db-format-')),path=join(dir,'room.sqlite');
 try{
  const store=new RoomStore(path);let room=fresh();room={...room,state:submitFleetOrder(room.state,{id:'shield',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}).state};store.commit(room,0);
  const raw=new DatabaseSync(path);raw.exec('DELETE FROM commands');assert.throws(()=>store.load(),/journal/);store.close();
  raw.exec('PRAGMA user_version=99');raw.close();assert.throws(()=>new RoomStore(path),/Unsupported/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
