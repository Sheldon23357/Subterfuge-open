import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {initialState,type AiSnapshot,type AgentRequest,type ModelResult as AgentResult} from '../packages/ai/src/controller/contracts/types.js';
import {HybridBackground} from '../plugins/hybrid/src/background.js';
import {initialHybridState,type HybridState,type StrategicAssessment} from '../plugins/hybrid/src/contracts.js';
import {ModelCallQueue} from '../packages/ai/src/controller/runtime/model-queue.js';
import {ProviderError} from '../packages/ai/src/controller/contracts/provider-error.js';
import {readPromptMaterial} from '../packages/contracts/src/prompt-sections.js';
const turn=()=>new Promise<void>(r=>setImmediate(r));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
const answer:StrategicAssessment={summary:'守住核心据点并扩张',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],message:null,agreement:{status:'none',summary:'',forbidAttack:false,forbiddenTargets:[],internalIntent:'',expiresWorldDay:null}};
const result=():import('../packages/ai/src/controller/contracts/types.js').ModelResult=>({tokens:5,usage:{inputTokens:3,outputTokens:2},usageKnown:{provenance:'reported',input:true,output:true,cached:false},reply:{summary:answer.summary,tasks:{upsert:[],cancel:[]},reviewOn:[]}});
function fixture(queue:ModelCallQueue,provider:(r:AgentRequest)=>Promise<AgentResult>,effort:'low'|'high'='low'){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'hybrid-queue');
 const state=initialState(o.roomId,0,{mode:'hybrid',model:'test',personality:'schemer',reasoningEffort:effort,serviceTier:'fast'});state.enabled=true;
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:o.view.playerCount};
 const saved=new Map<string,unknown>(),events:{kind:string;payload:Record<string,unknown>}[]=[];let now=1000,wakes=0;
 const background=new HybridBackground({state,latest:<T>(key:string)=>saved.get(key) as T|undefined,record:(kind,payload)=>{saved.set(kind,structuredClone(payload));events.push({kind,payload:structuredClone(payload)});},wake:()=>{wakes++;},model:{step:request=>queue.run(request.signal,()=>provider(request),{fairnessKey:'seat',beforeSend:request.beforeSend!,onStart:request.onSend!})}},()=>now);
 return {background,state,snapshot,saved,events,wakes:()=>wakes,advance:(ms:number)=>{now+=ms;}};
}

test('background reuses stable strategy and diplomatic conversation scopes across new calls and ticks',async()=>{
 const requests:AgentRequest[]=[],f=fixture(new ModelCallQueue(1),async r=>{requests.push(r);return result();});
 f.snapshot.chat=[{id:'scope-1',from:1,to:0,text:'讨论边界',tick:0,sentAt:0}];
 try{
  f.background.observe(f.snapshot);await f.background.drain();await turn();
  f.advance(300001);f.snapshot.observation.view.tick+=10;
  f.snapshot.chat.push({id:'scope-2',from:1,to:0,text:'继续讨论边界',tick:10,sentAt:0});
  f.background.observe(f.snapshot);await f.background.drain();await turn();
  const strategy=requests.filter(r=>r.audit?.kind==='strategy'),diplomacy=requests.filter(r=>r.audit?.kind==='diplomacy');
  assert.ok(strategy.length>=2);assert.ok(diplomacy.length>=2);
  for(const r of strategy)assert.deepEqual(r.providerSessionScope,{kind:'strategy',task:'overview'});
  for(const r of diplomacy)assert.deepEqual(r.providerSessionScope,{kind:'diplomacy',task:'1'});
  assert.equal(new Set(requests.map(r=>r.audit?.callId)).size,requests.length);
 }finally{f.background.pause();await f.background.drain();}
});

test('summary-only publications remain durable without repeatedly waking foreground',async()=>{
 let calls=0;
 const f=fixture(new ModelCallQueue(1),async()=>{const value=result();(value.reply as Record<string,unknown>).summary='strategy wording '+(++calls);return value;});
 try{
  f.background.observe(f.snapshot);await f.background.drain();await turn();
  const wakes=f.wakes();assert.ok(calls>0);
  f.advance(300001);f.snapshot.observation.view.tick+=10;
  f.background.observe(f.snapshot);await f.background.drain();await turn();
  assert.ok(calls>=2);assert.equal(f.wakes(),wakes);
  assert.ok(f.events.some(e=>e.kind==='foreground-update'&&e.payload.changed===false));
  assert.match((f.saved.get('state') as HybridState).directive!.summary,/strategy wording/);
 }finally{f.background.pause();await f.background.drain();}
});

