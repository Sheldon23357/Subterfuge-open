import {SeatRunner} from './helpers/scripted-controller.js';
import {decisionBudget} from '../packages/ai/src/controller/runtime/decision-budget.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {AiStore,initialState,executeTool,type AiSnapshot,type AgentRequest} from '../packages/ai/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {classifyChanges} from '../packages/ai/src/controller/runtime/decision.js';
import {chatWake,handledChat,reopenChat} from '../packages/ai/src/controller/observation/chat-wake.js';
const reply=(tool='finish',args:unknown={})=>({tokens:1,reply:{tool,arguments:JSON.stringify(args),summary:'测试处理'}});
function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const snapshot:AiSnapshot={observation:observation({state:createFleetScenario(cfg),scheduled:[]},0,'safety'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const store=new AiStore(':memory:'),state=initialState('safety',0,{model:'',personality:'sentinel'});
 return {snapshot,store,state};
}

test('near accepted launch targets wake before a fleet exists; unbooked ideas and distant schedules do not',()=>{
 const {snapshot,store}=fixture();try{
   const before=snapshot.observation,target=before.view.outposts.find(p=>p.owner===1)!,after=structuredClone(before);
   after.view.outposts.find(p=>p.id===target.id)!.drillers=(target.drillers??0)+20;
   assert.equal(classifyChanges(before,after).important.some(s=>s.key.startsWith('attack-target:')),false);
   after.scheduled=[{id:'later',player:0,issueTick:102,status:'pending',action:{kind:'launch',source:before.view.outposts[0]!.id,destination:target.id,drillers:30}}];
   assert.ok(classifyChanges(before,after).important.some(s=>s.key.startsWith('attack-target:')));
   after.scheduled[0]!.issueTick=300;
   assert.equal(classifyChanges(before,after).important.some(s=>s.key.startsWith('attack-target:')),false);
 }finally{store.close();}
});

test('routine visible production is merged; reinforcements beyond its bound still wake',()=>{
 const {snapshot,store}=fixture();try{
   const before=snapshot.observation,target=before.view.outposts.find(p=>p.owner===1)!;
   target.type='factory';target.drillers=5;target.shield=0;target.shieldMax=10;
   target.metrics={...before.view.outposts[0]!.metrics!,active:true,paused:false,output:6,cycleMinutes:320,nextMinutes:10};
   before.view.fleets.push({id:'attacking',owner:0,drillers:40,position:{x:0,y:0},state:'moving',gift:false,destination:{kind:'outpost',id:target.id}});
   const after=structuredClone(before);after.view.tick++;after.view.outposts.find(p=>p.id===target.id)!.drillers=11;
   const normal=classifyChanges(before,after);
   assert.equal(normal.important.some(s=>s.key.startsWith('attack-target:')),false);
   assert.ok(normal.minor.some(s=>s.key.startsWith('expected-growth:')));
   after.view.outposts.find(p=>p.id===target.id)!.drillers=25;
   assert.ok(classifyChanges(before,after).important.some(s=>s.key.startsWith('attack-target:')));
 }finally{store.close();}
});

test('finish refuses to consume unacknowledged reminders, and validates explicit completion atomically',async()=>{
 const {snapshot,store,state}=fixture();try{
   snapshot.reminders=[{id:'due',atSeconds:60000,note:'inspect'},{id:'future',atSeconds:60600,note:'later'}];
   const c={state,snapshot,gateway:{snapshot:async()=>snapshot,request:async()=>{throw Error('No game writes');}},id:'finish',spoken:0,now:60000};
   await assert.rejects(executeTool('finish',{memory:{strategy:'must not save'}},c),/Unresolved due reminders/);
   assert.equal(state.memory.strategy,'');
   await assert.rejects(executeTool('finish',{reminders:{complete:['future']}},c),/Only due/);
   const done=await executeTool('finish',{reminders:{complete:['due']}},c) as any;
   assert.deepEqual(done.reminders.complete,['due']);
   const delayed=await executeTool('finish',{reminders:{set:[{id:'due',atSeconds:61200,note:'deferred with reason'}]}},c) as any;
   assert.equal(delayed.reminders.set[0].atSeconds,61200);
 }finally{store.close();}
});

test('repeated courtesy replies are muted, but acceptance, refusal and changed terms always wake',()=>{
 const {snapshot,store}=fixture();try{
   const m={id:'ack1',from:1,to:0,text:'收到',tick:100,sentAt:0};
   assert.equal(chatWake([m],0,{},100).active.length,1);
   const processed=handledChat([m],0,{});
   assert.equal(chatWake([{...m,id:'ack2',text:'谢谢'}],0,processed,100).muted.length,1);
   for(const text of ['同意','拒绝','请撤军','收到，改成12小时停战'])assert.equal(chatWake([{...m,text}],0,processed,100).active.length,1);
   assert.equal(chatWake([{...m,to:null}],0,processed,100).active.length,1);
   assert.equal(chatWake([m],0,processed,140).active.length,1);
   assert.equal(chatWake([m],0,reopenChat(processed,new Set(['player:1'])),100).active.length,1);
 }finally{store.close();}
});


test('a reminder becoming due during diplomacy upgrades the round once and requires explicit acknowledgement',async()=>{
 const {snapshot,store,state}=fixture();let calls=0,release!:()=>void,entered!:()=>void;
 const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const requests:AgentRequest[]=[];
 const runner=new SeatRunner(state,store,{snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No writes');}},{step:async r=>{
   requests.push(r);calls++;
   if(calls===2){entered();await gate;return reply();}
   if(calls===3){await runner.poll(34000);return reply('finish',{reminders:{complete:['urgent-review']}});}
   return reply();
 }});
 try{
   await runner.poll(0);
   store.save(state,'reminder-set',{id:'urgent-review',atSeconds:60060,note:'军事节点',category:'military',entities:[snapshot.observation.view.outposts[1]!.id]});
   snapshot.chat=[{id:'chat-due',from:1,to:0,text:'提出停战',tick:100,sentAt:0}];snapshot.chatCursor=1;
   await runner.poll(6000);const running=runner.poll(22000);await ready;
   snapshot.observation.secondsSinceLastTick=60;await runner.poll(28000);
   release();await running;
   assert.equal(calls,3);assert.equal(requests[2]!.effort,'low');assert.match(requests[2]!.prompt,/军事节点/);
   assert.deepEqual(store.reminders('safety',0),[]);
 }finally{release();runner.pause();store.close();}
});


