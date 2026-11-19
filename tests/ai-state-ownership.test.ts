import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiStore,initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {executeToolResult} from '../packages/ai/src/controller/execution/tool-results.js';
import {planLocalCommit} from '../packages/ai/src/controller/execution/local-commit-plan.js';
import type {ToolContext} from '../packages/ai/src/controller/execution/tools.js';

function fixture(){
 const room={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]};
 const o=observation(room,0,'owner');o.view.tick=1;o.secondsSinceLastTick=0;
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:4,notebook:[],reminders:[{id:'campaign:plan',atSeconds:600,note:'复查计划',category:'military'}]};
 const state=initialState('owner',0,{model:'',personality:'mediator'});state.commanderDirectives={version:1,text:'player-confirmed'};
 const c:ToolContext={state,snapshot,gateway:{snapshot:async()=>snapshot,request:async()=>{throw Error('No remote request permitted');}},id:'owner-test',spoken:0,now:600};
 return {c,state,snapshot};
}

for(const tool of ['reminders','finish'])test(`${tool} can cancel or reschedule any reminder ID without a retired campaign owner`,async()=>{
 const {c,snapshot}=fixture(),before=structuredClone(snapshot);
 for(const updates of [{cancel:['campaign:plan']},{set:[{id:'campaign:plan',atWorldDay:2,note:'下一天复查'}]}]){
  const execution=await executeToolResult(tool,tool==='finish'?{reminders:updates}:updates,c);
  const planned=planLocalCommit(execution,c.state.memory,snapshot);
  assert.equal(planned.events.length,1);
  assert.equal(planned.events[0]!.kind,'cancel' in updates?'reminder-cancelled':'reminder-set');
  if('set' in updates){const event=planned.events[0]!;assert.equal(event.kind,'reminder-set');if(event.kind==='reminder-set')assert.equal(event.details.atSeconds,1200);}
  assert.deepEqual(snapshot,before,'preparation must not mutate the live state');
  assert.ok(!planned.events.some(e=>e.kind==='campaign-state'));
 }
});

test('due reminder completion persists through restart without automatic renewal or authority changes',async()=>{
 const {c,state}=fixture(),dir=mkdtempSync(join(tmpdir(),'owner-')),path=join(dir,'private.sqlite');let store=new AiStore(path);
 try{
  store.saveEvents(state,[{kind:'reminder-set',details:c.snapshot.reminders![0]}]);
  const execution=await executeToolResult('reminders',{complete:['campaign:plan']},c);
  const plan=planLocalCommit(execution,state.memory,c.snapshot);
  store.saveLocalEvents(state,c.id,[...plan.events,{kind:'tool-result',details:{id:c.id,tool:'reminders',result:execution.result}}],store.localWriteBasis('owner',0));
  store.close();store=new AiStore(path);
  assert.deepEqual(store.reminders('owner',0),[]);
  assert.equal(store.latest('owner',0,'campaign-state'),null);
  assert.equal(store.load('owner',0)!.commanderDirectives!.text,'player-confirmed');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('finish requires every due reminder to be explicitly handled and keeps rescheduled time in storage',async()=>{
 const {c,state}=fixture(),store=new AiStore(':memory:');
 try{
  await assert.rejects(executeTool('finish',{},c),/Unresolved due reminders/);
  store.saveEvents(state,[{kind:'reminder-set',details:c.snapshot.reminders![0]}]);
  const execution=await executeToolResult('finish',{reminders:{set:[{id:'campaign:plan',atWorldDay:2,note:'延后复查'}]}},c);
  const plan=planLocalCommit(execution,state.memory,c.snapshot);
  store.saveLocalEvents(state,c.id,[...plan.events,{kind:'tool-result',details:{id:c.id,tool:'finish',result:execution.result}}],store.localWriteBasis('owner',0));
  assert.deepEqual(store.reminders('owner',0).map(r=>[r.id,r.atSeconds,r.note]),[['campaign:plan',1200,'延后复查']]);
  assert.equal(c.snapshot.reminders![0]!.atSeconds,600);
 }finally{store.close();}
});

test('current memory tools cannot overwrite confirmed commander authority',async()=>{
 const {c,state}=fixture();
 for(const tool of ['notebook','finish']){
  await assert.rejects(executeTool(tool,{memory:{strategy:'新战略',commanderDirectives:'override'}},c));
  await assert.rejects(executeTool(tool,{commanderDirectives:{version:2,text:'override'}},c));
 }
 assert.deepEqual(state.commanderDirectives,{version:1,text:'player-confirmed'});
});

test('retired campaign and remember tools cannot prepare or persist local writes',async()=>{
 const {c,state,snapshot}=fixture(),before=structuredClone({state,snapshot});
 for(const [tool,args] of [['campaigns',{close:[{id:'plan',status:'cancelled'}]}],['remember',{strategy:'override'}]] as const)
  await assert.rejects(executeToolResult(tool,args,c),new RegExp('Tool not available: '+tool));
 assert.deepEqual({state,snapshot},before);
});
