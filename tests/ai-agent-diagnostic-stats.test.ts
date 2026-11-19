import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {initialState,type AgentResult} from '../packages/ai/src/controller/contracts/types.js';
import {AgentDiagnostics,type DiagnosticStats} from '../packages/ai/src/controller/diagnostics/agent-diagnostics.js';
import {createDiagnosticRedactor} from '../packages/ai/src/application/agent-redactor.js';
import {decisionContextBreakdown} from '../packages/ai/src/controller/presentation/prompt-decision-breakdown.js';


// Seed an actual legacy row so bounded historical backfill remains verified even
// though new writes retain only summaries and precomputed composition metadata.
function legacyPrompt(store:AiStore,ref:number,prompt:string){
 const db=Reflect.get(store,'db') as import('node:sqlite').DatabaseSync;
 db.prepare("UPDATE diagnostic_calls SET payload=json_remove(json_set(payload,'$.promptText',?),'$.bodyRetention','$.promptDecisionBreakdown') WHERE call_ref=?").run(prompt,ref);
}

const reported:AgentResult={reply:{tool:'finish',arguments:{},summary:'private reply body'},tokens:14,usage:{inputTokens:10,outputTokens:4,cachedInputTokens:3},usageKnown:{provenance:'reported',input:true,output:true,cached:true}};
const context={total:100,sections:{policy:20,decisionContext:60,feedback:20},decisionContext:{total:60,sections:{outposts:40,chat:20}}};

test('429 statistics include historical hybrid and commander failures, paginate and isolate diagnostic scope',()=>{
 const store=new AiStore(':memory:'),state=initialState('rate-limit-room',0,{mode:'hybrid',model:'fake',personality:'schemer'});
 const diagnostics=()=>new AgentDiagnostics(store,state,createDiagnosticRedactor(()=>['private-canary']));
 try{
  store.save(state,'call-failed',{sequence:7,diagnostic:{provider:{httpStatus:429,evidence:{httpStatuses:[429,429]}},at:'2026-10-26T12:00:00Z',cause:{message:'private-canary'}}});
  store.save(state,'mode-hybrid-task-failed',{diagnostic:{httpStatus:429,evidence:{httpStatuses:[429,429],finishedAt:'2026-10-26T12:01:00Z'}}});
  store.save(state,'commander-call-failed',{diagnostic:{provider:{evidence:{httpStatuses:[429],finishedAt:'2026-10-26T12:02:00Z'}},error:{message:'private-canary'}}});
  store.save(state,'provider-retry',{diagnostic:{provider:{httpStatus:429}}});
  store.save(state,'error',{diagnostic:{provider:{httpStatus:429}}});
  store.save(state,'mode-hybrid-task-failed',{code:'transient',diagnostic:{reason:'rate-limit'}});
  store.save(state,'call-failed',{code:'timeout',diagnostic:{provider:{httpStatus:503}}});
  store.save({...state,lobbySeat:1},'mode-hybrid-task-failed',{diagnostic:{httpStatus:429}});
  store.save({...state,roomId:'other-room'},'call-failed',{diagnostic:{provider:{httpStatus:429}}});
  for(let i=0;i<105;i++)store.save(state,'mode-hybrid-task-failed',{diagnostic:{evidence:{httpStatuses:[429],finishedAt:'invalid-time'}},request:{prompt:'private-canary'}});
  const stats=diagnostics().read('stats') as DiagnosticStats;
  assert.deepEqual(stats.modelRateLimits,{total:108,byLane:{automatic:1,background:106,commander:1},lastAt:'2026-10-26T12:02:00.000Z',byRound:{7:1},unassigned:107});
  assert.ok(!JSON.stringify(stats).includes('private-canary'));
  assert.equal((diagnostics().read('stats') as DiagnosticStats).modelRateLimits.total,108,'a new diagnostics generation retains history');
  store.save(state,'diagnostics-cleared',{});
  assert.deepEqual((diagnostics().read('stats') as DiagnosticStats).modelRateLimits,{total:0,byLane:{automatic:0,background:0,commander:0},lastAt:null,byRound:{},unassigned:0});
  store.save(state,'mode-hybrid-task-failed',{diagnostic:{httpStatus:429}});
  assert.equal((diagnostics().read('stats') as DiagnosticStats).modelRateLimits.total,1);
 }finally{store.close();}
});

