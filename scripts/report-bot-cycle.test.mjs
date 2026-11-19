import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {reportCycle,triggerTable} from './report-bot-cycle.mjs';

test('multiple triggers retain coverage without double-counting an operation',()=>{
 const rows=triggerTable([{causes:['a','b','a']},{causes:['b']},{}]);
 assert.equal(rows.find(r=>r.reason==='b').operations,2);
 assert.equal(rows.find(r=>r.reason==='b').sharePercent,50);
 assert.equal(rows.find(r=>r.reason==='a').weightedOperations,.5);
 assert.ok(Math.abs(rows.reduce((n,r)=>n+r.sharePercent,0)-100)<1e-9);
 assert.deepEqual(triggerTable([]),[]);
});

test('journal boundaries exclude cached searches and queue-only requests across periods',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'subterfuge-cycle-'));
 const stores=path.join(directory,'independent-agent');fs.mkdirSync(stores);
 const write=(name,value)=>fs.writeFileSync(path.join(directory,name),JSON.stringify(value));
 write('launch.json',{iteration:2,restartAt:'2026-10-28T00:00:00Z'});
 write('iteration-2-baseline.json',{game:{roomId:'test-room',tick:10}});
 write('controller-bindings.json',{roomId:'test-room',bindings:[{seat:0,slot:2}]});
 const db=new DatabaseSync(path.join(stores,'a'.repeat(64)+'.sqlite'));
 db.exec('CREATE TABLE seats(room TEXT,seat INTEGER); CREATE TABLE journal(id INTEGER PRIMARY KEY,room TEXT,seat INTEGER,kind TEXT,payload TEXT)');
 db.prepare('INSERT INTO seats VALUES(?,?)').run('test-room',0);
 const insert=db.prepare('INSERT INTO journal(room,seat,kind,payload) VALUES(?,?,?,?)');
 const add=(kind,payload)=>insert.run('test-room',0,kind,JSON.stringify(payload));
 add('agent-started',{});
 add('started',{sequence:1,tick:11,triggers:[{kind:'fleet-state-change'}]});
 add('mode-hybrid-search',{sequence:1,decision:{coverage:{simulations:4}}});
 add('tactical-search-completed',{sequence:1});
 add('mode-hybrid-search',{sequence:1,decision:{coverage:{simulations:4}}}); // cache reuse
 add('mode-hybrid-validation',{sequence:1,decision:{coverage:{simulations:2}}});
 const brief={global:{roster:{columns:['gamePlayer','chatPlayer'],rows:[[0,7]]}},evidence:{messages:[{id:'incoming',from:8}]}};
 const call={callId:'sent',task:'conversation',kind:'diplomacy',sequence:1,attempt:0,basis:{tick:11},queuedAt:'2026-10-28T00:00:01Z',prompt:'brief\n简报：'+JSON.stringify(brief),finishedAt:null};
 add('mode-hybrid-state',{handledMessages:[]});
 add('mode-hybrid-model-call',call);
 add('mode-hybrid-task-dispatched',{id:'conversation',sequence:1,attempt:0});
 add('mode-hybrid-model-call',{...call,finishedAt:'2026-10-28T00:00:01Z',status:'completed'});
 add('mode-hybrid-model-call',{...call,callId:'queue-only',sequence:2});
 let tick=13;
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({commanderRoomId:'test-room',tick}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const first=(await reportCycle(directory,server.address().port)).report;
  assert.equal(first.startTick,11); // stale launch/baseline tick 10 must not widen the interval
  assert.equal(first.startAt,call.queuedAt);
  assert.equal(first.ticksAdvanced,2);
  assert.equal(first.seats[0].id,'ai-03');
  assert.equal(first.totals.decisionRounds,1);
  assert.equal(first.totals.fullSearches,1);
  assert.equal(first.totals.validations,1);
  assert.equal(first.totals.simulations,6);
  assert.equal(first.totals.aiRequests,1);
  assert.equal(first.totals.aiNewQueued,2);
  assert.equal(first.triggers.aiRequests[0].reason,'收到新来信');
  add('started',{sequence:2,triggers:[{kind:'battle-notice'}]});
  add('mode-hybrid-model-call',{...call,finishedAt:'2026-10-28T00:00:02Z',status:'completed'});
  tick=15;
  const second=(await reportCycle(directory,server.address().port)).report;
  assert.equal(second.startTick,13);
  assert.equal(second.ticksAdvanced,2);
  assert.equal(second.totals.decisionRounds,1);
  assert.equal(second.totals.searches,0);
  assert.equal(second.totals.aiRequests,0);
  assert.equal(second.totals.aiNewQueued,0);
  assert.equal(second.seats[0].cursor.before,first.seats[0].cursor.head);
 }finally{
  await new Promise(resolve=>server.close(resolve));db.close();
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
  fs.rmSync(directory,{recursive:true,force:true});
 }
});
