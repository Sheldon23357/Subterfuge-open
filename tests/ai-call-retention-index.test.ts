import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {CallRetention} from '../packages/ai/src/controller/storage/call-retention.js';

const legacyBoundary=(db:DatabaseSync)=>db.prepare(`SELECT ref FROM (
 SELECT call_ref AS ref FROM diagnostic_calls WHERE room='room' AND seat=0
 UNION SELECT MAX(id) AS ref FROM journal WHERE room='room' AND seat=0 AND kind GLOB 'mode-*-model-call'
 GROUP BY COALESCE(json_extract(payload,'$.callId'),id)) ORDER BY ref DESC LIMIT 1 OFFSET 20`).get();
const fixture=()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE journal(id INTEGER PRIMARY KEY,room TEXT,seat INTEGER,kind TEXT,payload TEXT);
 CREATE TABLE diagnostic_calls(room TEXT,seat INTEGER,call_ref INTEGER,payload TEXT,PRIMARY KEY(room,seat,call_ref));`);
 const put=(id:number,callId:string)=>db.prepare('INSERT INTO journal VALUES(?,?,0,?,?)').run(id,'room','mode-hybrid-model-call',JSON.stringify({callId,prompt:'BODY-'+id,output:{summary:'summary-'+id}}));
 return {db,put};
};

test('retention indexes preserve the twenty-call boundary across versions, captures, updates and deletes',()=>{
 const {db,put}=fixture();
 try{
  // Installation indexes existing evidence without rewriting its payloads.
  for(let id=1;id<=70;id++)put(id,'call-'+Math.floor(id/2));
  for(const ref of [5,20,70,90])db.prepare('INSERT INTO diagnostic_calls VALUES(?,0,?,?)').run('room',ref,JSON.stringify({promptText:'CAPTURE-'+ref,reply:{summary:'capture'}}));
  const retention=new CallRetention(db);
  const check=()=>{
   const expected=legacyBoundary(db),actual=db.prepare("SELECT DISTINCT ref FROM diagnostic_call_heads WHERE room='room' AND seat=0 ORDER BY ref DESC LIMIT 1 OFFSET 20").get();
   assert.equal(actual?.ref,expected?.ref);
  };
  check();put(71,'call-1');check();
  for(const [id,identity] of [[72,'1'],[73,'1.0'],[74,'"1"']] as const){
   db.prepare('INSERT INTO journal VALUES(?,?,0,?,?)').run(id,'room','mode-hybrid-model-call',`{"callId":${identity},"prompt":"numeric identity"}`);check();
  }
  db.prepare('DELETE FROM journal WHERE id=71').run();check();
  db.prepare("UPDATE journal SET payload=? WHERE id=70").run(JSON.stringify({callId:'renamed',prompt:'UPDATED'}));check();
  const cutoff=Number(legacyBoundary(db)!.ref);retention.trim('room',0);
  for(const row of db.prepare('SELECT id,payload FROM journal').all())assert.equal(JSON.parse(String(row.payload)).bodyRetention==='summary-only',Number(row.id)<=cutoff);
  for(const row of db.prepare('SELECT call_ref,payload FROM diagnostic_calls').all())assert.equal(JSON.parse(String(row.payload)).bodyRetention==='summary-only',Number(row.call_ref)<=cutoff);
  assert.equal(Number(db.prepare('SELECT count(*) n FROM diagnostic_call_index WHERE body=1 AND ref<=?').get(cutoff)!.n),0);
  db.prepare("DELETE FROM diagnostic_calls WHERE call_ref=90").run();check();
 }finally{db.close();}
});

test('steady retention reads only current heads and newly expired bodies; rollback restores both indexes and payloads',t=>{
 const {db,put}=fixture();
 try{
  const retention=new CallRetention(db);for(let id=1;id<=1500;id++)put(id,'call-'+id);
  retention.trim('room',0);
  const prepare=db.prepare.bind(db),queries:string[]=[];
  t.mock.method(db,'prepare',(sql:string)=>{queries.push(sql);return prepare(sql);});
  new CallRetention(db);retention.trim('room',0);
  assert.ok(!queries.some(sql=>sql.includes('FROM journal')),'restart and a settled window never scan journal payloads');
  queries.length=0;put(1501,'new-call');retention.trim('room',0);
  assert.equal(queries.filter(sql=>sql.startsWith('SELECT payload FROM journal')).length,1);
  const before=db.prepare('SELECT payload FROM journal WHERE id=1482').get()!.payload;
  db.exec('BEGIN');put(1502,'rolled-back');retention.trim('room',0);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT payload FROM journal WHERE id=1482').get()!.payload,before);
  assert.equal(db.prepare('SELECT 1 FROM diagnostic_call_heads WHERE ref=1502').get(),undefined);
  assert.equal(db.prepare('SELECT body FROM diagnostic_call_index WHERE ref=1482').get()!.body,1);
 }finally{db.close();}
});