test('execution stats retain 50 whole rounds, classify incidents exclusively, redact reasons and isolate seats',()=>{
 const store=new AiStore(':memory:'),state=initialState('execution',0,{model:'fake',personality:'schemer'});
 const diagnostics=new AgentDiagnostics(store,state,createDiagnosticRedactor(()=>['private-canary']));
 try{
  for(let sequence=1;sequence<=55;sequence++){
   store.save(state,'started',{sequence});
   store.save(state,'call-failed',{sequence,step:0,code:'timeout',diagnostic:{cause:{message:'timeout private-canary'}}});
   store.save(state,'provider-retry',{sequence,step:0,attempt:1,code:'timeout'});
   store.save(state,'error',{phase:'model',diagnostic:{sequence},reason:'terminal timeout'});
   store.save(state,'tool-rejected',{id:`ai-0-${sequence}-1`,result:{error:'invalid arguments'}});
   store.save(state,'reply-superseded',{sequence,step:2,reason:'new important event'});
   store.save(state,'tool-result',{id:`ai-0-${sequence}-3`,result:{complete:false,results:[{error:'partial batch'}]}});
  }
  const other={...state,lobbySeat:1};store.save(other,'runtime-error',{sequence:999,reason:'other seat'});
  store.save(state,'recovery-started',{attempt:1});
  let stats=diagnostics.read('stats') as DiagnosticStats;
  assert.deepEqual(stats.executionRounds.map(r=>r.round),Array.from({length:50},(_,i)=>i+6));
  for(const round of stats.executionRounds){
   assert.equal(round.events.filter(e=>e.kind==='error').length,0);
   assert.equal(round.events.filter(e=>e.kind==='rework').length,round.round===55?2:3);
   assert.equal(round.events.filter(e=>e.kind==='retry').length,round.round===55?2:1);
   assert.ok(round.events.some(e=>e.reason.includes('invalid arguments')));
   assert.ok(round.events.some(e=>e.reason.includes('new important event')));
   assert.ok(round.events.some(e=>e.reason.includes('partial batch')));
   assert.equal(new Set(round.events.map(e=>e.id)).size,round.events.length,'one journal event cannot count in multiple categories');
  }
  assert.ok(!JSON.stringify(stats).includes('private-canary'));assert.ok(!JSON.stringify(stats).includes('other seat'));
  store.save(state,'diagnostics-cleared',{});
  stats=diagnostics.read('stats') as DiagnosticStats;assert.deepEqual(stats.executionRounds,[]);
  store.save(state,'started',{sequence:56});store.save(state,'runtime-error',{sequence:56,reason:'lease failed'});
  stats=diagnostics.read('stats') as DiagnosticStats;assert.equal(stats.executionRounds[0]!.events[0]!.reason,'lease failed');
 }finally{store.close();}
});
test('execution retry replaces only its triggering failure, keeps terminal errors and unrelated rework',()=>{
 const store=new AiStore(':memory:'),state=initialState('exclusive',0,{model:'fake',personality:'schemer'});
 const diagnostics=new AgentDiagnostics(store,state,createDiagnosticRedactor(()=>[]));
 try{
  const save=(kind:string,payload:object={})=>store.save(state,kind,payload);
  save('started',{sequence:1});
  save('tool-rejected',{id:'ai-0-1-0',result:{error:'fix arguments'}});
  save('call-reserved',{sequence:1,step:1});
  save('call-failed',{sequence:1,step:1,code:'timeout'});
  save('error',{phase:'model',diagnostic:{sequence:1},reason:'terminal timeout'});
  // The matching recovery can be on the next compact metrics page.
  for(let n=0;n<94;n++)save('tool-result',{id:'ai-0-1-1',result:{ok:true}});
  save('runtime-error',{sequence:1,reason:'lease failed'});
  save('recovery-started',{attempt:1});
  save('call-reserved',{sequence:1,step:2});
  save('tool-result',{id:'ai-0-1-2',result:{ok:true}});
  save('recovery-started',{attempt:2});
  save('started',{sequence:2});
  save('observation-error',{diagnostic:{sequence:2},reason:'unrecovered observation'});
  const stats=diagnostics.read('stats') as DiagnosticStats;
  const first=stats.executionRounds[0]!.events;
  assert.equal(first.filter(e=>e.kind==='error').length,1);
  assert.equal(first.filter(e=>e.kind==='rework').length,1);
  assert.equal(first.filter(e=>e.kind==='retry').length,2);
  assert.ok(first.some(e=>e.kind==='retry'&&e.reason.includes('lease failed')));
  assert.ok(first.some(e=>e.kind==='error'&&e.reason==='timeout'));
  assert.equal(first.filter(e=>e.reason==='lease failed'&&e.kind==='error').length,0);
  assert.equal(stats.executionRounds[1]!.events[0]!.kind,'error');
  assert.equal(new Set(first.map(e=>e.id)).size,first.length);
 }finally{store.close();}
});
function fixture(store=new AiStore(':memory:'),room='room',seat=0){
  const state=initialState(room,seat,{model:'fake',personality:'schemer'}),diagnostics=new AgentDiagnostics(store,state,createDiagnosticRedactor(()=>['private-canary']));
  const add=(round:number,step=0,options:{prompt?:string;context?:unknown;result?:AgentResult;legacy?:boolean}={})=>{
    state.sequence=round;
    store.save(state,'call-reserved',{sequence:round,step,attempt:0,startedAt:100,promptContext:options.context??context,promptTools:{results:{total:{observe:12}}}});
    if(options.legacy)return;
    const handle=diagnostics.beginCall({model:'fake',prompt:options.prompt??'private prompt body private-canary',signal:new AbortController().signal})!;
    assert.ok(handle);diagnostics.finishCall(handle,options.result??reported);handle.record.durationMs=step;
    store.debugPutCall(room,seat,handle.record.callRef,handle.record);
    return handle;
  };
  const stats=()=>JSON.parse(JSON.stringify(diagnostics.read('stats'))) as DiagnosticStats;
  return {store,state,diagnostics,add,stats};
}

