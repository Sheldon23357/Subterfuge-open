import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {initialState,type AgentResult} from '../packages/ai/src/controller/contracts/types.js';
import {AgentDiagnostics,diagnosticUsage} from '../packages/ai/src/controller/diagnostics/agent-diagnostics.js';
import {createDiagnosticRedactor} from '../packages/ai/src/application/agent-redactor.js';
import {OpenAICompatibleProvider} from '../packages/ai/src/application/providers/openai-compatible.js';
const result:AgentResult={reply:{tool:'finish',arguments:{},summary:'done'},tokens:14,usage:{inputTokens:10,outputTokens:4,cachedInputTokens:3},usageKnown:{provenance:'reported',input:true,output:true,cached:true}};
function fixture(){const store=new AiStore(':memory:'),state=initialState('room',0,{model:'synthetic',personality:'schemer'}),keys=['old-seat-canary','other-seat-canary'];state.sequence=1;const redact=createDiagnosticRedactor(()=>keys),diagnostics=new AgentDiagnostics(store,state,redact);return {store,state,keys,redact,diagnostics};}

test('late write reconciliation updates only the original operation across later call boundaries',()=>{
 const f=fixture();try{
  f.store.save(f.state,'call-reserved',{sequence:1,step:0,attempt:0,startedAt:100});
  const handle=f.diagnostics.beginCall({model:'synthetic',prompt:'current round',signal:new AbortController().signal})!;
  f.diagnostics.finishCall(handle,{...result,reply:{tool:'order',arguments:{},summary:'original order'}});
  f.store.save(f.state,'tool-intent',{id:'original',tool:'order',arguments:{}});
  f.store.save(f.state,'tool-unknown',{id:'original',tool:'order',result:{status:'unknown',error:'transport interrupted'}});
  f.store.save(f.state,'call-reserved',{sequence:2,step:0,attempt:0,startedAt:200});
  f.store.save(f.state,'write-reconciled',{id:'sibling',tool:'order',status:'rejected',reason:'must not attach'});
  f.store.save(f.state,'write-reconciled',{id:'original',tool:'order',status:'committed',reason:'authority confirmed'});
  let row=(f.diagnostics.read('calls',{limit:'10'}) as any).entries.find((c:any)=>c.callRef===handle.record.callRef);
  assert.equal(row.toolOutcome,'returned');assert.equal(row.toolReconciled,true);assert.equal(row.toolError,null);
  f.store.save(f.state,'write-reconciled',{id:'original',tool:'order',status:'not-executed',reason:'never-dispatched'});
  row=(f.diagnostics.read('calls',{limit:'10'}) as any).entries.find((c:any)=>c.callRef===handle.record.callRef);
  assert.equal(row.toolOutcome,'not-executed');assert.equal(row.toolError,'never-dispatched');
 }finally{f.store.close();}
});