test('only a published model result consumes receipts; the following round keeps current state without replaying old events',async()=>{
 const requests:AgentRequest[]=[],f=fixture(new ModelCallQueue(1),async r=>{requests.push(r);return result();});
 f.snapshot.observation.diplomacy!.receipts=Array.from({length:20},(_,i)=>({id:i,time:i,players:[0,1] as [number,number],agreementId:null,kind:'trust-changed',actor:1,details:{from:0,to:1,before:i,after:i+1}}));
 f.snapshot.observation.diplomacy!.receiptCount=20;
 try{
  f.background.observe(f.snapshot);await f.background.drain();await turn();
  const first=readPromptMaterial(requests[0]!.prompt);assert.equal(first.guidance.contractResults.rows.length,20);
  assert.equal((f.saved.get('state') as HybridState).receiptDelivery!['strategy:overview']!.count,20);
  f.advance(300001);f.snapshot.observation.view.tick+=10;f.background.observe(f.snapshot);await f.background.drain();await turn();
  const next=requests.map(r=>readPromptMaterial(r.prompt)).filter(b=>b.kind==='strategy').at(-1)!;
  assert.deepEqual(next.guidance.contractResults,[]);assert.ok(next.global.relations,'current authoritative relationships remain present');
 }finally{f.background.pause();await f.background.drain();}
});

test('superseded results cannot acknowledge receipts even after the provider returned successfully',async()=>{
 const hold=deferred(),f=fixture(new ModelCallQueue(1),async()=>{await hold.promise;return result();});
 f.snapshot.observation.diplomacy!.receipts=[{id:10,time:0,players:[0,1],agreementId:null,kind:'agreement-ended',actor:null,details:{reason:'test'}}];f.snapshot.observation.diplomacy!.receiptCount=1;
 try{
  f.background.observe(f.snapshot);await turn();f.state.commanderDirectives={version:1,text:'新的完整指挥官要求'};hold.resolve();await f.background.drain();
  assert.equal((f.saved.get('state') as HybridState).receiptDelivery?.['strategy:overview'],undefined);
  assert.ok(f.events.some(e=>e.kind==='model-call'&&e.payload.status==='superseded'));
 }finally{hold.resolve();f.background.pause();await f.background.drain();}
});

test('a removed query field cannot consume receipts or schedule a follow-up',async()=>{
 let calls=0;const f=fixture(new ModelCallQueue(1),async()=>{calls++;const r=result();(r.reply as any).needsInformation=['FAR'];return r;});
 f.snapshot.observation.diplomacy!.receipts=[{id:10,time:0,players:[0,1],agreementId:null,kind:'trust-changed',actor:1,details:{from:0,to:1,before:0,after:1}}];f.snapshot.observation.diplomacy!.receiptCount=1;
 try{
  f.background.observe(f.snapshot);await f.background.drain();
  assert.equal(calls,1);assert.ok(f.events.some(e=>e.kind==='model-call'&&e.payload.status==='failed'));
  assert.equal((f.saved.get('state') as HybridState).receiptDelivery?.['strategy:overview'],undefined);
 }finally{f.background.pause();await f.background.drain();}
});