test('stats limits the chart to complete latest50 rounds and composition to complete latest10, not calls/pages',()=>{
  const f=fixture();try{
    for(let round=1;round<=55;round++)for(let step=0;step<4;step++)f.add(round,step);
    const stats=f.stats();
    assert.equal(stats.calls,220);
    assert.deepEqual(stats.rounds.map(row=>row.round),Array.from({length:50},(_,i)=>i+6));
    assert.ok(stats.rounds.every(row=>row.calls.length===4&&row.calls.every(call=>call.round===row.round)));
    assert.ok(stats.rounds.every(row=>row.calls.map(c=>c.step).join(',')==='0,1,2,3'));
    assert.equal(stats.composition.all.calls,220);assert.equal(stats.composition.all.total,22000);
    assert.equal(stats.composition.recent.calls,40);assert.equal(stats.composition.recent.total,4000);
    assert.deepEqual(stats.composition.recent.sections,{policy:800,decisionContext:2400,feedback:800});
    // Historical estimates cannot be promoted into exact tool-return lengths.
    // This fixture has neither the original result body nor saved exact ranges.
    assert.deepEqual(stats.composition.recent.toolReturns,{unavailable:800});
    assert.deepEqual(stats.composition.recent.decisionContext,{total:2400,sections:{outposts:1600,chat:800},coveredCalls:40});
    assert.deepEqual(stats.duration,{totalMs:330,measuredCalls:220});
    assert.equal(stats.unassignedCalls,0);
    assert.ok(!JSON.stringify(stats).match(/private prompt|private reply|private-canary|promptText|promptHash|captureGeneration/));
  }finally{f.store.close();}
});

test('stats covers empty, fewer than10 and exactly30 rounds without padding or truncating calls',()=>{
  for(const count of [0,1,7,10,30]){
    const f=fixture();try{
      for(let round=1;round<=count;round++)for(let step=0;step<3;step++)f.add(round,step);
      const stats=f.stats();
      assert.equal(stats.rounds.length,count);assert.equal(stats.calls,count*3);
      assert.equal(stats.composition.all.calls,count*3);assert.equal(stats.composition.recent.calls,Math.min(count,10)*3);
      assert.equal(stats.duration.measuredCalls,count*3);assert.equal(stats.duration.totalMs,count*3);
      assert.equal(stats.unassignedCalls,0);
    }finally{f.store.close();}
  }
});

test('stats preserves unknown usage, explicit zero, legacy coverage and unattributed calls',()=>{
  const f=fixture();try{
    f.add(1,0,{result:{reply:reported.reply,tokens:0,usage:{inputTokens:0,outputTokens:0},usageKnown:{provenance:'reported',input:true,output:true,cached:false}}});
    f.add(1,1,{result:{...reported,usageKnown:{provenance:'reported',input:false,output:true,cached:false}}});
    f.add(2,0,{legacy:true});
    f.store.save(f.state,'call-reserved',{step:0});
    const stats=f.stats(),calls=stats.rounds.flatMap(r=>r.calls);
    assert.equal(stats.calls,4);assert.equal(stats.unassignedCalls,1);
    assert.deepEqual(calls[0]!.usage,{inputTokens:0,outputTokens:0,cachedInputTokens:null,totalTokens:0,provenance:'reported'});
    assert.deepEqual(calls[1]!.usage,{inputTokens:null,outputTokens:4,cachedInputTokens:null,totalTokens:null,provenance:'reported'});
    assert.deepEqual(calls[2]!.usage,{inputTokens:null,outputTokens:null,cachedInputTokens:null,totalTokens:null,provenance:'legacy-unknown'});
    assert.equal(calls[2]!.durationMs,null);
    assert.equal(stats.duration.measuredCalls,2);assert.equal(stats.composition.all.calls,2);
    assert.equal(stats.composition.recent.calls,2);
  }finally{f.store.close();}
});

