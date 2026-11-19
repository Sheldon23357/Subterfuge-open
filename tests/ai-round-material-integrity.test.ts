import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';import {AiStore,initialState,type AiSnapshot,type DecisionTask} from '../packages/ai/src/index.js';
import {ContextBudgetError} from '../packages/ai/src/controller/contracts/context-budget.js';
import {createRoundWorkset,appendRoundReceipt,restoreRoundWorkset} from '../packages/ai/src/controller/execution/round-workset.js';

const task:DecisionTask={category:'plan',weight:'medium',reasons:['比较联合行动与等待'],entities:[],deferred:[]};
function fixture(){
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'round-materials');
 o.outpostNames=Object.fromEntries(o.view.outposts.map((p,i)=>[p.id,`REEF-${i}`]));
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,task,notebook:[],reminders:[]};
 return {snapshot,state:initialState(o.roomId,0,{model:'',personality:'sentinel'})};
}

test('archived campaign intent is neither restored into observation decisions nor a CAS gate for current notes',async()=>{
 const f=fixture(),store=new AiStore(':memory:');
 const campaign={id:'archived-plan',target:f.snapshot.observation.view.outposts[1]!.id,objective:'ARCHIVED-PLAN-BODY',holdPlan:'Old choice',cancelWhen:'Old condition',stage:'assembling',createdTick:0,reviewAtTick:110,allocations:[{source:f.snapshot.observation.view.outposts[0]!.id,drillers:100}],accountedFleets:[],issues:[],comparison:{resultRef:'archived-forecast',planId:'old-candidate'}};
 try{
  store.save(f.state,'campaign-state',{plans:[campaign]});
  store.comparisonEvidence=()=>{throw Error('Archived comparisons must not be restored into current cognition');};
  let calls=0;
  await new SeatRunner(f.state,store,{snapshot:async()=>structuredClone(f.snapshot),request:async()=>{throw Error('No game writes');}},{step:async request=>{
   assert.equal(++calls,1);assert.ok(!request.prompt.includes('ARCHIVED-PLAN-BODY'));
   store.save(f.state,'campaign-state',{plans:[{...campaign,objective:'Archival annotation changed'}]});
   return {tokens:0,reply:{tool:'finish',arguments:{notebook:{set:[{id:'current-plan',kind:'plan',text:'Current plan from authorized facts',expiresWorldDay:null}]}},summary:'Current round complete'}};
  }}).poll(0,true);
  assert.equal(f.state.status,'waiting');assert.equal(store.notebook(f.state.roomId,0,60000)[0]!.id,'current-plan');
  assert.equal(store.pendingCommanderCleanup(f.state.roomId,0),null);
 }finally{store.close();}
});

test('a guessed historical query reference cannot authorize commander cleanup or restore its body',async()=>{
 const f=fixture(),store=new AiStore(':memory:');
 f.state.commanderDirectives={version:1,text:'核实REEF-1。'};
 try{
  store.save(f.state,'query-result',{id:'archived-read',tool:'forecast',arguments:{targetTick:101},result:{status:'conditional',body:'ARCHIVED-QUERY-BODY'}});
  const read=store.queryResult.bind(store);
  store.queryResult=(room,seat,id,detail)=>{if(id==='archived-read')throw Error('No historical model query reads are allowed');return read(room,seat,id,detail);};
  let calls=0;const prompts:string[]=[];
  await new SeatRunner(f.state,store,{snapshot:async()=>structuredClone(f.snapshot),request:async()=>{throw Error('No game writes');}},{step:async request=>{
   prompts.push(request.prompt);assert.ok(++calls<=2);
   return {tokens:0,reply:{tool:'finish',arguments:calls===1?{commanderCleanup:{version:1,basisRevision:f.snapshot.observation.revision,completed:[{quote:'核实REEF-1。',reason:'Attempt to cite an unprovided archive',evidence:['result:archived-read']}]}}:{},summary:'Finish'}};
  }}).poll(0,true);
  assert.equal(calls,2);assert.equal(f.state.status,'waiting');assert.equal(store.pendingCommanderCleanup(f.state.roomId,0),null);
  assert.equal(store.load(f.state.roomId,0)!.commanderDirectives!.text,'核实REEF-1。');
  assert.match(JSON.stringify(store.latest(f.state.roomId,0,'tool-rejected')),/Unknown commander cleanup evidence/);
  assert.ok(prompts.every(prompt=>!prompt.includes('ARCHIVED-QUERY-BODY')));
 }finally{store.close();}
});
