import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PlayerObservationReader,observation} from '../packages/server/src/player-observation.js';
import {protocolHarness} from './player-protocol-test-helpers.js';
import {submitFleetOrder,advanceFleetScenario,projectPlayerCommandHead} from '../packages/engine/src/index.js';
import {restoreRoom,saveRoom} from '../packages/server/src/planning.js';

test('latest own command is inherited across ticks and clones and reconstructed on restore without historical hash input',t=>{
 const h=protocolHarness(t),room=h.store.load()!.room;
 assert.equal(projectPlayerCommandHead(room.state,0),null);
 const next=submitFleetOrder(room.state,{id:'latest-own',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}).state;
 assert.deepEqual(projectPlayerCommandHead(next,0),{id:'latest-own',tick:100});assert.equal(projectPlayerCommandHead(room.state,0),null);
 const advanced=advanceFleetScenario(next,101);
 assert.deepEqual(projectPlayerCommandHead(advanced,0),{id:'latest-own',tick:100});
 const restored=restoreRoom(saveRoom({...room,state:advanced},{trustedLocalStorage:true}),{trustedLocalStorage:true});
 assert.deepEqual(projectPlayerCommandHead(restored.state,0),{id:'latest-own',tick:100});
 assert.equal(observation(restored,0,h.roomId).revision,observation({...room,state:advanced},0,h.roomId).revision);
});

test('trusted current reads reuse only a fully verified immutable cut and invalidate on commit or external tampering',t=>{
 const h=protocolHarness(t),store=h.store,internal=store as unknown as {readRoom:(key:string)=>unknown};
 const read=internal.readRoom;let reads=0;internal.readRoom=function(key){reads++;return read.call(this,key);};
 const first=store.current()!;assert.ok(Object.isFrozen(first.room.state.economy));
 for(let i=0;i<50;i++)assert.equal(store.current(),first);
 assert.equal(reads,1,'stable protocol reads do not replay or rescan historical journals');
 assert.throws(()=>{first.room.state.economy.tick++;},TypeError);
 const mutable=store.load()!;mutable.room.state.economy.players[0]!.neptunium++;
 assert.notEqual(mutable.room.state.economy.players[0]!.neptunium,store.current()!.room.state.economy.players[0]!.neptunium);
 h.apply(h.command('current-cut-write'));const second=store.current()!;assert.notEqual(second,first);
 const beforeVerify=reads;store.verify();assert.ok(reads>beforeVerify,'explicit audit still reads actual storage');
 const raw=new DatabaseSync(h.path);raw.prepare("UPDATE commands SET payload='{}' WHERE ordinal=0").run();raw.close();
 assert.throws(()=>store.current(),/journal mismatch/,'out-of-process mutations invalidate the trusted cut');
});

test('observation cache separates seats, identity, revisions and realtime seconds',t=>{
 const h=protocolHarness(t),room=h.store.current()!.room;let reads=0;
 const reader=new PlayerObservationReader((...args)=>{reads++;return observation(...args);});
 const first=reader.read(room,0,h.roomId,1,0);
 assert.equal(reader.read(room,0,h.roomId,1,0),first);assert.equal(reads,1);
 assert.equal(reader.read(room,1,h.roomId,1,0).view.player,1);assert.equal(reads,2);
 const later=reader.read(room,0,h.roomId,1,599);assert.equal(later.secondsSinceLastTick,599);assert.equal(reads,3);
 assert.notEqual(reader.read(room,0,h.roomId,2,599),later);assert.equal(reads,4);
 assert.equal(reader.read(room,0,'different-room',2,599).roomId,'different-room');assert.equal(reads,5);
});

test('pending and incremental event queries seek indexed working sets while retained history grows',t=>{
 const h=protocolHarness(t);
 for(let i=0;i<200;i++){const accepted=h.repository.acceptCommand(h.first.principal,h.command(`indexed-${i}`));h.repository.settleCommand(h.first.principal,accepted.commandId,()=>({state:'applied'}));}
 const db=new DatabaseSync(h.path,{readOnly:true});try{
 const pendingPlan=db.prepare("EXPLAIN QUERY PLAN SELECT command_id FROM protocol_operations WHERE room_epoch=? AND player=? AND state='accepted' LIMIT 1").all(h.authority.roomEpoch,0);
 assert.match(JSON.stringify(pendingPlan),/protocol_pending_seat/);
 const current=h.repository.stream(h.first.principal),eventSql='SELECT payload FROM protocol_events WHERE room_epoch=? AND player=? AND (length(seq),seq)>(?,?) ORDER BY length(seq),seq LIMIT ?';
 const args=[h.authority.roomEpoch,0,current.highWatermark.length,current.highWatermark,101] as const;
 const eventPlan=JSON.stringify(db.prepare('EXPLAIN QUERY PLAN '+eventSql).all(...args));
 assert.match(eventPlan,/protocol_event_position/);assert.doesNotMatch(eventPlan,/TEMP B-TREE/);
 assert.equal(db.prepare(eventSql).all(...args).length,0);
 h.repository.acceptCommand(h.first.principal,h.command('one-pending'));
 assert.equal(db.prepare("SELECT count(*) n FROM protocol_operations WHERE room_epoch=? AND player=? AND state='accepted'").get(h.authority.roomEpoch,0)!.n,1);
 assert.equal(h.repository.readyPlayers(h.roomId,100)[0]!.ready,false);
 const events=h.repository.events(h.first.principal,current.cursor);assert.equal(events.events.length,1);assert.equal(events.events[0]!.type,'command.status.changed');
 }finally{db.close();}
});