test('stats backfills exact historical detail read-only and preserves mismatched or invalid coverage as unavailable',()=>{
  const f=fixture();try{
    const prompt='prefix\n当前受限情报及新消息：'+JSON.stringify({chat:[{text:'saved history'}]})+'\n本轮行动与回执（按执行顺序）：[]\n';
    const detail=decisionContextBreakdown(prompt)!;
    const a=f.add(1,0,{prompt,context:{total:prompt.length,sections:{decisionContext:detail.total}}})!;
    f.add(2,0,{prompt,context:{total:prompt.length,sections:{decisionContext:detail.total+1}}});
    f.add(3,0,{context:{sections:{policy:10,decisionContext:10},decisionContext:{total:10,sections:{chat:11}}}});
    const before=JSON.stringify(f.store.debugGetCall('room',0,a.record.callRef)),stats=f.stats();
    assert.deepEqual(stats.composition.all.decisionContext,{total:detail.total*2+11,sections:{...detail.sections,unavailable:detail.total+11},coveredCalls:1});
    assert.equal(stats.composition.all.total,prompt.length*2+20,'missing total falls back to measured sections');
    assert.equal(JSON.stringify(f.store.debugGetCall('room',0,a.record.callRef)),before);
    assert.ok(!JSON.stringify(stats).includes('saved history'));
  }finally{f.store.close();}
});

test('stats never reuse results across seats, rooms, generation changes, appended calls or clear',()=>{
  const f=fixture(),seat=fixture(f.store,'room',1),room=fixture(f.store,'other-room',0);
  try{
    f.add(1);seat.add(50);seat.add(51);room.add(99);
    const first=f.stats();assert.equal(first.calls,1);assert.deepEqual(first.rounds.map(r=>r.round),[1]);
    assert.equal(seat.stats().calls,2);assert.deepEqual(room.stats().rounds.map(r=>r.round),[99]);
    f.add(2);assert.equal(f.stats().calls,2);
    assert.throws(()=>f.diagnostics.read('stats',{generation:seat.diagnostics.generation}));
    const restarted=new AgentDiagnostics(f.store,f.state,v=>v);
    assert.throws(()=>restarted.read('stats',{generation:first.generation}));
    assert.equal((restarted.read('stats') as DiagnosticStats).calls,2);
    f.store.save(f.state,'notebook-set',{id:'retained',kind:'fact',text:'keep notebook',updatedAt:0,expiresAt:null});
    f.store.clearDiagnosticCalls('room',0);
    const cleared=f.stats();assert.equal(cleared.calls,0);assert.equal(cleared.rounds.length,0);assert.equal(cleared.composition.all.total,0);assert.equal(cleared.duration.measuredCalls,0);
    assert.equal(f.store.debugRows('room',0,{kinds:['notebook-set']}).entries.length,1);
    assert.equal(seat.stats().calls,2);assert.equal(room.stats().calls,1);
    f.add(3);assert.equal(f.stats().calls,1);
    for(const query of [{limit:'30'},{before:'1'},{round:'1'},{room:'other-room'},{seat:'1'}])assert.throws(()=>f.diagnostics.read('stats',query));
  }finally{f.store.close();}
});

