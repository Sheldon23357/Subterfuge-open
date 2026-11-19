import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {ControllerSeatRunner} from '../packages/ai/src/controller/runtime/runner.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {finishHybridRound} from '../plugins/hybrid/src/round-result.js';
import type {BotMode} from '../packages/ai/src/controller/contracts/bot-mode.js';
import {runnerTestRuntime} from './helpers/runner-harness.js';

test('all event signals share the coalescing window regardless of their stored urgency marker',async t=>{
 t.mock.method(Date,'now',()=>0);
 for(const urgent of [false,true]){
  const store=new AiStore(':memory:'),state=initialState('uniform-triggers',0,{mode:'hybrid',provider:'codex',model:'fixture',personality:'schemer'});
  const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
  const snapshot:AiSnapshot={observation:observation({state:createFleetScenario(setup),scheduled:[]},0,state.roomId),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
  let searches=0;
  const {createBackground:_background,communicate:_communication,...baseMode}=hybridMode;
  const mode:BotMode={...baseMode,needsAnalysis:()=>false,prepare:input=>({...hybridMode.prepare(input),run:async(_request,services)=>{searches++;services.markAssessed();return finishHybridRound(input.snapshot,'done');}})};
  const runner=new ControllerSeatRunner(state,store,{snapshot:async()=>structuredClone(snapshot),request:async()=>assert.fail('No game writes')},{step:async()=>assert.fail('No model')},1,{},()=>mode);
  try{
   await runner.poll(0,false,false,{eventCoalesceMs:1000});assert.equal(searches,1,'opening still runs directly');
   assert.equal(store.reminders(state.roomId,0).some(r=>r.id==='hybrid-review'),false);
   runnerTestRuntime(runner).signals.set('event',{key:'event',kind:'threat-change',category:'military',reason:'new facts',entities:[],urgent});
   await runner.poll(100,false,false,{eventCoalesceMs:1000});assert.equal(searches,1);
   await runner.poll(1099,false,false,{eventCoalesceMs:1000});assert.equal(searches,1);
   await runner.poll(1100,false,false,{eventCoalesceMs:1000});assert.equal(searches,2);
   assert.equal(runnerTestRuntime(runner).signals.size,0);
   const last=store.latest<{tick:number}>(state.roomId,0,'tactical-search-completed')!;
   snapshot.observation.view.tick=last.tick+5;
   await runner.poll(2100,false,false,{eventCoalesceMs:1000});assert.equal(searches,2,'before the configured six-tick interval does not trigger');
   // Receipt/hold completion must not slide the deadline.
   store.saveEvents(state,[{kind:'completed',details:{sequence:state.sequence,reason:'receipt-only'}}]);
   snapshot.observation.view.tick=last.tick+6;
   await runner.poll(3100,false,false,{eventCoalesceMs:1000});assert.equal(searches,2);
   await runner.poll(4100,false,false,{eventCoalesceMs:1000});assert.equal(searches,3,'six ticks triggers one review with a model configured');
   assert.equal(store.latest<{tick:number}>(state.roomId,0,'tactical-search-completed')!.tick,last.tick+6);
   await runner.poll(5100,false,false,{eventCoalesceMs:1000});assert.equal(searches,3,'a completed search resets the elapsed clock');
  }finally{runner.pause();store.close();}
 }
});

test('military causes survive acknowledgement steps independently of urgency',()=>{
 const signals=[false,true].map((urgent,i)=>({key:String(i),category:'military' as const,reason:'changed',entities:[],urgent}));
 assert.deepEqual(hybridMode.retainSignals(signals),signals);
});