test('background queue waiting has no model deadline; each effort gets its full provider allowance after admission',async t=>{
 // If the old pre-admission AbortSignal.timeout is reintroduced, expire it immediately.
 const deadlines:number[]=[];t.mock.method(AbortSignal,'timeout',(ms:number)=>{deadlines.push(ms);return AbortSignal.abort(new DOMException('expired','TimeoutError'));});
 for(const effort of ['low','high'] as const){
  const queue=new ModelCallQueue(1),hold=deferred(),occupying=queue.run(new AbortController().signal,()=>hold.promise);
  const received:AgentRequest[]=[];const f=fixture(queue,async r=>{received.push(r);return result();},effort);
  try{
   f.background.observe(f.snapshot);await turn();f.advance(240000);
   assert.ok((f.saved.get('state') as HybridState).tasks.some(t=>t.status==='queued'));
   assert.equal(received.length,0);hold.resolve();await occupying;await turn();await turn();
   assert.ok(received.length>=1);assert.equal(received[0]!.signal.aborted,false);
   assert.equal(received[0]!.timeoutMs,effort==='high'?300000:120000);assert.equal(received[0]!.serviceTier,'fast');
   assert.ok((f.saved.get('state') as HybridState).directive);
  }finally{hold.resolve();f.background.pause();await f.background.drain();}
 }
 assert.deepEqual(deadlines,[]);
});

test('background inherits existing priority after exact name resolution and audits normalization with original reply',async()=>{
 const f=fixture(new ModelCallQueue(1),async()=>{
  const value=result();
  value.reply={summary:'maintain focus',tasks:{upsert:[{id:'intent-1',task:{kind:'capture',target:name,until:150,reason:'same goal'}}],cancel:[]},reviewOn:[]};
  return value;
 });
 const enemy=f.snapshot.observation.view.outposts.find(p=>p.owner===1)!,name=f.snapshot.observation.outpostNames![enemy.id]!;
 const initial=initialHybridState();initial.intents=[{id:'intent-1',version:1,spec:{kind:'capture',target:enemy.id,priority:73,until:200,reason:'original'},authority:'model',commanderVersion:0,status:'pending',reason:'',createdAt:0,updatedAt:0}];initial.intentSerial=1;
 f.saved.set('state',initial);
 try{
  f.background.observe(f.snapshot);await turn();await turn();
  const call=f.events.find(e=>e.kind==='model-call'&&e.payload.status==='completed')!.payload;
  assert.deepEqual(call.normalizations,[{path:'tasks.upsert[0].task.priority',rule:'inherit-priority',value:73}]);
  assert.equal((call.output as any).tasks.upsert[0].task.priority,undefined);
  const saved=f.saved.get('state') as HybridState;assert.equal((saved.intents![0]!.spec as any).priority,73);assert.equal(saved.intents![0]!.spec.until,150);
  assert.equal(f.events.filter(e=>e.kind==='task-failed').length,0);
 }finally{f.background.pause();await f.background.drain();}
});

test('stale background requests are rejected before provider dispatch and do not retry old commander authority',async()=>{
 const queue=new ModelCallQueue(1),hold=deferred(),occupying=queue.run(new AbortController().signal,()=>hold.promise);let sent=0;
 const f=fixture(queue,async()=>{sent++;return result();});
 try{
  f.background.observe(f.snapshot);await turn();f.state.commanderDirectives={version:1,text:'新的已确认指挥'};
  hold.resolve();await occupying;await turn();await turn();
  assert.equal(sent,0);assert.ok(f.events.some(e=>e.kind==='task-skipped'&&e.payload.sent===false));
  assert.equal(f.events.filter(e=>e.kind==='task-failed').length,0);
 }finally{hold.resolve();f.background.pause();await f.background.drain();}
});

test('pause cancels queued background work without calling the provider or leaking queue tickets',async()=>{
 const queue=new ModelCallQueue(1),hold=deferred(),occupying=queue.run(new AbortController().signal,()=>hold.promise);let sent=0;
 const f=fixture(queue,async()=>{sent++;return result();});
 f.background.observe(f.snapshot);await turn();assert.ok(queue.status.waiting>0);
 f.background.pause();await f.background.drain();assert.equal(queue.status.waiting,0);assert.equal(sent,0);
 hold.resolve();await occupying;assert.equal(queue.status.active,0);
});

