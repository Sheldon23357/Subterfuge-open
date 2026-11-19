import test from 'node:test';
import assert from 'node:assert/strict';
import {AiStore,initialState} from '../packages/ai/src/index.js';
import {AgentDiagnostics} from '../packages/ai/src/controller/diagnostics/agent-diagnostics.js';

test('recent twenty calls retain bodies and older calls retain summaries',()=>{
 const store=new AiStore(':memory:'),state=initialState('room',0,{model:'synthetic',personality:'schemer'}),diagnostics=new AgentDiagnostics(store,state,x=>x);
 try{
  const value={callId:'one',kind:'strategy',status:'completed',queuedAt:'2026-10-31T00:00:00Z',finishedAt:'2026-10-31T00:00:01Z',model:'synthetic',completion:{protocol:'chat',status:'completed',finishReason:'stop',responseId:'synthetic-response'},rawOutput:{text:'RAW_OUTPUT_BODY_CANARY'.repeat(1000),characters:21000,clipped:false},prompt:'PROMPT_BODY_CANARY',responseSchema:{description:'SCHEMA_BODY_CANARY'},output:{summary:'result summary',tasks:[{text:'REPLY_BODY_CANARY'}]},usage:{inputTokens:10,outputTokens:5},usageKnown:{provenance:'reported',input:true,output:true,cached:false}};
  store.save(state,'mode-hybrid-model-call',value);
  const recent=(diagnostics.read('calls') as any).entries[0];
  for(const kind of ['prompt','reply','request'])assert.equal((diagnostics.read('content',{ref:String(recent.callRef),kind}) as any).available,true);
  for(let i=0;i<20;i++)store.save(state,'mode-hybrid-model-call',{...value,callId:String(i)});
  const retained=(diagnostics.read('calls',{limit:'50'}) as any).entries;
  assert.equal(retained.filter((call:any)=>call.prompt.available).length,20);
  const stored=store.debugRows('room',0,{kinds:['mode-hybrid-model-call'],limit:100}).entries.at(-1)!;
  assert.ok(!JSON.stringify(stored).match(/PROMPT_BODY_CANARY|SCHEMA_BODY_CANARY|REPLY_BODY_CANARY|RAW_OUTPUT_BODY_CANARY/));
  const call=(diagnostics.read('call',{ref:String(stored.id)}) as any);
  assert.deepEqual(call.completion,value.completion);assert.equal(call.outcome,'completed');assert.equal(call.processingStatus,'completed');assert.equal(call.summary,'result summary');assert.equal(call.usage.totalTokens,15);assert.equal(call.prompt.characters,value.prompt.length);assert.equal(call.prompt.available,false);
  for(const kind of ['prompt','reply','request'])assert.equal((diagnostics.read('content',{ref:String(call.callRef),kind}) as any).reason,'summary-only');
  assert.ok(value.rawOutput.text.startsWith('RAW_OUTPUT_BODY_CANARY'));assert.ok(JSON.stringify(stored).length<2500);assert.equal(value.output.tasks[0]!.text,'REPLY_BODY_CANARY','storage must not mutate the in-flight model result');
 }finally{store.close();}
});

test('snapshot suppression preserves operation evidence, unknown extensions, commands and observations',()=>{
 const store=new AiStore(':memory:'),state=initialState('room',0,{model:'',personality:'schemer'});
 try{
  const payload={sequence:1,id:'action',operations:[{id:'operation-1',status:'proposed'}],body:'KEEP_EXECUTION_EVIDENCE'};
  for(const kind of ['mode-hybrid-operations','mode-custom-audit','tool-intent','tool-result','comparison-evidence','observation-baseline']){
   store.save(state,kind,payload);store.save(state,kind,payload);
   assert.deepEqual(store.latest('room',0,kind),payload);
   assert.equal(store.history('room',0).filter(r=>r.kind===kind).length,2);
  }
  for(const kind of ['mode-hybrid-search','mode-hybrid-decision','mode-hybrid-feedback','attack-screening','decision-observation','round-workset']){
   store.save(state,kind,payload);
   assert.deepEqual(store.latest('room',0,kind),payload);
   assert.equal((store.debugRows('room',0,{kinds:[kind]}).entries[0]!.payload as any).bodyRetained,false);
  }
 }finally{store.close();}
});
