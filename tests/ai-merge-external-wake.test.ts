import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {AiStore,initialState,type AiSnapshot,type AgentProvider} from '../packages/ai/src/index.js';
import {ProviderError} from '../packages/ai/src/controller/contracts/provider-error.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
function fixture(provider:AgentProvider={step:async()=>{throw Error('No provider expected');}}){
 const state=initialState('merge-wake',0,{model:'fake',personality:'schemer'}),store=new AiStore(':memory:');
 const obs=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,state.roomId);
 const snapshot:AiSnapshot={observation:obs,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 state.memory.strategy='old shared memory';store.save(state);
 const runner=new SeatRunner(state,store,{snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No game writes');}},provider);
 return{state,store,runner};
}
function independentWrite(f:ReturnType<typeof fixture>,text:string,version=2){const state=f.store.load(f.state.roomId,0)!;state.memory={...state.memory,strategy:text};state.commanderDirectives={version,text:`authority ${version}`};f.store.save(state,'external-writer');}

test('external memory-review wake preserves durable private domains while persisting its own scheduling',()=>{
 const f=fixture();try{
  independentWrite(f,'fresh durable memory');const basis=f.store.localWriteBasis(f.state.roomId,0);
  f.runner.requestMemoryReview();const saved=f.store.load(f.state.roomId,0)!;
  assert.equal(saved.memory.strategy,'fresh durable memory');assert.deepEqual(saved.commanderDirectives,{version:2,text:'authority 2'});
  assert.equal(f.state.memory.strategy,saved.memory.strategy);assert.deepEqual(f.state.commanderDirectives,saved.commanderDirectives);
  assert.equal(f.store.localWriteBasis(f.state.roomId,0),basis);
  assert.ok(f.store.latest<{signals:{key:string}[]}>(f.state.roomId,0,'wake-state')!.signals.some(s=>s.key==='memory-review'));
 }finally{f.store.close();}
});

test('external wake CAS rejects a writer between snapshot and save without advancing shared authority',t=>{
 const f=fixture();try{
  independentWrite(f,'first external memory');const save=f.store.save.bind(f.store);let raced=false;
  const saveEvents=f.store.saveEvents.bind(f.store);
  t.mock.method(f.store,'saveEvents',(...[state,events,localId,expectedBasis,options]:Parameters<AiStore['saveEvents']>)=>{
   if(events.some(event=>event.kind==='wake-state')&&!raced){raced=true;const other=f.store.load(f.state.roomId,0)!;other.memory={...other.memory,strategy:'racing durable memory'};other.commanderDirectives={version:3,text:'racing authority'};save(other,'racing-writer');}
   return saveEvents(state,events,localId,expectedBasis,options);
  });
  assert.throws(()=>f.runner.requestMemoryReview(),/LOCAL_BASIS_CHANGED/);
  assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'racing durable memory');assert.equal(f.state.commanderDirectives,undefined);
  assert.equal(f.store.latest(f.state.roomId,0,'wake-state'),null);
  f.runner.requestMemoryReview();assert.equal(f.state.memory.strategy,'racing durable memory');assert.deepEqual(f.state.commanderDirectives,{version:3,text:'racing authority'});
 }finally{f.store.close();}
});

test('external wake never refreshes an in-flight model basis to authorize its obsolete finish',async()=>{
 let release!:(value:Awaited<ReturnType<AgentProvider['step']>>)=>void,calls=0;
 const f=fixture({step:async request=>{calls++;if(calls===1)return new Promise(r=>{release=r;});assert.ok(request.prompt.includes('fresh durable memory'));throw new ProviderError('unavailable',undefined,{stage:'test-stop',outcome:'not-sent'});}});
 try{
  const pending=f.runner.poll(0,true);for(let i=0;!release&&i<100;i++)await new Promise<void>(r=>setImmediate(r));assert.ok(release);
  independentWrite(f,'fresh durable memory');f.runner.requestMemoryReview();
  release({tokens:0,reply:{tool:'finish',arguments:{memory:{strategy:'obsolete model write'}},summary:'Old decision'}});await pending;
  assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'fresh durable memory');assert.equal(f.store.load(f.state.roomId,0)!.commanderDirectives?.version,2);
  assert.equal(f.store.latest<{reason:string}>(f.state.roomId,0,'decision-superseded')!.reason,'local-basis-changed');
  assert.equal(f.state.status,'waiting');assert.equal(f.state.error,null);assert.equal(f.store.latest(f.state.roomId,0,'completed'),null);assert.equal(calls,1);
 }finally{f.store.close();}
});