test('diagnostic summaries distinguish interrupted query coverage and unknown writes',()=>{
 const f=fixture();try{
  for(const [step,tool,kind,value,expected]of [
   [0,'queries','tool-rejected',{status:'interrupted',complete:false,error:'network read failed',results:[{status:'success'},{status:'failed'},{status:'not-executed'}]},'partial'],
   [1,'order','tool-unknown',{status:'unknown',error:'write outcome unknown'},'unknown'],
   [2,'batch','tool-unknown',{status:'unknown',complete:false,results:[{status:'accepted'},{status:'unknown'},{status:'not-executed'}]},'partial'],
  ] as const){
   f.store.save(f.state,'call-reserved',{sequence:1,step,attempt:0,startedAt:100});
   const handle=f.diagnostics.beginCall({model:'synthetic',prompt:'synthetic current round',signal:new AbortController().signal})!;
   f.diagnostics.finishCall(handle,{...result,reply:{tool,arguments:{},summary:'synthetic operation'}});
   f.store.save(f.state,kind,{tool,result:value});
   const page=f.diagnostics.read('calls',{limit:'10'}) as any;
   const row=page.entries.find((c:any)=>c.callRef===handle.record.callRef);
   assert.equal(row.toolOutcome,expected);assert.equal(row.outcome,'completed');
  }
 }finally{f.store.close();}
});
test('call list distinguishes rejected tools, historical pause cancellation and real provider failure',()=>{
 const f=fixture();try{
  f.store.save(f.state,'started',{sequence:1,tick:0,reasons:['首次进入对局']});
  const reserve=(step:number)=>{f.store.save(f.state,'call-reserved',{sequence:1,step,attempt:0,startedAt:100});return f.diagnostics.beginCall({model:'synthetic',prompt:'当前受限情报及新消息：{"observation":{"view":{"tick":17}}}',signal:new AbortController().signal})!;};
  const first=reserve(0);f.diagnostics.finishCall(first,{...result,reply:{tool:'batch',arguments:{},summary:'Synthetic action old-seat-canary'}});
  f.store.save(f.state,'tool-result',{tool:'batch',result:{complete:false,results:[{status:'rejected',error:'stale-observation'}]}});
  const second=reserve(1);f.diagnostics.finishCall(second,undefined,Error('cancelled by old runner'));f.store.save(f.state,'paused');
  const third=reserve(2);f.diagnostics.finishCall(third,undefined,Error('provider failure'));f.store.save(f.state,'call-failed',{code:'unavailable'});f.store.save(f.state,'paused');
  const page=f.diagnostics.read('calls',{limit:'10'}) as any;
  const firstRow=page.entries.find((c:any)=>c.callRef===first.record.callRef);
  assert.equal(firstRow.outcome,'completed');assert.equal(firstRow.toolOutcome,'partial');assert.equal(firstRow.toolError,'stale-observation');assert.equal(firstRow.observedTick,17);assert.ok(!firstRow.summary.includes('old-seat-canary'));
  assert.equal(page.entries.find((c:any)=>c.callRef===second.record.callRef).outcome,'cancelled');
  assert.equal(page.entries.find((c:any)=>c.callRef===third.record.callRef).outcome,'failed');
  assert.deepEqual(JSON.parse(JSON.stringify(page.rounds)),[{round:1,tick:0,reasons:['首次进入对局']}]);
 }finally{f.store.close();}
});
test('diagnostics capture redacts before persistence, across seats and key rotation',()=>{
  const f=fixture();try{
    f.store.save(f.state,'call-reserved',{sequence:1,step:0,attempt:0,startedAt:100,promptCharacters:100});
    const handle=f.diagnostics.beginCall({model:'synthetic',prompt:'normal facts old-seat-canary other-seat-canary Authorization: Bearer unknown-canary\napiKey="different-canary"',signal:new AbortController().signal});assert.ok(handle);
    f.keys.push('new-seat-canary');
    f.diagnostics.finishCall(handle,{...result,reply:{tool:'finish',arguments:{apiKey:'new-seat-canary',nested:{headers:{Authorization:'different-canary'}},note:'old-seat-canary'},summary:'normal facts'}});
    const stored=JSON.stringify(f.store.debugGetCall('room',0,handle.record.callRef));
    for(const secret of ['old-seat-canary','other-seat-canary','new-seat-canary','unknown-canary','different-canary'])assert.ok(!stored.includes(secret));
    assert.ok(stored.includes('normal facts'));assert.ok(!stored.includes('summary-only'));assert.ok(stored.includes('nested'));
    const content=f.diagnostics.read('content',{ref:String(handle.record.callRef),kind:'prompt'}) as any;
    assert.equal(content.available,true);assert.ok(content.text);
    assert.equal(f.store.debugGetCall('room',1,handle.record.callRef),null);
  }finally{f.store.close();}
});
test('legacy calls never fabricate prompt, token measurement or wall time',()=>{
  const f=fixture();try{
    f.store.save(f.state,'call-reserved',{sequence:1,step:0,attempt:0,promptCharacters:123});
    const page=f.diagnostics.read('calls') as {entries:{callRef:number;startedAt:null;usage:unknown;prompt:{available:boolean}}[]};
    const call=page.entries[0]!;assert.equal(call.prompt.available,false);assert.equal(call.startedAt,null);
    assert.deepEqual(JSON.parse(JSON.stringify(call.usage)),{inputTokens:null,outputTokens:null,cachedInputTokens:null,totalTokens:null,provenance:'legacy-unknown'});
    assert.equal((f.diagnostics.read('content',{ref:String(call.callRef),kind:'prompt'}) as {available:boolean}).available,false);
    assert.throws(()=>f.diagnostics.read('events',{from:'100'}));
    assert.throws(()=>f.diagnostics.read('calls',{generation:'other-seat'}));
  }finally{f.store.close();}
});
test('bounded keyset pages, per-round events, current entities and histories stay isolated',()=>{
  const f=fixture();try{
    for(let round=1;round<=4;round++){f.state.sequence=round;f.store.save(f.state,'started',{sequence:round});for(let step=0;step<12;step++)f.store.save(f.state,'call-reserved',{sequence:round,step,attempt:0,startedAt:round*100+step});f.store.save(f.state,'tool-result',{tool:'finish',secret:'old-seat-canary'});}
    const first=f.diagnostics.read('calls',{limit:'10',round:'2'}) as {entries:{round:number;callRef:number}[];nextCursor:number};assert.equal(first.entries.length,10);assert.ok(first.entries.every(e=>e.round===2));
    const second=f.diagnostics.read('calls',{limit:'10',round:'2',before:String(first.nextCursor)}) as {entries:unknown[];nextCursor:null};assert.equal(second.entries.length,2);assert.equal(second.nextCursor,null);
    const timed=f.diagnostics.read('calls',{from:'205',to:'207'}) as {entries:unknown[]};assert.equal(timed.entries.length,3);
    const events=f.diagnostics.read('events',{round:'3',limit:'50'}) as {entries:{kind:string}[]};assert.equal(events.entries.filter(e=>e.kind==='tool-result').length,1);
    f.store.save(f.state,'notebook-set',{id:'n1',kind:'fact',text:'old',updatedAt:1,expiresAt:null});f.store.save(f.state,'notebook-set',{id:'n1',kind:'fact',text:'new',updatedAt:2,expiresAt:null});f.store.save(f.state,'notebook-set',{id:'n2',kind:'fact',text:'gone',updatedAt:2,expiresAt:null});f.store.save(f.state,'notebook-removed',{id:'n2'});
    const notes=f.diagnostics.read('notebook') as {entries:{payload:{text:string}}[]};assert.equal(notes.entries.length,1);assert.equal(notes.entries[0]!.payload.text,'new');
    assert.equal((f.diagnostics.read('notebook',{scope:'history'}) as {entries:unknown[]}).entries.length,4);
    assert.equal(f.diagnostics.exportSnapshot().notebook.length,1);
    assert.throws(()=>f.diagnostics.read('calls',{limit:'51'}));
  }finally{f.store.close();}
});
test('capture faults cannot throw into provider or mutate seat state',()=>{
  const f=fixture();f.store.save(f.state,'call-reserved',{sequence:1});const original=structuredClone(f.state);
  const bad=new AgentDiagnostics(f.store,f.state,()=>{throw Error('synthetic redactor failure');});
  assert.equal(bad.beginCall({model:'x',prompt:'x',signal:new AbortController().signal}),null);assert.doesNotThrow(()=>bad.finishCall(null,result));assert.deepEqual(f.state,original);f.store.close();
});
test('usage keeps cached input as a subset and missing fields unknown',()=>{
  assert.deepEqual(diagnosticUsage(result),{inputTokens:10,outputTokens:4,cachedInputTokens:3,totalTokens:14,provenance:'reported'});
  assert.equal(diagnosticUsage({...result,usage:{inputTokens:10,outputTokens:4,cachedInputTokens:11}}).cachedInputTokens,null);
  assert.deepEqual(diagnosticUsage({...result,usageKnown:{provenance:'reported',input:false,output:true,cached:false}}),{inputTokens:null,outputTokens:4,cachedInputTokens:null,totalTokens:null,provenance:'reported'});
  assert.equal(diagnosticUsage({reply:result.reply,tokens:0}).provenance,'legacy-unknown');
});
test('compatible adapter preserves missing, explicit zero, partial and invalid cached provenance',async()=>{
  for(const [usage,expected] of [[undefined,{input:false,output:false,cached:false}],[{prompt_tokens:0,completion_tokens:0},{input:true,output:true,cached:false}],[{completion_tokens:4},{input:false,output:true,cached:false}],[{prompt_tokens:10,completion_tokens:4,prompt_tokens_details:{cached_tokens:11}},{input:true,output:true,cached:false}],[{prompt_tokens:-1,completion_tokens:Infinity},{input:false,output:false,cached:false}],[{prompt_tokens:10,completion_tokens:4,prompt_tokens_details:{cached_tokens:0}},{input:true,output:true,cached:true}]] as const){
    const provider=new OpenAICompatibleProvider({apiKey:'synthetic',baseUrl:'https://example.test/v1',apiStyle:'chat',fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({request:{tool:'finish',arguments:{}},summary:'test'})}}],usage}),{headers:{'Content-Type':'application/json'}})});
    const reply=await provider.step({model:'fake',prompt:'fake',signal:new AbortController().signal});assert.deepEqual(reply.usageKnown,{provenance:'reported',...expected});
    if(!expected.input||!expected.output)assert.equal(diagnosticUsage(reply).totalTokens,null);
  }
});
test('redactor bounds depth/size and preserves ordinary token counters',()=>{
  const redact=createDiagnosticRedactor(()=>['known-secret']);
  assert.deepEqual(JSON.parse(JSON.stringify(redact({tokens:10,inputTokens:8,cachedInputTokens:2,note:'ordinary token counting',url:'https://user:pass@example.test/?token=unknown',secret:'anything'}))),{tokens:10,inputTokens:8,cachedInputTokens:2,note:'ordinary token counting',url:'https://[redacted]@example.test/?token=[redacted]',secret:'[redacted]'});
  let nested:unknown={};for(let i=0;i<30;i++)nested={nested};assert.throws(()=>redact(nested));assert.throws(()=>redact('x'.repeat(1500001)));
});
test('current notebook pagination bounds history scanning and preserves empty-page cursors',()=>{
  const f=fixture();try{
    f.store.save(f.state,'notebook-set',{id:'old-active',kind:'fact',text:'still active',updatedAt:0,expiresAt:null});
    for(let i=0;i<250;i++)f.store.save(f.state,'notebook-set',{id:'changing',kind:'fact',text:String(i),updatedAt:i,expiresAt:null});
    const first=f.store.debugEntityPage('room',0,'notebook',Number.MAX_SAFE_INTEGER,1);assert.equal(first.entries.length,1);assert.ok(first.nextCursor);
    const middle=f.store.debugEntityPage('room',0,'notebook',first.nextCursor!,1);assert.equal(middle.entries.length,0);assert.ok(middle.nextCursor);
    const last=f.store.debugEntityPage('room',0,'notebook',middle.nextCursor!,1);assert.equal(last.entries.length,1);assert.equal((last.entries[0]!.payload as {id:string}).id,'old-active');assert.equal(last.nextCursor,null);
  }finally{f.store.close();}
});

