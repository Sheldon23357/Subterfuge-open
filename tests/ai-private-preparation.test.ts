import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initialState,type AiSnapshot,type AiReminder} from '../packages/ai/src/index.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {prepareFinish,prepareReminders} from '../packages/ai/src/controller/storage/private-state-preparation.js';
import {planLocalCommit} from '../packages/ai/src/controller/execution/local-commit-plan.js';
import {fleetLabel} from '../packages/ai/src/controller/presentation/fleet-labels.js';
import type {ToolContext} from '../packages/ai/src/controller/execution/tools.js';
function fixture(){
 const room={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]};
 const snapshot:AiSnapshot={observation:observation(room,0,'preparation'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:4,notebook:[],reminders:[]};
 const state=initialState('preparation',0,{model:'',personality:'mediator'});
 const c:ToolContext={state,snapshot,gateway:{snapshot:async()=>snapshot,request:async()=>{throw Error('No remote call permitted');}},id:'prepare',spoken:0,now:0};
 return {c,state,snapshot};
}
test('finish reuses notebook candidate and aggregates independent complete-domain failures',async()=>{
 const {c}=fixture();let reads=0;c.readNotebookEntry=()=>{reads++;return undefined;};
 const result=await prepareFinish({notebook:{set:[{id:'note',kind:'note',text:'synthetic note'}]}},c);
 assert.equal(result.notebook.set[0]!.text,'synthetic note');assert.equal(reads,0);
 await assert.rejects(prepareFinish({notebook:{set:[{id:'bad',kind:'invalid',text:'x'}]},reminders:{set:[{id:'bad',atSeconds:1,note:'x'}]},memory:{strategy:42}},c),(error:unknown)=>{
  const detail=JSON.parse((error as Error).message);assert.equal(detail.code,'FINISH_PREFLIGHT_INVALID');assert.deepEqual(detail.issues.map((i:{path:string})=>i.path),['$.notebook','$.reminders','$.memory']);return true;
 });
 assert.deepEqual(c.snapshot.notebook,[]);assert.deepEqual(c.snapshot.reminders,[]);
});
test('reminder candidate preserves submitted short references and permits full-capacity replacement',()=>{
 const {c}=fixture();const fleet='p0-'+ 'abcdef12'.repeat(8);
 c.readObservedFleetIds=ref=>ref===fleetLabel(fleet)?[fleet]:[];
 const raw={set:[{id:'next',atSeconds:600,note:'review',entities:[fleetLabel(fleet)]}],cancel:['old-0']};
 c.snapshot.reminders=Array.from({length:16},(_,i)=>({id:`old-${i}`,atSeconds:600,note:'existing'}));
 const before=structuredClone(raw),candidate=prepareReminders(raw,c);
 assert.deepEqual(raw,before);assert.equal(candidate.active.length,16);assert.deepEqual(candidate.set[0]!.entities,[fleet]);
});
test('local event planner preserves reminder event order and commits finish without review events',async()=>{
 const {c}=fixture();
 const set:AiReminder[]=[{id:'new',atSeconds:600,note:'next'}];
 const plan=planLocalCommit({kind:'reminders',result:{set,cancel:['cancel'],complete:['complete'],active:set,historicalFleetReferences:[]}},c.state.memory,c.snapshot);
 assert.deepEqual(plan.events.map(e=>[e.kind,'id' in e.details?e.details.id:null]),[['reminder-fired','complete'],['reminder-cancelled','cancel'],['reminder-set','new']]);
 assert.equal(plan.memory,c.state.memory);
 const result=await prepareFinish({notebook:{set:[{id:'note',kind:'note',text:'Saved body'}]}},c);
 assert.deepEqual(planLocalCommit({kind:'finish',result},c.state.memory,c.snapshot).events.map(e=>e.kind),['notebook-set']);
});