test('large stats scans use compact bounded pages, avoid full call records, and cap historical prompt backfill',()=>{
  const f=fixture();try{
    const prompt='当前受限情报及新消息：'+JSON.stringify({chat:[{text:'history '.repeat(500)}]})+'\n本轮行动与回执（按执行顺序）：[]\n';
    const detail=decisionContextBreakdown(prompt)!;
    const historicalRefs:number[]=[];
    for(let round=1;round<=240;round++)for(let step=0;step<5;step++){const handle=f.add(round,step,{prompt,context:round%2?context:{total:prompt.length,sections:{decisionContext:detail.total}}})!;historicalRefs.push(handle.record.callRef);}
    // Seed the legacy archive after modern writes finish. Otherwise normal body
    // retention correctly compacts these injected rows before the read-only scan.
    for(const ref of historicalRefs)legacyPrompt(f.store,ref,prompt);
    let pages=0,backfills=0,bytes=0;
    const originalPage=f.store.debugStatsRows.bind(f.store),originalPrompt=f.store.debugStatsPrompt.bind(f.store);
    f.store.debugStatsRows=(room,seat,before,limit)=>{const page=originalPage(room,seat,before,limit);pages++;assert.ok(page.entries.length<=100);assert.ok(!JSON.stringify(page).includes('history history'));return page;};
    f.store.debugStatsPrompt=(room,seat,ref,budget)=>{backfills++;const value=originalPrompt(room,seat,ref,budget);bytes+=Buffer.byteLength(value??'');return value;};
    f.store.debugGetCall=()=>{throw Error('Stats must not load full diagnostic records');};
    f.store.debugCallTrail=()=>{throw Error('Stats must not query irrelevant call trails');};
    const started=performance.now(),stats=f.stats(),elapsed=performance.now()-started;
    assert.equal(stats.calls,1200);assert.equal(stats.rounds.length,50);assert.equal(stats.rounds.flatMap(r=>r.calls).length,250);
    assert.equal(stats.composition.all.calls,1200);assert.equal(stats.composition.recent.calls,50);
    assert.equal(pages,12);assert.equal(backfills,30);assert.ok(bytes<=4194304);
    assert.equal(stats.composition.all.decisionContext.coveredCalls,630);
    assert.equal(stats.composition.all.decisionContext.sections.unavailable,570*detail.total);
    assert.ok(elapsed<10000,`compact aggregate regression took ${elapsed.toFixed(0)}ms`);
  }finally{f.store.close();}
});

test('historical prompt backfill has a byte cap as well as a call cap',()=>{
  const f=fixture();try{
    const prompt='当前受限情报及新消息：'+JSON.stringify({chat:[{text:'x'.repeat(600000)}]})+'\n本轮行动与回执（按执行顺序）：[]\n',detail=decisionContextBreakdown(prompt)!;
    for(let round=1;round<=10;round++){const handle=f.add(round,0,{prompt,context:{total:prompt.length,sections:{decisionContext:detail.total}}})!;legacyPrompt(f.store,handle.record.callRef,prompt);}
    let bytes=0,calls=0;const read=f.store.debugStatsPrompt.bind(f.store);
    f.store.debugStatsPrompt=(room,seat,ref,budget)=>{calls++;const text=read(room,seat,ref,budget);bytes+=Buffer.byteLength(text??'');return text;};
    const stats=f.stats();
    assert.ok(bytes<=4194304);assert.equal(calls,6);assert.equal(stats.composition.all.decisionContext.coveredCalls,6);
    assert.equal(stats.composition.all.decisionContext.sections.unavailable,detail.total*4);
    assert.equal(stats.composition.all.calls,10);
  }finally{f.store.close();}
});

test('stats retain every call in long recent rounds without the generic redactor traversal cap',()=>{
  const f=fixture();try{
    for(let step=0;step<1600;step++)f.add(1,step);
    const stats=f.stats();
    assert.equal(stats.calls,1600);assert.equal(stats.rounds.length,1);assert.equal(stats.rounds[0]!.calls.length,1600);
    assert.equal(stats.composition.recent.calls,1600);assert.equal(stats.composition.all.total,160000);
  }finally{f.store.close();}
});

test('stats use one coherent database snapshot while another connection appends a round',()=>{
  const directory=mkdtempSync(join(tmpdir(),'agent-stats-')),path=join(directory,'test.sqlite'),f=fixture(new AiStore(path)),writer=fixture(new AiStore(path));
  try{
    for(let round=1;round<=101;round++)f.add(round);
    const read=f.store.debugStatsRows.bind(f.store);let inserted=false;
    f.store.debugStatsRows=(room,seat,before,limit)=>{
      const page=read(room,seat,before,limit);
      if(!inserted){inserted=true;writer.add(102);}
      return page;
    };
    const before=f.stats(),after=f.stats();
    assert.equal(before.calls,101);assert.equal(before.rounds.at(-1)!.round,101);assert.equal(before.composition.all.calls,101);
    assert.equal(after.calls,102);assert.equal(after.rounds.at(-1)!.round,102);assert.equal(after.composition.all.calls,102);
  }finally{f.store.close();writer.store.close();rmSync(directory,{recursive:true,force:true});}
});
