import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';import {AiStore,initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {fleetLabel} from '../packages/ai/src/controller/presentation/fleet-labels.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';

const id='p0-'+'a'.repeat(64),other='p1-'+'b'.repeat(64);
function fixture(){
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'historical');
 o.view.tick=100;o.secondsSinceLastTick=0;o.view.fleets=[];
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const state=initialState('historical',0,{model:'',personality:'schemer'}),store=new AiStore(':memory:');
 const past=structuredClone(o);past.view.tick=99;past.view.fleets=[{id,owner:0,state:'moving',drillers:10,gift:false,position:{x:0,y:0},destination:{kind:'outpost',id:o.view.outposts[0]!.id}}];
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No game writes expected');}};
 const c={state,snapshot,gateway,id:'test',spoken:0,now:60000,readObservedFleetIds:(ref:string)=>store.observedFleetIds('historical',0,ref)};
 return {snapshot,state,store,past,gateway,c};
}
const reminder=(entities:string[])=>({id:'arrival-review',atSeconds:61200,note:'核实原舰队结果与目的地实际兵力，未知不计到账。',category:'military',entities});

test('historical lookup accepts only actual observations from this seat and room and updates its cache',()=>{
 const f=fixture();try{
  f.store.save(f.state,'observation-baseline',f.past);
  assert.deepEqual(f.store.observedFleetIds('historical',0,'f1-aaaaaaaa'),[id]);
  const another=structuredClone(f.past);another.view.fleets[0]!.id=other;
  for(const [kind,payload] of [
   ['tool-result',{tool:'forecast',result:another}],['tool-result',{tool:'campaignCompare',result:{observation:another}}],
   ['tool-intent',{tool:'order',result:another}],['notebook-set',{text:JSON.stringify(another)}],
  ] as const)f.store.save(f.state,kind,payload);
  f.store.save({...f.state,lobbySeat:1},'observation-baseline',another);
  f.store.save({...f.state,roomId:'elsewhere'},'observation-baseline',{...another,roomId:'elsewhere'});
  f.store.save(f.state,'wake-state',{observed:{...another,roomId:'elsewhere'}});
  assert.deepEqual(f.store.observedFleetIds('historical',0,fleetLabel(other)),[]);
  f.store.save(f.state,'wake-state',{observed:another});
  assert.deepEqual(f.store.observedFleetIds('historical',0,other),[other]);
 }finally{f.store.close();}
});

test('observations in successful observe, order and batch receipts preserve historical identities',()=>{
 for(const tool of ['observe','order','schedule','cancelSchedule','batch']){
  const f=fixture();try{
   const result=tool==='observe'||tool==='batch'?{observation:f.past}:f.past;
   f.store.save(f.state,'tool-result',{tool,result});
   assert.deepEqual(f.store.observedFleetIds('historical',0,fleetLabel(id)),[id],tool);
  }finally{f.store.close();}
 }
});

test('reminders and finish accept known absent fleet references and retain the result-check task',async()=>{
 const f=fixture();try{
  f.store.save(f.state,'observation-baseline',f.past);
  const r=await executeTool('reminders',{set:[reminder([fleetLabel(id),f.snapshot.observation.view.outposts[0]!.id])]},f.c) as any;
  assert.equal(r.set[0].entities[0],id);
  assert.deepEqual(r.historicalFleetReferences,[{id,status:'not-currently-observed'}]);
  assert.equal(r.set[0].note,reminder([]).note);
  const finished=await executeTool('finish',{reminders:{set:[reminder([id])]}},f.c) as any;
  assert.deepEqual(finished.reminders.set[0].entities,[id]);
  assert.equal(f.snapshot.observation.view.fleets.length,0,'never invent a current fleet');
  await assert.rejects(executeTool('order',{action:{kind:'cancel-launch',fleetId:fleetLabel(id)}},f.c),/不在当前可见/);
  await assert.rejects(executeTool('reminders',{set:[reminder([id,fleetLabel(id)])]},f.c),/Invalid reminder entities/);
  await assert.rejects(executeTool('reminders',{set:[reminder([fleetLabel(other)])]},f.c),/Unknown or ambiguous/);
 }finally{f.store.close();}
});

test('ambiguous historical or current-versus-historical short labels require an exact full ID',async()=>{
 const f=fixture();try{
  f.store.save(f.state,'observation-baseline',f.past);
  const collision='p0-'+'a'.repeat(8)+'c'.repeat(56),newer=structuredClone(f.past);
  newer.view.fleets[0]!.id=collision;
  f.store.save(f.state,'wake-state',{observed:newer});
  await assert.rejects(executeTool('reminders',{set:[reminder([fleetLabel(id)])]},f.c),/Unknown or ambiguous/);
  f.snapshot.observation.view.fleets=structuredClone(newer.view.fleets);
  await assert.rejects(executeTool('reminders',{set:[reminder([fleetLabel(id)])]},f.c),/Unknown or ambiguous/);
  const exact=await executeTool('reminders',{set:[reminder([id])]},f.c) as any;
  assert.deepEqual(exact.set[0].entities,[id]);
 }finally{f.store.close();}
});

test('runner saves a missing-fleet reminder without a finish retry and processes it when due',async()=>{
 const f=fixture();let calls=0;try{
  f.store.save(f.state,'observation-baseline',f.past);f.state.enabled=true;
  const runner=new SeatRunner(f.state,f.store,f.gateway,{step:async request=>{
   calls++;assert.ok(calls<=2,'no reminder rejection or retry');
   if(calls===2){
    assert.ok(request.prompt.includes('arrival-review'));assert.ok(request.prompt.includes(id));assert.ok(request.prompt.includes(reminder([]).note));
    assert.deepEqual(f.snapshot.observation.view.fleets,[],'historical reminders do not invent a current fleet');

   }
   return {tokens:1,reply:{tool:'finish',summary:'追踪实际结果',arguments:{reminders:calls===1?{set:[reminder([fleetLabel(id)])]}:{complete:['arrival-review']}}}};
  }});
  await runner.pollAndFlush(0,true);
  assert.equal(calls,1);assert.deepEqual(f.store.reminders('historical',0)[0]!.entities,[id]);
  assert.equal(f.store.latest('historical',0,'tool-rejected'),null);
  f.snapshot.observation.view.tick=102;
  await runner.pollAndFlush(10000);
  assert.equal(calls,2);assert.deepEqual(f.store.reminders('historical',0),[]);
 }finally{f.store.close();}
});

test('historical references can be resolved after reopening the private store',()=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'subterfuge-historical-reminder-')),path=join(dir,'ai.sqlite');
 let store=new AiStore(path);
 try{
  store.save(f.state,'wake-state',{observed:f.past});assert.deepEqual(store.observedFleetIds('historical',0,fleetLabel(id)),[id]);
  store.close();store=new AiStore(path);
  assert.deepEqual(store.observedFleetIds('historical',0,fleetLabel(id)),[id]);
 }finally{store.close();f.store.close();rmSync(dir,{recursive:true,force:true});}
});
