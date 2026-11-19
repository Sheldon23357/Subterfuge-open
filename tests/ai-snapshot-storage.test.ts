import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AiStore,initialState} from '../packages/ai/src/index.js';

test('large changing diagnostic snapshots retain one current value, compact audit and restart recovery',()=>{
 const dir=mkdtempSync(join(tmpdir(),'snapshot-storage-')),file=join(dir,'ai.sqlite');
 let store=new AiStore(file);const state=initialState('room',0,{model:'',personality:'sentinel'});
 const a={sequence:1,tasks:[{id:'one',text:'fact'.repeat(5000)}]},b={...a,sequence:2};
 try{
  for(let i=0;i<100;i++)store.save(state,'mode-hybrid-state',{...a,sequence:i});
  store.save(state,'mode-hybrid-state',b);
  const audit=store.historyPage('room',0).entries;
  assert.ok(audit.every(r=>r.kind==='mode-hybrid-state'&&(r.payload as any).bodyRetained===false));
  assert.ok(!JSON.stringify(audit).includes('factfact'));
  assert.deepEqual(store.latest('room',0,'mode-hybrid-state'),b);
  store.close();store=new AiStore(file);
  assert.deepEqual(store.latest('room',0,'mode-hybrid-state'),b);
  const db=new DatabaseSync(file,{readOnly:true});try{
   const bytes=Number(db.prepare('SELECT sum(length(payload)) AS bytes FROM journal').get()!.bytes);
   assert.ok(bytes<JSON.stringify(a).length*2,'changing snapshots do not accumulate full bodies');
   assert.equal(db.prepare("SELECT count(*) AS n FROM runtime_state WHERE kind='mode-hybrid-state'").get()!.n,1);
  }finally{db.close();}
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('current projections remain scoped and transactional while business receipts stay complete',()=>{
 const store=new AiStore(':memory:'),state=initialState('room',0,{model:'',personality:'sentinel'}),data={sequence:1,value:'unchanged'};
 try{
  store.save(state,'mode-hybrid-state',data);
  assert.throws(()=>store.saveEvents(state,[{kind:'mode-hybrid-state',details:data}],undefined,'wrong-basis'),/LOCAL_BASIS_CHANGED/);
  assert.throws(()=>store.saveEvents(state,[{kind:'mode-hybrid-state',details:data},{kind:'wake-observation',details:{}}]),/Invalid durable wake observation/);
  assert.equal(store.history('room',0).length,1);
  store.save({...state,lobbySeat:1},'mode-hybrid-state',data);
  store.save({...state,roomId:'other'},'mode-hybrid-state',data);
  assert.equal(store.debugRows('room',1,{kinds:['snapshot-repeated']}).entries.length,0);
  for(const kind of ['tool-result','mode-hybrid-model-call']){
   store.save(state,kind,data);store.save(state,kind,data);
   assert.equal(store.debugRows('room',0,{kinds:[kind]}).entries.length,2);
  }
  const basis=store.localWriteBasis('room',0);
  store.save(state,'mode-hybrid-state',data);
  assert.equal(store.localWriteBasis('room',0),basis,'audit repeats do not change authority');
 }finally{store.close();}
});