test('first-round budget is twenty minutes; ordinary rounds are ten minutes with closing reserves',()=>{
 assert.equal(decisionBudget(true).hardMs,1200000);assert.equal(decisionBudget(false).hardMs,600000);
 for(const first of [true,false]){const b=decisionBudget(first);assert.ok(b.warnMs<b.yieldMs);assert.equal(b.hardMs-b.yieldMs,30000);}
});

test('a yielded round resumes on wall time with a frozen game clock and does not repeat an accepted command',async(t)=>{
 const {snapshot,store,state}=fixture();let wall=1000,calls=0,writes=0;
 t.mock.method(Date,'now',()=>wall);
 const runner=new SeatRunner(state,store,{snapshot:async()=>structuredClone(snapshot),request:async()=>{writes++;wall=1171001;return snapshot.observation;}},{step:async()=>++calls===1?reply('order',{action:{kind:'check-in'}}):reply()});
 try{
   await runner.poll(wall,true);assert.equal(writes,1);assert.equal((store.decisionPage('safety',0).entries[0]!.payload as any).status,'pending-continuation');
   wall+=16000;await runner.poll(wall);assert.equal(calls,2);assert.equal(writes,1);assert.equal(snapshot.observation.view.tick,100);
   assert.equal((store.decisionPage('safety',0).entries[0]!.payload as any).status,'completed');
 }finally{runner.pause();store.close();}
});