test('current campaigns show only the latest state without a historical cursor',()=>{
  const f=fixture();try{
    f.store.save(f.state,'campaign-state',{plans:[{id:'old-plan'}]});
    f.store.save(f.state,'campaign-state',{plans:[{id:'current-plan'}]});
    const current=f.diagnostics.read('campaigns',{scope:'current',limit:'1'}) as {entries:{id:number;payload:{plans:{id:string}[]}}[];nextCursor:null};
    assert.equal(current.entries.length,1);assert.equal(current.entries[0]!.payload.plans[0]!.id,'current-plan');assert.equal(current.nextCursor,null);
    assert.equal((f.diagnostics.read('campaigns') as {nextCursor:null}).nextCursor,null);
    const history=f.diagnostics.read('campaigns',{scope:'history',limit:'1'}) as {entries:unknown[];nextCursor:number};assert.ok(history.nextCursor);
    const older=f.diagnostics.read('campaigns',{scope:'history',limit:'1',before:String(history.nextCursor)}) as {entries:{payload:{plans:{id:string}[]}}[];nextCursor:null};
    assert.equal(older.entries[0]!.payload.plans[0]!.id,'old-plan');assert.equal(older.nextCursor,null);
  }finally{f.store.close();}
});


test('hybrid background calls share the automatic model list with stable pagination and retained content',()=>{
 const f=fixture();try{
  const value={callId:'background-one',sequence:1,kind:'strategy',task:'overview',attempt:0,status:'queued',model:'hybrid-model',effort:'low',timeoutMs:120000,queuedAt:'2026-10-27T00:00:00.000Z',finishedAt:null,prompt:'授权上下文 old-seat-canary '+ '材料'.repeat(40000),responseSchema:{type:'object'},output:null,usage:null,usageKnown:null};
  f.store.save(f.state,'mode-hybrid-model-call',value);
  const initial=(f.diagnostics.read('calls',{limit:'1'}) as any).entries[0];
  assert.equal(initial.lane,'strategy');assert.equal(initial.outcome,'running');assert.equal(initial.prompt.available,true);assert.equal(initial.prompt.characters,value.prompt.length);
  f.store.save(f.state,'mode-hybrid-model-call',{...value,callId:'background-two'});
  f.store.save(f.state,'mode-hybrid-model-call',{...value,status:'completed',sentAt:'2026-10-27T00:00:01.000Z',finishedAt:'2026-10-27T00:00:03.000Z',durationMs:3000,queueWaitMs:1000,providerDurationMs:2000,output:{summary:'战略输出'},usage:result.usage,usageKnown:result.usageKnown});
  const page=f.diagnostics.read('calls',{limit:'1'}) as any;
  assert.equal(page.entries.length,1);assert.notEqual(page.entries[0].callRef,initial.callRef);assert.ok(page.nextCursor);
  const earlier=f.diagnostics.read('calls',{limit:'1',before:String(page.nextCursor)}) as any;
  assert.equal(earlier.entries.length,1);assert.equal(earlier.entries[0].callRef,initial.callRef);assert.equal(earlier.entries[0].outcome,'completed');assert.equal(earlier.entries[0].summary,'战略输出');assert.equal(earlier.entries[0].usage.totalTokens,14);assert.equal(earlier.nextCursor,null);
  const read=(kind:string,offset=0)=>f.diagnostics.read('content',{ref:String(initial.callRef),kind,offset:String(offset),limit:'32768'}) as any;
  for(const kind of ['prompt','reply','request']){const content=read(kind);assert.equal(content.available,true);assert.ok(content.text);}
  const detail=f.diagnostics.read('call',{ref:String(initial.callRef)}) as any;assert.equal(detail.providerDurationMs,2000);assert.equal(detail.queueWaitMs,1000);
  assert.equal(f.store.debugGetStrategyCall('other-room',0,initial.callRef,'mode-hybrid-model-call'),null);assert.equal(f.store.debugGetStrategyCall('room',1,initial.callRef,'mode-hybrid-model-call'),null);
  const filtered=f.diagnostics.read('calls',{from:String(Date.parse('2026-10-28T00:00:00Z'))}) as any;assert.equal(filtered.entries.length,0);
  f.store.save(f.state,'diagnostics-cleared',{});assert.equal((f.diagnostics.read('calls') as any).entries.length,0);assert.equal(read('prompt').available,false);
 }finally{f.store.close();}
});


