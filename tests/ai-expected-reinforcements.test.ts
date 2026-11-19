import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {AiStore,initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {classifyChanges} from '../packages/ai/src/controller/runtime/decision.js';
import type {ToolContext} from '../packages/ai/src/controller/execution/tools.js';

function fixture(){
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'expected');
 o.view.tick=100;o.secondsSinceLastTick=0;o.scheduled=[];o.view.size={width:40,height:40};
 o.view.outposts=[{id:'home',owner:0,type:'generator',position:{x:0,y:0},visibility:2,drillers:100,shield:0,shieldMax:10,shieldsEnabled:true,destroyed:false,minePending:false},
  {id:'target',owner:1,type:'generator',position:{x:1,y:0},visibility:2,drillers:20,shield:0,shieldMax:10,shieldsEnabled:true,destroyed:false,minePending:false}];
 o.outpostNames={home:'HAVEN',target:'REEF'};
 o.view.fleets=[{id:'known-reinforcement',owner:1,position:{x:.98,y:0},drillers:14,state:'moving',gift:false,destination:{kind:'outpost',id:'target'}},
  {id:'actual-attack',owner:0,source:'home',position:{x:.1,y:0},drillers:40,state:'moving',gift:false,destination:{kind:'outpost',id:'target'}}];
 o.view.self.outpostCount=1;
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const state=initialState('expected',0,{model:'',personality:'sentinel'}),store=new AiStore(':memory:');
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No real operation or forecast HTTP');}};
 const c:ToolContext={snapshot,state,gateway,id:'comparison',spoken:0,now:60000,audit:(kind,payload)=>store.save(state,kind,payload)};
 const plan={id:'take-target',intent:'attack',targets:['REEF'],drafts:[{id:'later-attack',issueTick:110,action:{kind:'launch',source:'HAVEN',destination:'REEF',drillers:40}}]};
 const after=()=>{const next=structuredClone(o);next.view.tick=101;next.view.fleets=next.view.fleets.filter(f=>f.id!=='known-reinforcement');next.view.outposts[1]!.drillers=34;return next;};
 return {o,snapshot,state,store,c,plan,gateway,after};
}

test('only visible deterministic production bounds defer growth; unrelated forecasted reinforcements do not',()=>{
 const f=fixture();try{
  const post=f.o.view.outposts[1]!;post.type='factory';
  post.metrics={active:true,paused:false,output:6,cycleMinutes:480,nextMinutes:10,progress:47/48,capacity:200,used:34,contribution:0,neptunium:0,mines:0};
  const normal=f.after();normal.view.outposts[1]!.drillers=26;
  const bounded=classifyChanges(f.o,normal);assert.equal(bounded.important.some(s=>s.key==='attack-target:target'),false);
  assert.ok(bounded.minor.some(s=>s.key==='expected-growth:target'));
  assert.ok(classifyChanges(f.o,f.after()).important.some(s=>s.key==='attack-target:target'));
  const hidden=f.after();delete hidden.view.outposts[1]!.drillers;
  assert.ok(classifyChanges(f.o,hidden).important.some(s=>s.key==='attack-target:target'));
 }finally{f.store.close();}
});

test('restart preserves actual target changes and explicit reminders without restoring archived campaign cognition',async()=>{
 const f=fixture();let calls=0;try{
  f.state.lastThought=60000;f.store.save(f.state,'campaign-state',{plans:[{id:'old',target:'target',comparison:{resultRef:'DONT_RESTORE_OLD_PROJECTION'}}]});
  f.store.save(f.state,'wake-state',{signals:[],deferred:[],observed:f.o});
  f.store.save(f.state,'reminder-set',{id:'review-target',atSeconds:64800,note:'第108天重新评估当前目标',category:'military',entities:['target']});
  f.snapshot.observation=f.after();
  const provider={step:async(request:any)=>{calls++;assert.doesNotMatch(request.prompt,/DONT_RESTORE_OLD_PROJECTION/);return {tokens:1,reply:{tool:'finish',arguments:f.snapshot.observation.view.tick>=108?{reminders:{complete:['review-target']}}:{},summary:'review current facts'}};}};
  const runner=new SeatRunner(f.state,f.store,f.gateway,provider);await runner.poll(0,true);assert.equal(calls,1);await runner.poll(20000);assert.equal(calls,1);runner.pause();
  f.state.enabled=true;f.state.status='waiting';f.store.save(f.state,'resumed');f.snapshot.observation.view.tick=108;
  const restarted=new SeatRunner(f.state,f.store,f.gateway,provider);await restarted.poll(40000,true);assert.equal(calls,2);
  assert.deepEqual(f.store.reminders('expected',0),[]);assert.equal((f.store.latest('expected',0,'campaign-state') as any).plans[0].comparison.resultRef,'DONT_RESTORE_OLD_PROJECTION');
  restarted.pause();
 }finally{f.store.close();}
});
