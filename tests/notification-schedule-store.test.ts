import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NotificationScheduleStore} from '../packages/server/src/notification-schedule-store.js';
import type {DatabaseSync} from 'node:sqlite';
import type {ForecastNotificationEntry} from '../packages/engine/src/index.js';
const notice=(sequence=0,minutes=1):ForecastNotificationEntry=>({sequence,source:'sonar',notification:{kind:'sonar-contact',tick:101,minutesBeforeSending:minutes,fleetId:'known',position:{x:1,y:2},multiple:false,sendNotification:true,generateAlert:false}});

test('failed replacement rolls back removed forecasts, new entries and generation together',()=>{
 const store=new NotificationScheduleStore(':memory:');
 const db=(store as unknown as {db:DatabaseSync}).db;
 try{
  store.replace('r',0,0,'old',0,[notice()]);
  db.exec("CREATE TRIGGER reject_second_notice BEFORE INSERT ON notices WHEN json_extract(NEW.payload,'$.entry.sequence')=2 BEGIN SELECT RAISE(ABORT,'synthetic insertion failure'); END;");
  assert.throws(()=>store.replace('r',0,1,'new',0,[notice(1),notice(2)]),/synthetic insertion failure/);
  assert.equal(store.generation('r',0),1);
  const delivered=store.deliverDue('r',0,'old',1000);
  assert.equal(delivered.length,1);assert.equal(delivered[0]!.entry.sequence,0);
  db.exec('DROP TRIGGER reject_second_notice');
  assert.equal(store.replace('r',0,1,'new',0,[]),2);
 }finally{store.close();}
});
test('schedule replacement survives restart, preserves due ordering and delivered identity',()=>{
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-notice-')),path=join(dir,'notices.sqlite');
 let store=new NotificationScheduleStore(path);
 try{
  assert.equal(store.replace('room',0,0,'r1',1000,[notice(0),notice(1)]),1);
  assert.deepEqual(store.deliverDue('room',0,'r1',1999),[]);
  store.close();store=new NotificationScheduleStore(path);
  const due=store.deliverDue('room',0,'r1',2000);assert.deepEqual(due.map(n=>n.entry.sequence),[0,1]);
  assert.notEqual(due[0]!.id,due[1]!.id,'identical same-tick occurrences remain separate');
  assert.deepEqual(store.deliverDue('room',0,'r1',999999),[]);
  store.replace('room',0,1,'r2',70000,[notice(7,2),notice(8,2)]);
  assert.deepEqual(store.deliverDue('room',0,'r2',999999),[],'recomputed delay/sequence does not repeat delivered events');
  assert.equal(store.inbox('room',0).length,2);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('revision invalidation cancels only pending items and stale producers cannot overwrite replacement',()=>{
 const store=new NotificationScheduleStore(':memory:');
 try{
  store.replace('a',0,0,'old',0,[notice()]);
  store.replace('a',1,0,'old',0,[notice()]);store.replace('b',0,0,'old',0,[notice()]);
  assert.deepEqual(store.deliverDue('a',0,'changed',60000),[]);
  assert.equal(store.generation('a',0),2);
  assert.throws(()=>store.replace('a',0,1,'old',0,[notice()]),/Stale/);
  assert.deepEqual(store.inbox('a',0),[]);
  assert.equal(store.deliverDue('a',1,'old',60000).length,1);
  assert.equal(store.deliverDue('b',0,'old',60000).length,1);
  const off=notice();off.notification.sendNotification=false;
  store.replace('a',0,2,'fresh',60000,[off]);assert.deepEqual(store.deliverDue('a',0,'fresh',120000),[]);
  assert.throws(()=>store.replace('a',0,3,'fresh',0,[notice(0,-1)]),/time/);
  assert.equal(store.generation('a',0),3);
 }finally{store.close();}
});
test('two store connections use generation CAS for atomic replacement',()=>{
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-notice-cas-')),path=join(dir,'notices.sqlite');
 const a=new NotificationScheduleStore(path),b=new NotificationScheduleStore(path);
 try{
  a.replace('room',0,0,'first',0,[notice()]);
  assert.throws(()=>b.replace('room',0,0,'stale',0,[]),/Stale/);
  b.replace('room',0,1,'second',0,[]);
  assert.deepEqual(a.deliverDue('room',0,'second',60000),[]);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('confirmed occurrence survives forecast refresh before its original rounded send time',()=>{
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-notice-confirm-')),path=join(dir,'notices.sqlite');
 let store=new NotificationScheduleStore(path);
 try{
  // Event occurs at 10000; original Pc rounds the delivery to 11000.
  const predicted=notice(0,11);store.replace('r',0,0,'tick-100',0,[predicted]);
  const occurred=notice(99,1);
  // Equivalent property ordering and alert display metadata must not change
  // the underlying event identity confirmed by the real recipient archive.
  occurred.notification={...occurred.notification,generateAlert:true};
  store.replace('r',0,1,'tick-101',10000,[],[occurred]);
  assert.deepEqual(store.deliverDue('r',0,'tick-101',10999),[]);
  store.close();store=new NotificationScheduleStore(path);
  const delivered=store.deliverDue('r',0,'changed-again',11000);
  assert.equal(delivered.length,1);assert.equal(delivered[0]!.dueAtMs,11000);
  assert.deepEqual(store.deliverDue('r',0,'changed-again',11001),[]);
  assert.equal(store.inbox('r',0).length,1);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('different real event content cannot confirm a false prediction',()=>{
 const store=new NotificationScheduleStore(':memory:');
 try{
  store.replace('r',0,0,'old',0,[notice()]);
  const different=notice();if(different.source==='sonar')different.notification.fleetId='another-fleet';
  store.replace('r',0,1,'new',60000,[],[different]);
  assert.deepEqual(store.deliverDue('r',0,'new',999999),[]);
 }finally{store.close();}
});
test('late-arriving confirmed items append to inbox rather than invalidating pagination cursors',()=>{
 const store=new NotificationScheduleStore(':memory:');
 try{
  store.replace('r',0,0,'a',0,[notice(0,2)]);store.deliverDue('r',0,'a',120000);
  const prefix=store.inbox('r',0);
  const earlier=notice(0,1);earlier.notification.tick=100;
  store.replace('r',0,1,'b',0,[earlier]);store.deliverDue('r',0,'b',120000);
  assert.deepEqual(store.inbox('r',0).slice(0,1),prefix);
  assert.equal(store.inbox('r',0)[1]!.entry.notification.tick,100);
 }finally{store.close();}
});
