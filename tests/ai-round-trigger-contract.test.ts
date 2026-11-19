import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {classifyChanges,classifyNotice,makeTask,mergeDecisionSignals} from '../packages/ai/src/controller/runtime/decision.js';
import {reduceWakeTask} from '../packages/ai/src/controller/runtime/wake-reducer.js';
import type {AiSnapshot,DecisionSignal,DecisionTriggerKind} from '../packages/ai/src/controller/contracts/types.js';

function trigger(kind:DecisionTriggerKind,key:string=kind,entities:string[]=[]):DecisionSignal{return {kind,key,category:kind==='diplomacy-message'?'diplomacy':kind==='threat-change'?'military':'plan',reason:`原始原因:${kind}`,entities,urgent:false,sources:[{kind:'runtime',id:key}]};}
function fixture(signals:DecisionSignal[]=[trigger('arrival-check','arrival',['fleet-a'])]):AiSnapshot{
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;cfg.match={mode:'mining',neptuniumGoal:200};
 return {observation:observation({state:createFleetScenario(cfg),scheduled:[]},0,'first-call'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,task:makeTask(signals,[],[],signals.some(s=>s.kind==='diplomacy-message'))};
}

test('typed causes preserve source identities and all independent causes instead of collapsing into category',()=>{
 const signals=[trigger('arrival-check','arrival',['fleet-a']),trigger('threat-change','threat',['target']),trigger('diplomacy-message','message')];
 const task=makeTask(signals,['收到消息'],[],true);
 assert.equal(task.category,'military');assert.deepEqual(task.triggers,signals);assert.equal(task.triggers?.length,3);
});

test('duplicate identity merges provenance, entities and mandatory review flags but never merges different event kinds',()=>{
 const first=trigger('threat-change','same',['a']),second={...first,entities:['b'],sources:[{kind:'notification' as const,id:'12'}],requiresFullContext:true,reviewRequirements:{factsNeeded:true,strategicReview:true,cleanupNeeded:false}};
 const merged=mergeDecisionSignals([first,second,{...first,kind:'arrival-check'}]);
 assert.equal(merged.length,2);assert.equal(merged[0]!.sources!.length,2);assert.deepEqual(merged[0]!.entities,['a','b']);
 assert.equal(merged[0]!.requiresFullContext,true);assert.equal(merged[0]!.reviewRequirements!.strategicReview,true);
 const task=makeTask(merged,[],[],false);assert.equal(task.fullContext,true);assert.equal(task.memoryReview?.strategicReview,true);
});


test('wake reduction unions typed causes and review obligations without losing original global requirements',()=>{
 const prior=makeTask([{...trigger('recovery'),role:'inherited-trigger',reviewRequirements:{factsNeeded:true,strategicReview:true,cleanupNeeded:false}}],[],[],false);
 const reduced=reduceWakeTask(prior,[trigger('threat-change','threat'),trigger('diplomacy-message','chat')],[]).task;
 assert.equal(reduced.triggers!.length,3);assert.equal(reduced.memoryReview?.strategicReview,true);assert.equal(reduced.memoryReview?.factsNeeded,true);
});

test('observation and notification producers retain exact identities without treating disappearance as arrival proof',()=>{
 const before=fixture().observation;before.view.fleets.push({id:'gone',owner:0,position:{x:1,y:1},drillers:5,state:'moving',gift:false,source:'previous-source',destination:{kind:'outpost',id:'previous-target'}});
 const after=structuredClone(before);after.revision='new-revision';after.view.fleets=[];after.view.outposts[0]!.minePending=true;
 const signals=classifyChanges(before,after).important;assert.equal(signals.find(s=>s.key==='arrival:gone')!.kind,'fleet-state-change');
 assert.equal(signals.find(s=>s.key==='arrival:gone')!.sources![0]!.id,'new-revision');assert.deepEqual(signals.find(s=>s.key==='arrival:gone')!.entities,['gone','previous-source','previous-target']);

 const signal=classifyNotice({id:91,kind:'mine-created',tick:100,seconds:0,text:'舰队已抵达',details:null,urgent:true,sendNotification:true,location:{kind:'outpost',id:after.view.outposts[0]!.id,position:after.view.outposts[0]!.position}},after.view,{signals});
 assert.equal(signal?.kind,'construction-change');assert.ok(signal?.sources?.some(source=>source.kind==='notification'&&source.id==='91'));assert.ok(signal?.sources?.some(source=>source.kind==='observation'));
});


test('unrelated new chat never lowers an existing task budget or erases its business category',()=>{
 const task=makeTask([trigger('arrival-check')],[],[],false);
 const next=reduceWakeTask(task,[trigger('diplomacy-message','chat')],[]).task;
 assert.equal(next.category,'plan');assert.equal(next.weight,'medium');assert.equal(next.triggers?.length,2);
});

