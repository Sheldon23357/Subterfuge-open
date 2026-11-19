
import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiStore,initialState,type AiSnapshot,type NotebookEntry} from '../packages/ai/src/index.js';
import {memoryConsistency,finalizeMemoryReview} from '../packages/ai/src/controller/storage/memory-consistency.js';
import {notebookContext} from '../packages/ai/src/controller/storage/memory-records.js';
import {notebookAfterChanges,notebookDependencies} from '../packages/ai/src/controller/storage/notebook-dependencies.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const snapshot:AiSnapshot={observation:observation({state:createFleetScenario(cfg),scheduled:[]},0,'room'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,notebook:[],reminders:[]};
 return {snapshot,state:initialState('room',0,{model:'',personality:'schemer'})};
}
function note(id:string,links:string[]=[],entities=['remote']):NotebookEntry{return {id,kind:'plan',text:'历史事实、当前约束及条件计划。'.repeat(60),updatedAt:60000,expiresAt:null,record:{type:'plan',status:'active',summary:id+'的约束与下一步',players:[1],entities,links,evidence:['observation:fixture@100'],reviewAt:90000}};}
const receipt=(i:{id:string;fingerprint:string},seconds:number)=>({...i,seconds,reason:'checked'});
test('cumulative coverage expires at oldest receipt, rejects future receipts and final edits invalidate coverage',()=>{
 const {snapshot,state}=fixture();snapshot.notebook=[note('A'),note('B')];
 const c=memoryConsistency(state.memory,snapshot),r=c.items.map((i,k)=>receipt(i,60000-k*100));
 const covered=memoryConsistency(state.memory,snapshot,r);assert.equal(covered.factsCoverage.complete,true);assert.equal(covered.factsCoverage.validUntil,81500);
 assert.equal(memoryConsistency(state.memory,snapshot,[receipt(c.items[0]!,60001),r[1]!]).factsCoverage.complete,false);
 snapshot.observation.view.tick=135;snapshot.observation.secondsSinceLastTick=500;
 assert.equal(memoryConsistency(state.memory,snapshot,r).items.find(i=>i.id==='note:B')!.reviewNeeded,true);
 snapshot.observation.view.tick=100;snapshot.observation.secondsSinceLastTick=0;
 assert.throws(()=>finalizeMemoryReview(snapshot,state.memory,{set:[{...note('A'),text:'changed'}],remove:[]},[],r,true,{reason:'reviewed'}),/complete current factual/);
 assert.throws(()=>finalizeMemoryReview(snapshot,state.memory,{set:[],remove:[]},[],r,false,{reason:'reviewed'}),/actual full/);
 const result=finalizeMemoryReview(snapshot,state.memory,{set:[],remove:[]},[],r,true,{reason:'全局目标仍适用'});assert.equal(result.strategicReview,true);assert.equal(result.receipts.length,0);assert.equal(result.coverage.validUntil,81500);
});
test('empty facts do not auto-complete strategy; explicit full review does, new records need receipts',()=>{
 const {snapshot,state}=fixture();
 assert.equal(finalizeMemoryReview(snapshot,state.memory,{set:[],remove:[]},[],[],true,undefined).strategicReview,false);
 assert.equal(finalizeMemoryReview(snapshot,state.memory,{set:[],remove:[]},[],[],true,{reason:'没有未结战略事项'}).strategicReview,true);
 assert.throws(()=>finalizeMemoryReview(snapshot,state.memory,{set:[note('new')],remove:[]},[],[],true,{reason:'checked'}),/complete current factual/);
});
test('private removed and closed dependencies give terminal summaries, not resurrected bodies, across SQLite restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'notebook-lifecycle-'));const {snapshot,state}=fixture();let store=new AiStore(join(dir,'db.sqlite'));
 try{
  store.save(state,'notebook-set',note('past'));store.save(state,'notebook-removed',{id:'past'});
  store.save({...state,lobbySeat:1},'notebook-set',note('secret'));store.save({...state,lobbySeat:1},'notebook-removed',{id:'secret'});
  store.save({...state,roomId:'other'},'notebook-set',note('other'));store.save({...state,roomId:'other'},'notebook-removed',{id:'other'});
  store.close();store=new AiStore(join(dir,'db.sqlite'));
  snapshot.notebook=[note('linked',['note:past'],['front']),note('unrelated')];snapshot.task={category:'military',scope:'local',weight:'medium',reasons:[],entities:['front'],deferred:[]};snapshot.notebookDependencies=store.notebookDependencyHistory('room',0,60000);
  assert.deepEqual(snapshot.notebookDependencies.map(n=>n.id),['note:past']);assert.equal(notebookDependencies(snapshot).resolve('past')!.summary!.status,'removed');
  const selected=notebookContext(snapshot);assert.deepEqual(selected.notebook.map(n=>n.id),['linked']);assert.equal(selected.notebookDependencySummaries![0]!.status,'removed');
  const old=memoryConsistency(state.memory,snapshot).items.find(i=>i.id==='note:linked')!.fingerprint;
  store.save(state,'notebook-set',{...note('past'),record:{...note('past').record!,status:'completed'}});snapshot.notebookDependencies=store.notebookDependencyHistory('room',0,60000);
  assert.notEqual(memoryConsistency(state.memory,snapshot).items.find(i=>i.id==='note:linked')!.fingerprint,old);
  const beforeRemoval=memoryConsistency(state.memory,snapshot);const final=notebookAfterChanges(snapshot,[],['past']);store.save(state,'notebook-removed',{id:'past'});
  const persisted={...snapshot,notebookDependencies:store.notebookDependencyHistory('room',0,60000)};
  assert.deepEqual(final.notebookDependencies,persisted.notebookDependencies);
  assert.notEqual(memoryConsistency(state.memory,final).items.find(i=>i.id==='note:linked')!.fingerprint,beforeRemoval.items.find(i=>i.id==='note:linked')!.fingerprint);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('typed, bare, ambiguous, cyclic and unknown references share one resolver',()=>{
 const {snapshot,state}=fixture();snapshot.task={category:'military',scope:'local',weight:'medium',reasons:[],entities:['front'],deferred:[]};
 snapshot.notebook=[note('A',['note:B'],['front']),note('B',['A']),note('alternative')];
 assert.deepEqual(notebookContext(snapshot).notebook.map(n=>n.id),['A','B']);assert.doesNotThrow(()=>memoryConsistency(state.memory,snapshot));
 const fp=memoryConsistency(state.memory,snapshot).items.find(i=>i.id==='note:A')!.fingerprint;snapshot.notebook[0]!.record!.links=['B'];
 // Authored link syntax itself is part of the record fingerprint, but targets agree.
 assert.equal(notebookDependencies(snapshot).resolve('B')?.id,notebookDependencies(snapshot).resolve('note:B')?.id);assert.ok(fp);
 snapshot.campaigns=[{id:'B',stage:'completed',objective:'结束的战役',reviewAtTick:100} as any];
 assert.equal(notebookDependencies(snapshot).resolve('B'),undefined);assert.equal(notebookContext(snapshot).notebookSelection?.mode,'related');assert.ok(notebookContext(snapshot).unresolvedRecordDependencies?.some(d=>d.record==='A'&&d.status==='unknown'&&d.read.includes('notebook')));assert.equal(notebookContext(snapshot).notebook.find(n=>n.id==='A')?.text,snapshot.notebook[0]!.text);assert.match(notebookContext(snapshot).notebookSelection?.read??'',/observe.*full/);assert.ok(!notebookContext(snapshot).notebook.some(n=>n.id==='alternative'));
 snapshot.notebook[0]!.record!.links=['campaign:B'];assert.equal(notebookContext(snapshot).notebookDependencySummaries![0]!.status,'completed');
 snapshot.notebook[0]!.record!.links=['missing'];assert.equal(notebookContext(snapshot).notebookSelection?.mode,'related');assert.ok(notebookContext(snapshot).unresolvedRecordDependencies?.some(d=>d.record==='A'&&d.status==='unknown'&&d.read.includes('notebook')));assert.equal(notebookContext(snapshot).notebook.find(n=>n.id==='A')?.text,snapshot.notebook[0]!.text);assert.match(notebookContext(snapshot).notebookSelection?.read??'',/observe.*full/);assert.ok(!notebookContext(snapshot).notebook.some(n=>n.id==='alternative'));
});
test('the real runner preserves notes and strategy across rounds and SQLite restart without reviving old query archives',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-runner-')),db=join(dir,'db.sqlite');let {snapshot,state}=fixture(),store=new AiStore(db);const prompts:string[]=[];
 try{
  store.save(state,'notebook-set',{id:'A',kind:'fact',priority:'high',text:'静态记录 A',updatedAt:60000,expiresAt:null});
  store.save(state,'tool-result',{id:'archived-query',tool:'forecast',result:{privateOldBody:'DO_NOT_RESTORE_OLD_QUERY'}});
  const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No game writes');}};
  const provider={step:async(req:{prompt:string})=>{prompts.push(req.prompt);return {tokens:1,reply:{tool:'finish',summary:'保存判断',arguments:{memory:{strategy:'按当前地图继续判断'}}}};}};
  let runner=new SeatRunner(state,store,gateway,provider);await runner.poll(0,true);
  store.close();store=new AiStore(db);state=store.load('room',0)!;runner=new SeatRunner(state,store,gateway,provider);
  snapshot.observation.view.tick=101;await runner.poll(1000,true);
  assert.equal(prompts.length,2);assert.ok(prompts[1]!.includes('静态记录 A'));assert.ok(prompts[1]!.includes('按当前地图继续判断'));
  assert.ok(prompts.every(p=>!p.includes('DO_NOT_RESTORE_OLD_QUERY')&&!p.includes('"notebookReview":true')));
  assert.equal(store.latest('room',0,'full-memory-review'),null);assert.equal(store.memoryReviews('room',0).length,0);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
