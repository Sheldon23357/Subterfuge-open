import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createFleetScenario,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {advanceRoom,saveRoom,type LabRoom} from '../packages/server/src/planning.js';
import {RoomStore} from '../packages/server/src/room-store.js';
import {tickTimeIntervals} from '../packages/server/src/tick-times.js';
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'tick-times-')),path=join(dir,'subterfuge.sqlite');
  const setup=JSON.parse(await readFile('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  const room:LabRoom={state:createFleetScenario(setup),scheduled:[],playerRoomId:'test-room'};
  let wall=100000,mono=100;
  const options={wallNow:()=>wall,monotonicNow:()=>mono};
  const store=new RoomStore(path,options);
  return {dir,path,room,store,options,time:(w:number,m:number)=>{wall=w;mono=m;},close:async()=>{store.close();await rm(dir,{recursive:true,force:true});}};
}

test('local timing reports authoritative match end even with no new timing page and after reopening',async()=>{
 const f=await fixture();try{
  const setup=JSON.parse(await readFile('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  setup.match={mode:'mining',neptuniumGoal:1};
  const ended={state:createFleetScenario(setup),scheduled:[],playerRoomId:'test-room'};
  const revision=f.store.commit(ended,0);
  assert.equal(f.store.tickTimes(0).ended,true);
  const cursor=f.store.tickTimes().records.at(-1)!.id;
  const empty=f.store.tickTimes(cursor);assert.equal(empty.ended,true);assert.equal(empty.records.length,0);
  f.time(200000,100100);f.store.observeTick(revision);assert.equal(f.store.tickTimes(cursor).ended,true);
  f.store.commit(f.room,revision,true);assert.equal(f.store.tickTimes(0).ended,false);
 }finally{await f.close();}
});
test('real commits record tick boundaries atomically; previews and same-tick writes do not',async()=>{
  const f=await fixture();try{
    let revision=f.store.commit(f.room,0);const tick=f.room.state.economy.tick;
    advanceRoom(f.room,tick+3,true);assert.equal(f.store.tickTimes().records.length,1);
    f.time(110000,10100);revision=f.store.commit(f.room,revision);f.store.observeTick(revision);
    assert.equal(f.store.tickTimes().records.length,1);
    let next=advanceRoom(f.room,tick+1);f.time(120000,20100);revision=f.store.commit(next,revision,false,'automatic');
    next=advanceRoom(next,tick+2);f.time(125432,25532);revision=f.store.commit(next,revision,false,'automatic');
    const records=f.store.tickTimes().records;
    assert.deepEqual(f.store.tickTimes(0).records,records);
    assert.deepEqual(records.map(r=>[r.tick,r.kind,r.source]),[[tick,'observed','state-write'],[tick+1,'advance','automatic'],[tick+2,'advance','automatic']]);
    const intervals=tickTimeIntervals(records);
    assert.equal(intervals[0]!.status,'partial-start');
    assert.deepEqual(intervals[1],{tick:tick+1,nextTick:tick+2,startedAtMs:120000,finishedAtMs:125432,wallElapsedMs:5432,monotonicElapsedMs:5432,status:'complete'});
    assert.throws(()=>f.store.commit(next,revision-1),/Stale/);
    assert.equal(f.store.tickTimes().records.length,3);
  }finally{await f.close();}
});
test('failed transaction rolls both the snapshot and tick anchor back',async()=>{
  const f=await fixture();try{
    const revision=f.store.commit(f.room,0),raw=new DatabaseSync(f.path);
    raw.exec("CREATE TRIGGER fail_anchor BEFORE INSERT ON tick_time_anchors WHEN NEW.kind='advance' BEGIN SELECT RAISE(ABORT,'anchor failure'); END;");raw.close();
    assert.throws(()=>f.store.commit(advanceRoom(f.room,f.room.state.economy.tick+1),revision),/anchor failure/);
    assert.equal(f.store.load()!.revision,revision);assert.equal(f.store.load()!.room.state.economy.tick,f.room.state.economy.tick);
    assert.equal(f.store.tickTimes().records.length,1);
  }finally{await f.close();}
});
test('batch advances are recorded as batches without inventing intermediate times',async()=>{
  const f=await fixture();try{
    let revision=f.store.commit(f.room,0);f.time(130000,30100);
    revision=f.store.commit(advanceRoom(f.room,f.room.state.economy.tick+4),revision,false,'manual');
    const records=f.store.tickTimes().records;
    assert.equal(records.length,2);assert.equal(records[1]!.kind,'batch');
    assert.equal(tickTimeIntervals(records)[0]!.status,'batch');
    assert.throws(()=>f.store.commit(f.room,revision),/rewind/);
  }finally{await f.close();}
});
test('restart retains the original boundary and includes downtime; reset isolates rooms and paging',async()=>{
  const f=await fixture();let reopened:RoomStore|undefined;try{
    let revision=f.store.commit(f.room,0);let next=advanceRoom(f.room,f.room.state.economy.tick+1);
    f.time(120000,20100);revision=f.store.commit(next,revision);const original=f.store.tickTimes().records[1]!;
    reopened=new RoomStore(f.path,{wallNow:()=>150000,monotonicNow:()=>10});reopened.observeTick(revision);
    assert.deepEqual(reopened.tickTimes().records[1],original);
    next=advanceRoom(next,next.state.economy.tick+1);revision=reopened.commit(next,revision);
    const all=reopened.tickTimes();const duration=tickTimeIntervals(all.records)[1]!;
    assert.equal(duration.wallElapsedMs,30000);assert.equal(duration.monotonicElapsedMs,null);assert.equal(duration.status,'complete');
    const page=reopened.tickTimes(0,2);assert.equal(page.hasMore,true);
    assert.deepEqual([...page.records,...reopened.tickTimes(page.nextCursor,2).records],all.records);
    revision=reopened.commit({...f.room,playerRoomId:'other-room'},revision,true);
    assert.equal(reopened.tickTimes().roomId,'other-room');assert.equal(reopened.tickTimes().records.length,1);
    assert.throws(()=>reopened!.tickTimes(-1),/cursor/);assert.throws(()=>reopened!.tickTimes(0,5001),/cursor/);
  }finally{reopened?.close();await f.close();}
});
test('clock adjustments remain visible rather than becoming negative or invented durations',async()=>{
  const f=await fixture();try{
    let revision=f.store.commit(f.room,0),next=advanceRoom(f.room,f.room.state.economy.tick+1);
    f.time(120000,20100);revision=f.store.commit(next,revision);
    next=advanceRoom(next,next.state.economy.tick+1);f.time(119000,25100);f.store.commit(next,revision);
    const interval=tickTimeIntervals(f.store.tickTimes().records)[1]!;
    assert.equal(interval.status,'clock-adjusted');assert.equal(interval.wallElapsedMs,-1000);assert.equal(interval.monotonicElapsedMs,5000);
  }finally{await f.close();}
});
test('already running saves get only a partial baseline and backup retains time records',async()=>{
  const f=await fixture();let copy:RoomStore|undefined;try{
    const running={...f.room,state:advanceFleetScenario(f.room.state,f.room.state.economy.tick+5)};
    const revision=f.store.commit(running,0);
    const raw=new DatabaseSync(f.path);raw.exec('DELETE FROM tick_time_anchors');raw.close();
    f.time(140000,40100);f.store.observeTick(revision);
    const record=f.store.tickTimes().records[0]!;assert.equal(record.tick,running.state.economy.tick);assert.equal(record.kind,'observed');assert.equal(record.wallTimeMs,140000);
    const backup=join(f.dir,'copy.sqlite');await f.store.backup(backup);copy=new RoomStore(backup,{...f.options,readOnly:true});
    assert.deepEqual(copy.tickTimes(),f.store.tickTimes());
  }finally{copy?.close();await f.close();}
});
test('SQLite fallback instruments a pre-existing writer without restart and rolls back with its transaction',async()=>{
  const f=await fixture();let installer:RoomStore|undefined,legacy:DatabaseSync|undefined;
  try{
    f.store.commit(f.room,0);
    legacy=new DatabaseSync(f.path);
    legacy.exec('DROP TRIGGER tick_time_head_insert; DROP TRIGGER tick_time_head_update; DROP TABLE tick_time_anchors;');
    const updateSnapshot=legacy.prepare('UPDATE snapshots SET payload=?,digest=?'),updateHead=legacy.prepare('UPDATE active_room SET revision=revision+1');
    installer=new RoomStore(f.path);installer.observeTick(1);
    const next=advanceRoom(f.room,f.room.state.economy.tick+1),payload=saveRoom(next,{trustedLocalStorage:true});
    const digest=createHash('sha256').update(payload).digest('hex');
    legacy.exec('BEGIN IMMEDIATE');updateSnapshot.run(payload,digest);updateHead.run();legacy.exec('ROLLBACK');
    assert.equal(installer.tickTimes().records.length,1);
    const before=Date.now();legacy.exec('BEGIN IMMEDIATE');updateSnapshot.run(payload,digest);updateHead.run();legacy.exec('COMMIT');
    const recorded=installer.tickTimes().records;
    assert.equal(recorded.length,2);assert.equal(recorded[1]!.source,'database-trigger');assert.equal(recorded[1]!.kind,'advance');
    assert.equal(recorded[1]!.tick,next.state.economy.tick);assert.ok(recorded[1]!.wallTimeMs>=before-1&&recorded[1]!.wallTimeMs<=Date.now()+1);
    updateHead.run();assert.equal(installer.tickTimes().records.length,2);
    // A new server's explicit clock data takes precedence over the fallback.
    const rev=Number(legacy.prepare('SELECT revision FROM active_room').get()!.revision);
    installer.commit(advanceRoom(next,next.state.economy.tick+1),rev,false,'automatic');
    assert.equal(installer.tickTimes().records.at(-1)!.source,'automatic');
  }finally{legacy?.close();installer?.close();await f.close();}
});