test('provider timeout records separate queue and execution timings, typed source and transport evidence',async()=>{
 const f=fixture(new ModelCallQueue(1),async()=>{f.advance(120000);throw new ProviderError('timeout','provider-call',{stage:'process-exit',outcome:'unknown',timeoutMs:120000});});
 try{
  f.background.observe(f.snapshot);await turn();await turn();
  const failed=f.events.find(e=>e.kind==='task-failed')!.payload;
  const call=f.events.find(e=>e.kind==='model-call'&&e.payload.status==='failed')!.payload;
  assert.ok(call.prompt);assert.equal(call.output,null);assert.equal(call.tokens,null);assert.equal(call.providerDurationMs,120000);assert.deepEqual(call.failure,{stage:'provider',code:'timeout',timeoutSource:'provider-call',reason:null,httpStatus:null,providerStage:'process-exit',outputBytes:null,contentCharacters:null,finishReason:null,truncated:null,retryDelayMs:5000});
  assert.equal(failed.stage,'provider');assert.equal(failed.timeoutSource,'provider-call');assert.equal(failed.providerDurationMs,120000);
  assert.equal((failed.diagnostic as {outcome:string}).outcome,'unknown');
  assert.ok(f.events.some(e=>e.kind==='task-dispatched'&&e.payload.timeoutMs===120000));
 }finally{f.background.pause();await f.background.drain();}
});

test('four seats receive fair queue turns while the reserved commander channel remains available',async()=>{
 const queue=new ModelCallQueue(3,1),holds:ReturnType<typeof deferred>[]=[],order:string[]=[],pending:Promise<void>[]=[];
 for(const seat of ['5','5','6','6','7','7','8','8']){
  const hold=deferred();holds.push(hold);pending.push(queue.run(new AbortController().signal,async()=>{order.push(seat);await hold.promise;},{fairnessKey:seat}));
 }
 await turn();assert.deepEqual(order,['5','6']);
 let discussed=false;await queue.run(new AbortController().signal,async()=>{discussed=true;},{interactive:true});assert.equal(discussed,true);
 for(const index of [0,2,4,6]){holds[index]!.resolve();await turn();}
 assert.deepEqual(order.slice(2,6),['7','8','5','6']);
 for(const hold of holds)hold.resolve();await Promise.all(pending);assert.equal(queue.status.waiting,0);assert.equal(queue.status.active,0);
});

test('explicit larger capacity admits eight hybrid calls concurrently and shrinking capacity drains existing work',async()=>{
 let capacity=9;const queue=new ModelCallQueue(()=>capacity,1),hold=deferred();let sent=0;
 const work=Array.from({length:8},(_,i)=>queue.run(new AbortController().signal,async()=>{sent++;await hold.promise;},{fairnessKey:String(i)}));
 await turn();assert.equal(sent,8);assert.deepEqual(queue.status,{limit:9,active:8,waiting:0});
 capacity=3;
 let extra=false;const pending=queue.run(new AbortController().signal,async()=>{extra=true;},{fairnessKey:'new-seat'});
 await turn();assert.equal(extra,false);assert.equal(queue.status.active,8);
 hold.resolve();await Promise.all(work);await pending;assert.equal(extra,true);assert.equal(queue.status.active,0);
 assert.equal(new ModelCallQueue(32,1).limit,32);
 assert.throws(()=>new ModelCallQueue(33),/1 to 32/);
});

test('one bot shares a single slot between background and commander calls while other bots remain parallel',async()=>{
 const queue=new ModelCallQueue(5,1),hold=deferred();let discussion=false,other=false;
 const automatic=queue.run(new AbortController().signal,()=>hold.promise,{fairnessKey:'ai-05'});
 const pending=queue.run(new AbortController().signal,async()=>{discussion=true;},{fairnessKey:'ai-05',interactive:true});
 await queue.run(new AbortController().signal,async()=>{other=true;},{fairnessKey:'ai-06'});
 assert.equal(other,true);assert.equal(discussion,false);assert.equal(queue.status.active,1);
 hold.resolve();await automatic;await pending;assert.equal(discussion,true);
 await assert.rejects(queue.run(new AbortController().signal,async()=>{throw Error('provider failure');},{fairnessKey:'ai-05'}));
 await queue.run(new AbortController().signal,async()=>{},{fairnessKey:'ai-05'});
 assert.equal(queue.status.active,0);
});

test('hybrid submits only one background request at a time even when the global queue has spare capacity',async()=>{
 const queue=new ModelCallQueue(5,1),hold=deferred();let sent=0;
 const f=fixture(queue,async()=>{sent++;await hold.promise;return result();});
 try{f.background.observe(f.snapshot);await turn();assert.equal(sent,1);assert.equal(queue.status.waiting,0);}
 finally{f.background.pause();hold.resolve();await f.background.drain();}
});

