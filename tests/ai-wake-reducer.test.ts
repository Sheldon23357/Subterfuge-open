import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeTask} from '../packages/ai/src/controller/runtime/decision.js';
import {reduceWakeTask,deferWake} from '../packages/ai/src/controller/runtime/wake-reducer.js';
import {RunnerState} from '../packages/ai/src/controller/runtime/runner-state.js';
import type {DecisionSignal} from '../packages/ai/src/controller/contracts/types.js';
const initial:DecisionSignal={key:'chat',category:'diplomacy',reason:'incoming message',entities:['home'],urgent:true};
const military:DecisionSignal={key:'attack',category:'military',reason:'visible threat',entities:['target'],urgent:true};
test('pure wake task reducer is repeatable and does not mutate input task or signal sequence',()=>{
 const task=makeTask([initial],[],[],false),signals=[military],before=structuredClone({task,signals});
 const a=reduceWakeTask(task,signals,[]),b=reduceWakeTask(task,signals,[]);
 assert.deepEqual(a,b);assert.deepEqual({task,signals},before);assert.equal(a.task.category,'military');assert.ok(a.task.reasons.includes(initial.reason));assert.ok(a.task.reasons.includes(military.reason));
});
test('wake reduction retains full strategic context and state remains isolated per seat',()=>{
 const task={...makeTask([initial],[],[],false),fullContext:true};const reduction=reduceWakeTask(task,[military],[]);
 assert.equal(reduction.task.scope,'global');assert.equal(reduction.task.weight,'heavy');
 const a=new RunnerState(),b=new RunnerState();deferWake(a,'minor','first',600);deferWake(a,'minor','second',1200);
 assert.deepEqual(a.deferred.get('minor'),{key:'minor',summary:'second',count:2,firstSeconds:600,lastSeconds:1200});assert.equal(b.deferred.size,0);
 assert.equal(a.observationGeneration,0);assert.equal(a.observationBarrier,null);
});