test('hybrid failed replies preserve their precise reason, stage and redaction without losing valid returned output',()=>{
 const f=fixture();try{
  f.store.save(f.state,'mode-hybrid-model-call',{callId:'failure',status:'failed',kind:'diplomacy',queuedAt:'2026-10-27T00:00:00Z',finishedAt:'2026-10-27T00:00:01Z',prompt:'facts',output:result.reply,error:'双方确认缺少原文依据 old-seat-canary',failure:{stage:'validation',retryDelayMs:5000}});
  const call=(f.diagnostics.read('calls') as any).entries[0];
  assert.equal(call.outcome,'completed');assert.match(call.validationError,/双方确认缺少原文依据/);assert.ok(!call.validationError.includes('old-seat-canary'));assert.equal(call.failure.retryDelayMs,5000);assert.equal(call.toolError,call.validationError);
  f.store.save(f.state,'mode-hybrid-model-call',{callId:'provider-failure',status:'failed',finishedAt:'2026-10-27T00:00:02Z',output:null,error:'模型服务暂时不可用',failure:{stage:'provider',code:'transient',httpStatus:429,reason:'http-429'}});
  const provider=(f.diagnostics.read('calls') as any).entries[0];assert.equal(provider.outcome,'failed');assert.equal(provider.failure.httpStatus,429);assert.equal(provider.validationError,null);assert.match(provider.error,/暂时不可用/);
 }finally{f.store.close();}
});