test('actual rate limiting backs off the shared queue and successful calls gradually restore capacity',async t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);
 const queue=new ModelCallQueue(9,1);
 await assert.rejects(queue.run(new AbortController().signal,async()=>{throw new ProviderError('transient',undefined,{stage:'process-exit',httpStatus:429,reason:'rate-limit',outcome:'unknown'});}));
 assert.equal(queue.limit,5);assert.equal(queue.status.rateLimit?.retryAt,31000);
 const controller=new AbortController();let sent=false;
 const waiting=queue.run(controller.signal,async()=>{sent=true;});const cancelled=assert.rejects(waiting);
 await turn();assert.equal(sent,false);controller.abort();await cancelled;
 now=32000;
 await queue.run(new AbortController().signal,async()=>{});await queue.run(new AbortController().signal,async()=>{});
 assert.equal(queue.limit,6);
 for(let i=0;i<6;i++)await queue.run(new AbortController().signal,async()=>{});
 assert.equal(queue.limit,9);assert.equal(queue.status.rateLimit,undefined);
});

test('repeated rate limits extend cooldown by wave and recovery probes serialize all lanes',async t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);
 const queue=new ModelCallQueue(5,1);
 queue.reportRateLimit();assert.equal(queue.status.rateLimit?.retryAt,31000);
 now=2000;queue.reportRateLimit();assert.equal(queue.status.rateLimit?.retryAt,32000);
 now=33000;queue.reportRateLimit();assert.equal(queue.status.rateLimit?.retryAt,93000);
 now=94000;queue.reportRateLimit();assert.equal(queue.status.rateLimit?.retryAt,214000);
 now=215000;queue.reportRateLimit();assert.equal(queue.status.rateLimit?.retryAt,455000);
 now=456000;queue.reportRateLimit();assert.equal(queue.status.rateLimit?.retryAt,756000);
 now=757000;const hold=deferred();let discussed=false;
 const probe=queue.run(new AbortController().signal,()=>hold.promise);
 const discussion=queue.run(new AbortController().signal,async()=>{discussed=true;},{interactive:true});
 await turn();assert.equal(queue.status.active,1);assert.equal(discussed,false);
 hold.resolve();await probe;await discussion;assert.equal(discussed,true);
 // Two successes reset the exponential delay as well as restoring capacity.
 queue.reportRateLimit();assert.equal(queue.status.rateLimit?.retryAt,787000);
});


test('background call details retain exact model material, usage and separate provider timing',async()=>{
 const f=fixture(new ModelCallQueue(1),async r=>{f.advance(1500);return result();});
 try{
  f.background.observe(f.snapshot);await turn();await turn();
  const calls=f.events.filter(e=>e.kind==='model-call').map(e=>e.payload);
  const queued=calls.find(c=>c.status==='queued')!,done=calls.find(c=>c.status==='completed')!;
  assert.ok(queued);assert.ok(done);assert.equal(queued.callId,done.callId);
  assert.match(String(done.prompt),/简报/);assert.ok(done.responseSchema);
  assert.deepEqual(done.output,result().reply);assert.deepEqual(done.usage,result().usage);
  assert.equal(done.providerDurationMs,1500);assert.equal(done.tokens,5);
  assert.equal(done.sent,true);assert.ok(done.sentAt);assert.ok(done.finishedAt);
 }finally{f.background.pause();await f.background.drain();}
});

test('cancelled queued calls retain context without fabricating output or token usage',async()=>{
 const queue=new ModelCallQueue(1),hold=deferred(),occupying=queue.run(new AbortController().signal,()=>hold.promise);
 const f=fixture(queue,async()=>result());
 try{
  f.background.observe(f.snapshot);await turn();f.background.pause();await f.background.drain();
  const done=f.events.find(e=>e.kind==='model-call'&&e.payload.status==='cancelled')!.payload;
  assert.equal(done.sent,false);assert.equal(done.sentAt,null);assert.equal(done.tokens,null);assert.equal(done.output,null);assert.ok(done.prompt);
 }finally{hold.resolve();await occupying;}
});
