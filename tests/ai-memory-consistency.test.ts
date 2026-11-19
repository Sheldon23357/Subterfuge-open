import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {AiStore,initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {memoryConsistency,validateReviewed} from '../packages/ai/src/controller/storage/memory-consistency.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'room');
 o.view.fleets=[{id:'p0-'+ 'a'.repeat(64),owner:0,state:'moving',position:{x:0,y:0},destination:null,drillers:24,gift:false}];
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,notebook:[{id:'old',kind:'plan',text:'F1-AAAAAAAA仍待发，旧预测可获胜。',updatedAt:54000,expiresAt:null}],reminders:[]};
 const state=initialState('room',0,{model:'',personality:'schemer'}),store=new AiStore(':memory:');
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No game writes');}};
 return {snapshot,state,store,gateway};
}
test('old pending prose cannot overwrite projected moving facts; predictions remain authored history',()=>{
 const f=fixture();try{const c=memoryConsistency(f.state.memory,f.snapshot);assert.equal(c.facts['F1-AAAAAAAA']!.state,'moving');assert.match(c.authority,/历史/);assert.match(f.snapshot.notebook![0]!.text,/待发/);assert.equal(c.items[0]!.reviewNeeded,true);}finally{f.store.close();}
});
test('changed facts invalidate all related receipts; invisible fleets are unknown, never arrived or dead',()=>{
 const f=fixture();try{
 const before=memoryConsistency(f.state.memory,f.snapshot),receipts=before.items.map(i=>({...i,seconds:60000,reason:'reviewed'}));
 assert.equal(memoryConsistency(f.state.memory,f.snapshot,receipts).items[0]!.reviewNeeded,false);
 f.snapshot.observation.view.fleets=[];
 const after=memoryConsistency(f.state.memory,f.snapshot,receipts);
 assert.equal(after.facts['F1-AAAAAAAA']!.status,'not-currently-observed');assert.equal(after.items[0]!.reviewNeeded,true);
 assert.throws(()=>validateReviewed(receipts.map(({id,fingerprint,reason})=>({id,fingerprint,reason})),after),/Stale/);
 }finally{f.store.close();}
});
test('unknown enemy garrisons are never filled from remembered prose',()=>{
 const f=fixture();try{const p=f.snapshot.observation.view.outposts.find(p=>p.owner===1)!;delete p.drillers;
 f.snapshot.notebook![0]!.text=p.id+'旧记录有50兵';const c=memoryConsistency(f.state.memory,f.snapshot);
 assert.equal(c.facts[p.id]!.drillers,undefined);assert.ok(!JSON.stringify(c.facts[p.id]).includes('50'));
 }finally{f.store.close();}
});
test('dependency changes invalidate linked records even when they mention no fleet directly',()=>{
 const f=fixture();try{
 f.snapshot.notebook!.push({id:'dependent',kind:'plan',text:'按前序方案执行',updatedAt:60000,expiresAt:null,record:{type:'plan',status:'active',summary:'等待前序',entities:[],players:[],evidence:['note:old'],links:['old'],reviewAt:null}});
 const c=memoryConsistency(f.state.memory,f.snapshot),receipts=c.items.map(i=>({...i,seconds:60000,reason:'reviewed'}));
 f.snapshot.observation.view.fleets[0]!.state='waiting';
 assert.equal(memoryConsistency(f.state.memory,f.snapshot,receipts).items.find(i=>i.id==='note:dependent')!.reviewNeeded,true);
 }finally{f.store.close();}
});
test('normal rounds receive active note prose without a periodic full-memory-review protocol',async()=>{
 const f=fixture();try{
  const text='旧出航描述只保留为历史；当前舰队状态以地图为准。';
  f.store.save(f.state,'notebook-set',{id:'old',kind:'plan',priority:'high',text,updatedAt:59000,expiresAt:null});let prompt='';
  await new SeatRunner(f.state,f.store,f.gateway,{step:async r=>{prompt=r.prompt;return {tokens:1,reply:{tool:'finish',summary:'review',arguments:{}}};}}).poll(0,true);
  assert.ok(prompt.includes(text));assert.ok(!prompt.includes('"notebookReview":true'));assert.equal(f.store.latest('room',0,'full-memory-review'),null);assert.equal(f.store.memoryReviews('room',0).length,0);
 }finally{f.store.close();}
});

test('invalid review receipt rolls back all finish mutations',async()=>{
 const f=fixture();try{
 f.snapshot.memoryConsistency=memoryConsistency(f.state.memory,f.snapshot);
 await assert.rejects(executeTool('finish',{memory:{strategy:'must not save'},reviewed:[{id:'note:old',fingerprint:'invented',reason:'reviewed'}]},{state:f.state,snapshot:f.snapshot,gateway:f.gateway,id:'test',now:60000,spoken:0}),/INVALID_TOOL_FIELDS/);
 assert.equal(f.state.memory.strategy,'');assert.equal(f.store.memoryReviews('room',0).length,0);
 }finally{f.store.close();}
});
test('confirmed elimination atomically archives notes, cancels reminders and open campaigns, idempotently',()=>{
 const f=fixture();try{
 f.store.save(f.state,'notebook-set',f.snapshot.notebook![0]);f.store.save(f.state,'reminder-set',{id:'old',atSeconds:1,note:'old'});
 f.store.save(f.state,'campaign-state',{plans:[{id:'war',stage:'underway',allocations:[{source:'home',drillers:10}]}]});
 assert.throws(()=>f.store.endSeat(f.state,f.snapshot.observation),/not confirmed/);
 f.snapshot.observation.view.self.active=false;f.store.endSeat(f.state,f.snapshot.observation);
 assert.equal(f.state.status,'ended');assert.equal(f.state.enabled,false);assert.deepEqual(f.store.notebook('room',0,60000),[]);assert.deepEqual(f.store.reminders('room',0),[]);
 assert.equal(f.store.latest<any>('room',0,'campaign-state').plans[0].stage,'cancelled');assert.ok(f.store.queryNotebook('room',0,60000,{archive:true}).entries.length);
 const before=f.store.historyPage('room',0).entries[0]!.id;f.store.endSeat(f.state,f.snapshot.observation);assert.equal(f.store.historyPage('room',0).entries[0]!.id,before);
 }finally{f.store.close();}
});
