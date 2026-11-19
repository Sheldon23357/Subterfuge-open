import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AiStore,initialState,type AiSnapshot} from '../packages/ai/src/index.js';
import {prepareFinish} from '../packages/ai/src/controller/storage/private-state-preparation.js';
import {memoryConsistency} from '../packages/ai/src/controller/storage/memory-consistency.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';

function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'room');
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,notebook:[],reminders:[]};
 const state=initialState('room',0,{model:'',personality:'schemer'}),store=new AiStore(':memory:');
 const context=()=>({state,snapshot,gateway:{snapshot:async()=>snapshot,request:async()=>{throw Error('No game writes');}},id:'preview',now:o.view.tick*600+o.secondsSinceLastTick,spoken:0,strategicContextAvailable:true,readMemoryReviews:()=>store.memoryReviews('room',0)});
 const refresh=()=>snapshot.memoryConsistency=memoryConsistency(state.memory,snapshot);
 const final=(ids:string[])=>({basisRevision:o.revision,items:ids.map(id=>({id,reason:'Checked exact final content and linked dependencies'}))});
 refresh();return {state,snapshot,store,context,refresh,final};
}
const note=(id:string,text='Final fact')=>({id,kind:'fact' as const,text,expiresWorldDay:null});

test('finish aggregates independent domain errors and leaves all state untouched',async()=>{
 const f=fixture();try{
  const before=JSON.stringify({state:f.state,snapshot:f.snapshot});
  await assert.rejects(prepareFinish({memory:{unknown:'bad'},notebook:{set:[{id:'invalid'}]},reminders:{set:[{id:'invalid'}]}},f.context()),(error:unknown)=>{
   const detail=JSON.parse((error as Error).message);
   assert.equal(detail.code,'FINISH_PREFLIGHT_INVALID');
   assert.deepEqual(detail.issues.map((i:{path:string})=>i.path),['$.notebook','$.reminders','$.memory']);return true;
  });
  assert.equal(JSON.stringify({state:f.state,snapshot:f.snapshot}),before);
  assert.equal(f.store.notebook('room',0,0).length,0);
 }finally{f.store.close();}
});

test('finish accepts changed bodies without obsolete fingerprints and never fabricates review receipts',async()=>{
 const f=fixture();try{
  f.snapshot.notebook=[{id:'old',kind:'fact',text:'Final fact',updatedAt:0,expiresAt:null}];f.refresh();
  const result=await prepareFinish({notebook:{set:[note('new'),note('old','Revised body')]},memory:{strategy:'守矿并保留增援'}},f.context());
  assert.deepEqual(result.notebook.set.map(n=>n.id),['new','old']);
  assert.equal(result.memory.strategy,'守矿并保留增援');
  assert.equal('memoryReview' in result,false);assert.equal('preview' in result,false);
  assert.equal(f.store.memoryReviews('room',0).length,0);
  assert.equal(f.snapshot.notebook[0]!.text,'Final fact');
 }finally{f.store.close();}
});

test('finish enforces due reminders but permits atomic complete-and-replace',async()=>{
 const f=fixture();try{
  f.snapshot.reminders=[{id:'due',atSeconds:0,note:'重新评估'}];
  await assert.rejects(prepareFinish({},f.context()),/Unresolved due reminders/);
  const result=await prepareFinish({notebook:{set:[note('decision')]},reminders:{complete:['due'],set:[{id:'later',atWorldDay:f.snapshot.observation.view.tick+2,note:'重新比较'}]}},f.context());
  assert.deepEqual(result.reminders.complete,['due']);assert.equal(result.reminders.set[0]!.atSeconds,(f.snapshot.observation.view.tick+2)*600);
  assert.equal(f.snapshot.reminders[0]!.id,'due');
 }finally{f.store.close();}
});

test('finish rejects removed preview, review, campaign and legacy memory protocols',async()=>{
 const f=fixture();try{
  for(const input of [{preview:true},{previewRef:'x'},{reviewed:[]},{reviewFinal:{}},{strategicReview:{}},{campaigns:{}},{memoryEdits:[]},{memory:{relations:'old'}}])await assert.rejects(prepareFinish(input,f.context()));
 }finally{f.store.close();}
});
