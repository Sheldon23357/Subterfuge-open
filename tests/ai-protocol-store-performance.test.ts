import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteProtocolClientStore} from '../packages/ai/src/controller/transport/protocol-store.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import type {OutboxEntry} from '../packages/player-sdk/src/store.js';
import {emptyProtocolClientState} from '../packages/player-sdk/src/store.js';

const entry=(key:string,state:OutboxEntry['state']='settled'):OutboxEntry=>({
 scope:{serverId:'server',roomId:'room',roomEpoch:'epoch',playerId:'player'},
 request:{kind:'readiness',roomEpoch:'epoch',sessionId:'session',fence:'1',authorizationVersion:'1',idempotencyKey:key,clientCommandId:key,expectedRevision:'revision',instructionsVersion:'0',payload:{ready:true,tick:1}},
 intentDigest:'a'.repeat(64),attempts:1,state,receipt:null,reason:null,
});

test('timing and unrelated journal writes do not reload protocol history; current state stays cloneable',t=>{
 const dir=mkdtempSync(join(tmpdir(),'protocol-hot-')),path=join(dir,'seat.sqlite');
 const journal=new AiStore(path),store=new SqliteProtocolClientStore(path);
 try{
  store.transaction(state=>{for(let i=0;i<1500;i++)state.outbox['old-'+i]=entry('old-'+i);state.outbox.pending=entry('pending','unknown');});
  const db=(store as unknown as {db:DatabaseSync}).db,prepare=db.prepare.bind(db);let historyReads=0;
  t.mock.method(db,'prepare',(sql:string)=>{if(sql.includes('SELECT key,document FROM player_protocol_outbox'))historyReads++;return prepare(sql);});
  const parse=JSON.parse.bind(JSON),parsedHistory=t.mock.method(JSON,'parse',(text:string,reviver?:Parameters<typeof JSON.parse>[1])=>{
    assert.ok(!text.includes('"idempotencyKey":"old-'),'hot state access must not deserialize settled history');return parse(text,reviver);
  });
  journal.recordTiming('room',0,'protocol-request-timing',{durationMs:1});journal.flushTimings();
  assert.equal(store.load().sequence,'0');assert.equal(historyReads,0);
  assert.deepEqual(store.outboxEntries(['unknown']).map(row=>row.request.idempotencyKey),['pending']);
  store.transaction(state=>{state.application.marker=1;state.outbox.pending!.state='settled';});
  assert.equal(historyReads,0);assert.equal(store.outboxEntries(['unknown']).length,0);
  parsedHistory.mock.restore();
  assert.equal(store.outboxEntry('old-5')!.state,'settled');assert.equal(store.outboxEntry('missing'),undefined);
  const snapshot=store.load();store.transaction(state=>{state.outbox['old-5']!.reason='changed';});
  assert.equal(structuredClone(snapshot).outbox['old-5']!.reason,null);
  assert.equal(store.outboxEntry('old-5')!.reason,'changed');
  const detached=store.load();detached.outbox={};assert.deepEqual(Object.keys(detached.outbox),[]);assert.ok(store.outboxEntry('old-5'));
 }finally{store.close();journal.close();rmSync(dir,{recursive:true,force:true});}
});

test('lazy command changes roll back atomically; deletion and explicit history replacement persist',()=>{
 const store=new SqliteProtocolClientStore(':memory:');
 try{
  store.transaction(state=>{state.outbox.first=entry('first');state.outbox.second=entry('second');});
  assert.throws(()=>store.transaction(state=>{state.outbox.first!.reason='wrong';delete state.outbox.second;state.sequence='9';throw Error('rollback');}),/rollback/);
  assert.equal(store.load().sequence,'0');assert.equal(store.outboxEntry('first')!.reason,null);assert.ok(store.outboxEntry('second'));
  store.transaction(state=>{delete state.outbox.first;state.outbox.second!.reason='kept';});
  assert.equal(store.outboxEntry('first'),undefined);assert.equal(store.outboxEntry('second')!.reason,'kept');
  store.transaction(state=>{state.outbox={replacement:entry('replacement')};});
  assert.deepEqual(Object.keys(store.load().outbox),['replacement']);
 }finally{store.close();}
});

test('a second protocol connection invalidates the captured state without audit cache churn',()=>{
 const dir=mkdtempSync(join(tmpdir(),'protocol-external-')),path=join(dir,'seat.sqlite');
 const a=new SqliteProtocolClientStore(path),b=new SqliteProtocolClientStore(path);
 try{
  a.transaction(state=>{state.outbox.item=entry('item');});const before=a.load();
  b.transaction(state=>{state.sequence='4';state.outbox.item!.reason='external';});
  assert.equal(a.load().sequence,'4');assert.equal(a.outboxEntry('item')!.reason,'external');
  assert.equal(before.outbox.item!.reason,null);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('obsolete embedded command history is rejected without rewriting the archive',()=>{
 const dir=mkdtempSync(join(tmpdir(),'protocol-format-')),path=join(dir,'seat.sqlite'),db=new DatabaseSync(path);
 try{
  const document=JSON.stringify({...emptyProtocolClientState(),outbox:{old:entry('old')}});
  db.exec('CREATE TABLE player_protocol_client(singleton INTEGER PRIMARY KEY,document TEXT NOT NULL)');
  db.prepare('INSERT INTO player_protocol_client VALUES(1,?)').run(document);
  assert.throws(()=>new SqliteProtocolClientStore(path),/Invalid split private protocol state/);
  assert.equal(db.prepare('SELECT document FROM player_protocol_client').get()!.document,document);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('permission status reads skip snapshot parsing and observe external safety stops',t=>{
 const dir=mkdtempSync(join(tmpdir(),'protocol-status-')),path=join(dir,'seat.sqlite');
 const a=new SqliteProtocolClientStore(path),b=new SqliteProtocolClientStore(path);
 try{
  a.transaction(state=>{state.snapshot={large:'SNAPSHOT_CANARY'.repeat(10000)};});
  const parse=JSON.parse.bind(JSON),mock=t.mock.method(JSON,'parse',(text:string,reviver?:Parameters<typeof JSON.parse>[1])=>{
   assert.ok(!text.includes('SNAPSHOT_CANARY'),'warm permission checks must not parse the snapshot');return parse(text,reviver);
  });
  for(let i=0;i<20;i++)assert.equal(a.readSafetyStop(),null);
  mock.mock.restore();
  b.transaction(state=>{state.safetyStop='external-stop';});assert.equal(a.readSafetyStop(),'external-stop');
  assert.throws(()=>a.transaction(state=>{state.safetyStop=null;throw Error('rollback');}),/rollback/);
  assert.equal(a.readSafetyStop(),'external-stop');
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
