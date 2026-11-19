import {ProviderError} from '../packages/ai/src/controller/contracts/provider-error.js';
import {readPromptMaterial} from '../packages/contracts/src/prompt-sections.js';
import {isConfirmedContinuation,defaultNonAggressionDeadline,settleDiplomacyMessage,reconcileDiplomacy} from '../plugins/hybrid/src/diplomacy-execution.js';
import {test} from 'node:test';
import {AiStore,SeatRunner,PlayerGateway} from '../packages/ai/src/index.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {advanceRoom} from '../packages/server/src/planning.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {initialState,validateSettings,type AiSnapshot,type AgentRequest,type AgentResult} from '../packages/ai/src/controller/contracts/types.js';
import {resolveReferenceBotMode} from '../packages/ai/src/reference.js';
import {HybridBackground} from '../plugins/hybrid/src/background.js';
import {diplomacyNeeds,updateDiplomacyPressure,diplomacyPeers} from '../plugins/hybrid/src/diplomacy-pressure.js';
import {canInitiateDiplomacy,pressureReviewKey,recordDiplomacyReview} from '../plugins/hybrid/src/diplomacy-review.js';
import type {TacticalFeedback,DiplomacyNeed} from '../plugins/hybrid/src/contracts.js';
import {initialHybridState,basisOf,HYBRID_PROMPT_CHARACTERS,type HybridState,type StrategicAssessment,type OperationState} from '../plugins/hybrid/src/contracts.js';
import {namedBrief} from '../plugins/hybrid/src/model-names.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';
import {jointAttackGuidance} from '../plugins/hybrid/src/joint-attack.js';
import {assessmentSchema,parseAssessment} from '../plugins/hybrid/src/assessment.js';
import {constraints,reconcileOperations,operationGuidance} from '../plugins/hybrid/src/operations.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {planBot,tacticalGuidanceAllows} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {computeBot} from '../packages/ai/src/controller/analysis/tactical-worker.js';
import {closeBotForecastPool} from '../packages/ai/src/controller/analysis/tactical-forecast-pool.js';
import {OpenAICompatibleProvider} from '../packages/ai/src/application/providers/openai-compatible.js';
import {parseModelJson} from '../packages/ai/src/controller/contracts/model-json.js';
const assessment=(patch:Partial<StrategicAssessment>={}):StrategicAssessment=>({summary:'保持经济并寻找可持续扩张',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:['ownership-changed'],message:null,agreement:{status:'none',summary:'',forbidAttack:false,forbiddenTargets:[],internalIntent:'',expiresWorldDay:null},...patch});
function intentWire(a:StrategicAssessment,kind:string){return {summary:a.summary,tasks:a.intentEdits??{upsert:[],cancel:[]},reviewOn:a.reviewOn,...(kind==='commander'?{constraints:{forbiddenPlayers:a.forbiddenPlayers,protectedSources:a.protectedSources,reserves:a.reserves}}:kind==='diplomacy'?{message:a.message,agreement:{...a.agreement,fulfillment:a.agreement.fulfillment??(a.agreement.status!=='confirmed'?'none':a.agreement.forbidAttack||a.agreement.forbiddenTargets.length||a.agreement.jointAttack?'rules':'message'),jointAttack:a.agreement.jointAttack??null}}:{})};}
function addRemote(o:ReturnType<typeof observation>,visible=false){const remote={id:'remote-information',owner:1,type:'factory' as const,position:{x:9,y:9},visibility:visible?2 as const:0 as const};o.view.outposts.push(remote);o.outpostNames={...o.outpostNames,[remote.id]:'远端资料'};return remote;}
function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;setup.match={mode:'mining',neptuniumGoal:200};
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'hybrid-test');
 const state=initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'});state.enabled=true;
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:o.view.playerCount,roster:Array.from({length:o.view.playerCount},(_,p)=>({gamePlayer:p,chatPlayer:p}))};
 return {o,state,snapshot,routes:attackRoutes(o,{attackTicks:144,localTicks:144,holdTicks:24})};
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('brief dispatch separates role exclusions from the canonical contract guard and receipt consumption fence',()=>{
 const f=fixture(),saved=initialHybridState(),id='p1-'+ 'e'.repeat(64),own=f.o.view.outposts.find(p=>p.owner===0)!,peer=f.o.view.outposts.find(p=>p.owner===1)!;
 f.snapshot.roster=[{gamePlayer:0,chatPlayer:7,displayName:'ME'},{gamePlayer:1,chatPlayer:9,displayName:'PEER'}];
 f.o.diplomacy!.agreements.push({id,players:[1,0],terms:{kind:'ceasefire',outposts:[own.id,peer.id]},subsidy:null,proposedAt:f.o.view.tick,startedAt:null,deadline:f.o.view.tick+24,status:'proposed',progress:[0,0],fulfilled:[false,false],reason:null,endedAt:null});
 f.o.diplomacy!.receiptCount=4;
 saved.receiptDelivery={'strategy:overview':{roomId:f.o.roomId,player:0,count:3,lastId:1,unavailable:1}};
 const savedBefore=structuredClone(saved),material=makeBrief({id:'role-test',kind:'strategy',scope:'overview',posts:[],players:[],messageIds:[]},f.state,f.snapshot,saved),model=readPromptMaterial(material.prompt);
 const canonical=material.brief.guidance as any,current=model.guidance.serverAgreements.current.ceasefire;
 assert.ok(canonical.serverAgreements.columns.includes('allowedActions'),'canonical guard retains precise proposal permissions');
 assert.equal(canonical.receiptCoverage.previousPublicationSourceCount,3);
 assert.equal(model.guidance.receiptCoverage.previousPublicationSourceCount,undefined);
 assert.equal(model.guidance.receiptCoverage.unavailableBeforeWindow,canonical.receiptCoverage.unavailableBeforeWindow);
 assert.ok(!current.columns.includes('allowedActions'));assert.ok(!current.columns.includes('inConversation'));
 assert.deepEqual(model.global.roster.columns,['gamePlayer','name']);
 assert.equal(material.contextSelection.version,'round-material/9');
 assert.ok(material.contextSelection.excluded.some(x=>x.reason==='program-audit'));
 assert.deepEqual(saved,savedBefore,'formatting never acknowledges or mutates receipt delivery');
 assert.equal(material.receiptDelivery.count,4,'actual source fence remains available for validated publication');
 assert.ok(!material.prompt.includes('previousPublicationSourceCount'),'the exclusion audit itself is not model input');
});
test('omitted non-aggression deadlines default to 100 world days without rolling extensions',()=>{
 for(const patch of [{forbidAttack:true},{forbiddenTargets:['a']}]){
  const raw=assessment({agreement:{...assessment().agreement,status:'proposed',...patch}}).agreement;
  const next=defaultNonAggressionDeadline(raw,undefined,815.5);
  assert.equal(next.expiresWorldDay,915.5);assert.equal(raw.expiresWorldDay,null);
  const current={...next,conversation:'1',players:[1],evidence:[],tick:815.5};
  assert.equal(defaultNonAggressionDeadline({...raw,status:'confirmed'},current,825).expiresWorldDay,915.5,'confirmation retains the proposal deadline');
  assert.equal(defaultNonAggressionDeadline({...raw,expiresWorldDay:950},current,825).expiresWorldDay,950,'explicit deadlines are preserved');
  assert.equal(defaultNonAggressionDeadline(raw,current,916).expiresWorldDay,1016,'new agreement after expiry gets a new deadline');
 }
 const information={...assessment().agreement,status:'confirmed' as const};
 assert.equal(defaultNonAggressionDeadline(information,undefined,815).expiresWorldDay,null);
 assert.equal(defaultNonAggressionDeadline({...information,forbidAttack:true,status:'terminated'},undefined,815).expiresWorldDay,null);
});
function pressureFeedback(f:ReturnType<typeof fixture>,needs:DiplomacyNeed[]):TacticalFeedback{return {basis:basisOf(f.o),strategyVersion:0,coverage:{complete:false},objects:[],proposals:[],selected:'hold',limitations:[],diplomacyNeeds:needs};}
function defenseNeed(f:ReturnType<typeof fixture>):DiplomacyNeed{return {id:'defense:'+f.o.view.outposts.find(p=>p.owner===0)!.id,kind:'defense-pressure',targets:[f.o.view.outposts.find(p=>p.owner===0)!.id],opponents:[1],evidence:{actualIncoming:[{id:'attack',owner:1,drillers:300}],arrivalShortfall:200},limits:['静态缺口不证明无法防守']};}
function backgroundFixture(){const f=fixture(),records=new Map<string,unknown>(),calls:Record<string,any>[]=[],requests:{request:AgentRequest;resolve:(r:import('../packages/ai/src/controller/contracts/types.js').ModelResult<unknown>)=>void;reject:(e:unknown)=>void}[]=[];let now=100000;
 const background=new HybridBackground({state:f.state,latest:<T>(k:string)=>records.get(k) as T|undefined,record:(k,v)=>{records.set(k,structuredClone(v));if(k==='model-call')calls.push(structuredClone(v));},wake:()=>{},model:{step:request=>new Promise((resolve,reject)=>{requests.push({request,resolve,reject});request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})}},()=>now);
 const reply=(i:number,a=assessment())=>requests[i]!.resolve({tokens:5,usage:{inputTokens:3,outputTokens:2},usageKnown:{provenance:'reported',input:true,output:true,cached:false},reply:namedBrief(intentWire(a,readPromptMaterial(requests[i]!.request.prompt).kind),f.o)});
 return {...f,background,requests,records,calls,reply,advance:(ms:number)=>{now+=ms;}};
}

for(const invalid of [false,true])test(`commander ${invalid?'invalid captured edit stays failed':'valid edit whose authority expires is rebuilt from current facts'}`,async()=>{
 const f=backgroundFixture(),target=f.o.view.outposts.find(p=>p.owner===0)!.id,baseTick=f.o.view.tick;
 const task={kind:'configure' as const,target,until:baseTick+1,priority:50,minDrillers:5,maxDrillers:null,maintain:true,reason:'Existing model guard'};
 f.records.set('state',{...initialHybridState(),intentSerial:1,intents:[{id:'intent-1',version:1,spec:task,authority:'model',commanderVersion:0,status:'pending',reason:'Existing',createdAt:0,updatedAt:0}]});
 f.state.commanderDirectives={version:1,text:'复核并保留己方守备'};
 try{
  f.background.observe(f.snapshot);assert.equal(readPromptMaterial(f.requests[0]!.request.prompt).kind,'commander');
  assert.ok((readPromptMaterial(f.requests[0]!.request.prompt).facts as any).permissions.editableTaskIds.includes('intent-1'));
  const next=structuredClone(f.snapshot);next.observation.view.tick=baseTick+2;next.observation.revision='task-expired';f.background.observe(next);
  f.reply(0,assessment({intentEdits:{upsert:[{id:invalid?'never-authorized':'intent-1',task:{...task,until:baseTick+50,minDrillers:10}}],cancel:[]}}));await turn();await turn();
  const commander=f.requests.map((r,i)=>({i,brief:readPromptMaterial(r.request.prompt)})).filter(r=>r.brief.kind==='commander');
  if(invalid){assert.equal(commander.length,1);assert.ok(f.calls.some(c=>c.kind==='commander'&&c.status==='failed'));}
  else{
   assert.equal(commander.length,2,JSON.stringify({calls:f.calls.map(c=>({kind:c.kind,status:c.status,error:c.error})),skipped:f.records.get('task-skipped'),failed:f.records.get('task-failed'),captured:(commander[0]!.brief.facts as any).permissions.editableTaskIds}));assert.ok(!(commander[1]!.brief.facts as any).permissions.editableTaskIds.includes('intent-1'));
   assert.ok(f.calls.some(c=>c.kind==='commander'&&c.status==='stale-dependency'));assert.ok(!f.records.has('task-failed'));
   f.reply(commander[1]!.i,assessment({intentEdits:{upsert:[{id:null,task:{...task,until:baseTick+50,minDrillers:10}}],cancel:[]}}));await turn();await turn();
   const saved=f.records.get('state') as HybridState;assert.equal(saved.directive?.commanderVersion,1);assert.ok(saved.intents?.some(t=>t.id!=='intent-1'&&t.authority==='commander'));
  }
 }finally{f.background.pause();await f.background.drain();}
});

test('an expired edit in a completed commander part rebuilds all parts before atomic publication',async()=>{
 const f=backgroundFixture(),base=f.o.view.tick,target=f.o.view.outposts.find(p=>p.owner===0)!.id;
 const task={kind:'configure' as const,target,until:base+1,priority:50,minDrillers:5,maxDrillers:null,maintain:true,reason:'Existing guard'};
 f.records.set('state',{...initialHybridState(),intentSerial:1,intents:[{id:'intent-1',version:1,spec:task,authority:'model',commanderVersion:0,status:'pending',reason:'Existing',createdAt:base,updatedAt:base}]});
 f.state.commanderDirectives={version:1,text:'保护己方据点。'.repeat(800)};
 assert.ok(f.state.commanderDirectives.text.length>5000&&f.state.commanderDirectives.text.length<=6000);
 const reply=(index:number,id:string|null)=>f.reply(index,assessment({intentEdits:{upsert:[{id,task:{...task,until:base+50,minDrillers:10}}],cancel:[]}}));
 try{
  f.background.observe(f.snapshot);reply(0,'intent-1');await turn();await turn();
  assert.equal(readPromptMaterial(f.requests[1]!.request.prompt).kind,'commander');
  const next=structuredClone(f.snapshot);next.observation.view.tick=base+2;next.observation.revision='part-expired';f.background.observe(next);
  f.reply(1);await turn();await turn();
  assert.ok(f.calls.some(c=>c.status==='stale-dependency'));assert.equal(readPromptMaterial(f.requests[2]!.request.prompt).kind,'commander');
  reply(2,null);await turn();await turn();f.reply(3);await turn();await turn();
  const saved=f.records.get('state') as HybridState;assert.equal(saved.directive?.commanderVersion,1);assert.ok(!f.records.has('task-failed'));
 }finally{f.background.pause();await f.background.drain();}
});

test('hybrid call journal retains failure evidence without malformed provider text',async()=>{
 const f=fixture(),records=new Map<string,unknown>(),raw='{"summary": incomplete';
 const provider=new OpenAICompatibleProvider({apiKey:'synthetic-audit-key',baseUrl:'https://example.test/v1',apiStyle:'chat',fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:raw},finish_reason:'stop'}]}))});
 const background=new HybridBackground({state:f.state,latest:<T>(k:string)=>records.get(k) as T|undefined,record:(k,v)=>{records.set(k,structuredClone(v));},wake:()=>{},model:{step:request=>{request.onSend?.(0);return provider.step(request);}}});
 try{
  background.observe(f.snapshot);await turn();await turn();
  const call=records.get('model-call') as Record<string,any>;
  assert.equal(call.status,'failed');assert.equal(call.output,null);assert.equal(call.sent,true);
  assert.equal(call.rawOutput,undefined);assert.equal(call.failure.contentCharacters,raw.length);assert.ok(!JSON.stringify(call).includes(raw));
  assert.equal((records.get('state') as HybridState).directive,null,'invalid text never publishes a directive');
 }finally{background.pause();await background.drain();}
});

async function diplomacyRequest(f:ReturnType<typeof backgroundFixture>){
 const index=f.requests.findIndex(r=>readPromptMaterial(r.request.prompt).kind==='diplomacy');
 if(index>=0)return index;
 const pending=f.requests.length-1;
 assert.equal(readPromptMaterial(f.requests[pending]!.request.prompt).kind,'strategy');
 f.reply(pending);await turn();await turn();
 const next=f.requests.findIndex(r=>readPromptMaterial(r.request.prompt).kind==='diplomacy');
 assert.ok(next>=0);return next;
}

test('background keeps strategy and diplomacy FIFO while commander work retains priority',async()=>{
 const f=backgroundFixture(),kind=(i:number)=>readPromptMaterial(f.requests[i]!.request.prompt).kind;
 try{
  f.background.observe(f.snapshot);assert.equal(kind(0),'strategy');
  f.snapshot.chat=[{id:'fifo-1',from:1,to:0,text:'讨论边界',tick:0,sentAt:0}];
  f.background.observe(f.snapshot);
  f.o.view.outposts.find(p=>p.owner===0)!.type='mine';
  f.background.observe(f.snapshot);f.reply(0);await turn();await turn();
  assert.equal(kind(1),'diplomacy','older incoming evidence keeps its queue position');
  f.snapshot.chat.push({id:'fifo-2',from:1,to:0,text:'补充边界情报',tick:0,sentAt:1});
  f.background.observe(f.snapshot);f.reply(1);await turn();await turn();
  assert.equal(kind(2),'strategy','new conversation revisions must not keep jumping ahead of waiting strategy');
  f.state.commanderDirectives={version:1,text:'保护己方矿场'};
  f.background.observe(f.snapshot);f.reply(2);await turn();await turn();
  assert.equal(kind(3),'commander');
 }finally{f.background.pause();await f.background.drain();}
});

test('undated spoken acceptance never creates or renews a formal server ceasefire',async()=>{
 const f=backgroundFixture();f.o.view.tick=815;f.o.secondsSinceLastTick=300;
 f.snapshot.chat=[{id:'undated-offer',from:1,to:0,text:'我们互不攻击，交换敌情。',tick:815,sentAt:0}];
 try{
  f.background.observe(f.snapshot);
  const i=await diplomacyRequest(f);
  f.reply(i,assessment({message:'同意，到第915.5天互不攻击。',agreement:{...assessment().agreement,status:'confirmed',fulfillment:'rules',forbidAttack:true}}));
  await turn();await turn();
  const saved=f.records.get('state') as HybridState,m=saved.messages.find(m=>m.messageIds.includes('undated-offer'))!;
  assert.ok(m);assert.equal(m.agreement.expiresWorldDay,null);
  assert.deepEqual(saved.directive!.agreements,[]);assert.deepEqual(f.o.diplomacy!.agreements,[]);
  f.o.view.tick=825;settleDiplomacyMessage(saved,m.id,'accepted',f.o);
  assert.deepEqual(saved.directive!.agreements,[]);
  f.o.view.tick=915;reconcileDiplomacy(saved,f.o);
  assert.deepEqual(saved.directive!.agreements,[]);assert.deepEqual(constraints(saved.directive,f.o,saved).forbiddenPlayers,[]);
 }finally{f.background.pause();await f.background.drain();}
});

test('hybrid is the only builtin mode and does not infer a strategy from the provider',()=>{
 assert.throws(()=>resolveReferenceBotMode({model:'x',personality:'schemer',provider:'programmatic'}));
 assert.equal(resolveReferenceBotMode({model:'x',personality:'schemer',provider:'codex'}).id,'hybrid');
 assert.equal(resolveReferenceBotMode({model:'',personality:'schemer',provider:'offline'}).id,'hybrid');
 for(const mode of ['model','programmatic'])assert.throws(()=>resolveReferenceBotMode(validateSettings({mode,model:'x',personality:'schemer'})));
 assert.equal(resolveReferenceBotMode(validateSettings({mode:'hybrid',model:'x',personality:'schemer',provider:'codex'})).id,'hybrid');
 assert.throws(()=>resolveReferenceBotMode(validateSettings({mode:'invented',model:'x',personality:'schemer'})));
});

test('semantic provider contract is isolated from executable game tool envelopes',()=>{
 const a=assessment();const r=parseModelJson(JSON.stringify(a));assert.deepEqual(parseAssessment(r,2,new Set()),a);
 assert.deepEqual(parseModelJson(JSON.stringify(a)),a);assert.throws(()=>parseAssessment({...a,unexpected:true},2,new Set()));assert.throws(()=>parseAssessment({...a,forbiddenPlayers:[-1]},2,new Set()));
});

test('short brief includes unknowns, source identities, public intelligence and commander authority',()=>{
 const f=fixture();f.state.commanderDirectives={version:2,text:'不得攻击红方矿场'};
 const {brief,prompt}=makeBrief({id:'test',kind:'strategy',scope:'test',posts:f.o.view.outposts.slice(0,5).map(p=>p.id),messageIds:[],players:[]},f.state,f.snapshot,initialHybridState());
 assert.ok(prompt.length<HYBRID_PROMPT_CHARACTERS);assert.equal(brief.basis.commanderVersion,2);assert.ok(brief.unknowns.length);assert.ok(JSON.stringify(brief).includes('不得攻击'+f.o.outpostNames!['红方矿场']));assert.ok(JSON.stringify(brief).includes('identities'));
});



test('default context provides visible remote core facts without a query catalog',()=>{
 const f=fixture(),remote=addRemote(f.o,true),m=makeBrief({id:'default',kind:'strategy',scope:'overview',posts:[],messageIds:[],players:[]},f.state,f.snapshot,initialHybridState());
 const b=readPromptMaterial(m.prompt),t=b.global.identities,row=t.rows.find((r:any[])=>r[0]===f.o.outpostNames![remote.id]);
 assert.ok(row);for(const key of ['owner','type','drillers','shield'])assert.ok(t.columns.includes(key));
 assert.ok(!t.columns.includes('visibility'));assert.equal(b.facts.requestedInformation,undefined);assert.equal(b.facts.requestableInformation,undefined);
 assert.equal((m.responseSchema as any).properties.needsInformation,undefined);assert.equal(assessmentSchema.properties.summary.maxLength,1500);
 assert.throws(()=>parseAssessment(assessment({reviewOn:['x'.repeat(121)]}),2,new Set()),/Invalid review conditions/);
});

test('frozen observations do not duplicate initial, periodic or newly published strategy jobs',async()=>{
 const f=backgroundFixture();f.background.observe(f.snapshot);const initial=f.requests.length;
 for(let i=0;i<5;i++)f.background.observe(f.snapshot);assert.equal(f.requests.length,initial);
 const scopes:string[]=[];let replied=0;
 for(let i=0;i<30;i++){
  while(replied<f.requests.length){const request=f.requests[replied]!.request,brief=readPromptMaterial(request.prompt);scopes.push(brief.scope);f.reply(replied++,assessment({summary:brief.scope==='overview'?'GLOBAL':'LOCAL',reviewOn:[brief.scope]}));}
  await turn();f.background.observe(f.snapshot);
 }
 assert.equal((f.records.get('state') as HybridState).directive!.summary,'GLOBAL');assert.ok(scopes.every(scope=>(f.records.get('state') as HybridState).directive!.reviewOn.includes(scope)));assert.ok(scopes.includes('overview'));assert.equal(new Set(scopes).size,scopes.length,JSON.stringify(scopes));
 assert.ok((f.records.get('state') as HybridState).tasks.every(t=>t.status==='completed'));
 f.advance(300001);f.snapshot.observation.view.tick+=9;f.background.observe(f.snapshot);assert.equal(f.requests.length,initial,'nine world days do not start a periodic review');
 f.snapshot.observation.view.tick++;f.background.observe(f.snapshot);const started=f.requests.length;assert.equal(started,initial+1,'ten world days start a periodic review');
 for(let i=0;i<5;i++)f.background.observe(f.snapshot);assert.equal(f.requests.length,started);
 f.background.pause();await f.background.drain();
});

test('tactical hold changes and ordinary mining do not supersede an in-flight strategic review',async()=>{
 const f=backgroundFixture();
 try{
  f.background.observe(f.snapshot);assert.equal(f.requests.length,1);
  f.records.set('feedback',pressureFeedback(f,[]));f.background.observe(f.snapshot);
  f.records.set('feedback',{...pressureFeedback(f,[]),selected:'capture:target'});f.background.observe(f.snapshot);
  f.o.intel[0]!.neptunium=21;f.background.observe(f.snapshot);
  f.reply(0);await turn();await turn();
  assert.equal(f.requests.length,1);assert.equal((f.records.get('state') as HybridState).tasks[0]!.status,'completed');
 }finally{f.background.pause();await f.background.drain();}
});

test('ordinary strategic changes coalesce until both cooldown clocks expire',async()=>{
 const f=backgroundFixture();
 try{
  f.background.observe(f.snapshot);f.reply(0);await turn();await turn();
  f.o.intel[0]!.npPerDay+=1;f.background.observe(f.snapshot);assert.equal(f.requests.length,1);
  f.advance(120001);f.background.observe(f.snapshot);assert.equal(f.requests.length,1,'wall time alone is insufficient');
  f.o.view.tick+=11;f.background.observe(f.snapshot);assert.equal(f.requests.length,1);
  f.o.intel[0]!.npPerDay+=1;f.o.view.tick++;f.background.observe(f.snapshot);assert.equal(f.requests.length,2);
  assert.equal((f.records.get('strategy-trigger') as {reason:string}).reason,'coalesced-change');
  f.reply(1);await turn();await turn();assert.equal(f.requests.length,2);
 }finally{f.background.pause();await f.background.drain();}
});

test('hostile approach changes coalesce on a short review interval while gifts do not',async()=>{
 const f=backgroundFixture();
 try{
  f.background.observe(f.snapshot);f.reply(0);await turn();await turn();
  const target=f.o.view.outposts.find(p=>p.owner===0)!;
  f.o.view.fleets.push({id:'gift',owner:1,drillers:10,state:'underway',gift:true,position:target.position,destination:{kind:'outpost',id:target.id}});
  f.background.observe(f.snapshot);assert.equal(f.requests.length,1);
  f.o.view.fleets.push({id:'hostile',owner:1,drillers:30,state:'underway',gift:false,position:target.position,destination:{kind:'outpost',id:target.id}});
  f.background.observe(f.snapshot);assert.equal(f.requests.length,1,'an individual arrival does not supersede a recent strategy');
  f.advance(20001);f.o.view.tick+=2;f.background.observe(f.snapshot);assert.equal(f.requests.length,2);
  assert.equal((f.records.get('strategy-trigger') as {reason:string}).reason,'threat-change');
 }finally{f.background.pause();await f.background.drain();}
});

test('removed information requests fail validation without an additional model call',async()=>{
 const f=backgroundFixture();f.background.observe(f.snapshot);
 try{
  const value={...intentWire(assessment(),'strategy'),needsInformation:['ANYWHERE']};
  f.requests[0]!.resolve({tokens:5,reply:value});
  await turn();await turn();
  assert.equal(f.requests.length,1);assert.equal((f.records.get('state') as HybridState).tasks[0]!.status,'failed');
 }finally{f.background.pause();await f.background.drain();}
});

test('background restores a permission-catalog fleet alias before publishing while retaining exact model output in audit',async()=>{
 const f=backgroundFixture(),id='p0-'+ 'c'.repeat(64),own=f.o.view.outposts.find(p=>p.owner===0)!,enemy=f.o.view.outposts.find(p=>p.owner===1)!;
 f.o.view.fleets.push({id,owner:0,position:{...own.position},drillers:6,state:'moving',gift:false,source:own.id,destination:{kind:'outpost',id:enemy.id},canReturn:true,returned:false});
 try{
  f.background.observe(f.snapshot);const req=f.requests[0]!.request,alias='F1-CCCCCCCC';
  assert.ok(JSON.stringify(readPromptMaterial(req.prompt).facts.permissions).includes(alias));assert.ok(!JSON.stringify(req.responseSchema).includes(alias));
  f.requests[0]!.resolve({tokens:5,reply:{summary:'撤回在途兵力',tasks:[{kind:'return-fleet',fleetId:alias,until:f.o.view.tick+50}],cancel:[],reviewOn:[]}});
  await turn();await turn();
  const saved=f.records.get('state') as HybridState,task=saved.intents!.find(t=>t.spec.kind==='return-fleet')!;
  assert.ok(task);assert.equal((task.spec as {fleetId:string}).fleetId,id);
  const call=f.records.get('model-call') as any;assert.equal(call.modelReferences[alias],id);assert.equal(call.output.tasks[0].fleetId,alias);
 }finally{f.background.pause();await f.background.drain();}
});

test('all background roles shorten departed fleet event identities while retaining the canonical brief',()=>{
 const f=fixture(),own=f.o.view.outposts.find(p=>p.owner===0)!,peer=f.o.view.outposts.find(p=>p.owner===1)!,retired='p0-'+ 'e'.repeat(64);
 f.o.activity=[{id:4,kind:'departed',tick:f.o.view.tick,seconds:0,actor:0,subject:retired,source:own.id,destination:{kind:'outpost',id:peer.id},drillers:1,enabled:null}];
 for(const kind of ['strategy','diplomacy','commander'] as const){
  const m=makeBrief({id:'event-alias-'+kind,kind,scope:'overview',posts:[own.id],players:[],messageIds:[]},f.state,f.snapshot,initialHybridState());
  const decoded=readPromptMaterial(m.prompt),activity=decoded.changes.activity;
  assert.equal(activity.rows[0][activity.columns.indexOf('subject')],'F1-EEEEEEEE',kind);
  assert.equal(m.modelReferences['F1-EEEEEEEE'],retired);
  const full=m.brief.changes as any;assert.equal(full.activity.rows[0][full.activity.columns.indexOf('subject')],retired,'canonical publication material remains exact');
  assert.ok(!m.prompt.includes(retired),'full mapping is audit-only');
 }
});

test('a strategic round preserves simultaneous review reasons instead of choosing one model problem',async()=>{
 const f=backgroundFixture();
 try{
  f.background.observe(f.snapshot);f.reply(0);await turn();await turn();
  f.advance(300001);f.o.view.tick+=1000;
  const own=f.o.view.outposts.find(p=>p.owner===0)!;own.type=own.type==='mine'?'factory':'mine';
  f.background.observe(f.snapshot);await turn();
  const material=readPromptMaterial(f.requests.at(-1)!.request.prompt),reasons=material.changes.triggers.map((t:any)=>t.reason);
  assert.equal(material.kind,'strategy');assert.ok(reasons.includes('periodic'));assert.ok(reasons.includes('critical-change'));assert.ok(reasons.length>=2);
 }finally{f.background.pause();await f.background.drain();}
});

test('background restores a formal proposal alias without changing current-conversation permission checks',async()=>{
 const f=backgroundFixture(),id='p1-'+ 'd'.repeat(64),own=f.o.view.outposts.find(p=>p.owner===0)!,peer=f.o.view.outposts.find(p=>p.owner===1)!;
 f.o.diplomacy!.agreements.push({id,players:[1,0],terms:{kind:'ceasefire',outposts:[own.id,peer.id]},subsidy:null,proposedAt:f.o.view.tick,startedAt:null,deadline:f.o.view.tick+24,status:'proposed',progress:[0,0],fulfilled:[false,false],reason:null,endedAt:null});
 f.o.diplomacy!.agreementCount++;
 f.snapshot.chat=[{id:'short-proposal-message',from:1,to:0,tick:f.o.view.tick,sentAt:0,text:'请核对当前正式停战提案'}];
 try{
  f.background.observe(f.snapshot);const i=await diplomacyRequest(f),alias='A2-DDDDDDDD';
  assert.ok(JSON.stringify(readPromptMaterial(f.requests[i]!.request.prompt).facts.permissions).includes(alias));
  f.requests[i]!.resolve({tokens:5,reply:{summary:'接受当前停战',tasks:[],cancel:[],reviewOn:[],action:'accept',agreementId:alias}});
  await turn();await turn();
  const saved=f.records.get('state') as HybridState,command=saved.contractCommands!.find(c=>c.action.kind==='respond-agreement')!;
  assert.ok(command);assert.equal((command.action as {agreementId:string}).agreementId,id);assert.equal(command.conversation,'1');
 }finally{f.background.pause();await f.background.drain();}
});

test('accepting an own proposal discards the whole reply and does not retry unchanged conversation evidence',async()=>{
 const f=backgroundFixture(),own=f.o.view.outposts.find(p=>p.owner===0)!,peer=f.o.view.outposts.find(p=>p.owner===1)!;
 f.o.diplomacy!.agreements.push({id:'own-proposal',players:[0,1],terms:{kind:'ceasefire',outposts:[own.id,peer.id]},subsidy:null,proposedAt:f.o.view.tick,startedAt:null,deadline:f.o.view.tick+24,status:'proposed',progress:[0,0],fulfilled:[false,false],reason:null,endedAt:null});
 f.snapshot.chat=[{id:'peer-consent',from:1,to:0,text:'同意现有条款。',tick:f.o.view.tick,sentAt:0}];
 try{
  f.background.observe(f.snapshot);const i=await diplomacyRequest(f);
  assert.ok(!readPromptMaterial(f.requests[i]!.request.prompt).facts.permissions.diplomacy.responses[0].actions.includes('accept'));
  f.requests[i]!.resolve({tokens:5,reply:{summary:'错误地接受自己的提案',tasks:[],cancel:[],reviewOn:[],action:'accept',agreementId:'own-proposal',message:'这段未经校验的正文不能发送'}});
  await turn();await turn();
  const count=f.requests.length,saved=f.records.get('state') as HybridState;
  assert.equal(saved.tasks.find(t=>t.id==='diplomacy-1')!.status,'failed');
  assert.equal(saved.contractCommands?.length??0,0);assert.equal(saved.messages.length,0);
  assert.ok(!saved.handledMessages?.includes('peer-consent'),'failed publication does not consume the evidence');
  for(const delay of [5001,30001,60001]){f.advance(delay);f.background.observe(f.snapshot);await turn();await turn();assert.equal(f.requests.length,count);}
 }finally{f.background.pause();await f.background.drain();}
});

test('invalid semantic replies are discarded without a repair prompt or another paid attempt',async()=>{
 const f=backgroundFixture();
 try{
  f.background.observe(f.snapshot);f.reply(0,assessment({summary:null} as any));await turn();
  let replied=1;
  for(let i=0;i<30;i++){while(replied<f.requests.length)f.reply(replied++);await turn();}
  const count=f.requests.length;
  for(const delay of [5001,30001,60001]){f.advance(delay);f.background.observe(f.snapshot);await turn();await turn();assert.equal(f.requests.length,count);}
  assert.equal((f.records.get('state') as HybridState).tasks.find(t=>t.id==='overview')!.status,'failed');
  assert.ok(f.requests.every(r=>!r.request.prompt.includes('Invalid information request')));
  assert.ok(!(f.records.get('model-call') as Record<string,any>).failure?.retryDelayMs);
 }finally{f.background.pause();await f.background.drain();}
});

for(const code of ['invalid-response','transient'] as const)test(`background provider ${code} ${code==='invalid-response'?'is dropped':'retains transport retry'}`,async()=>{
 const f=backgroundFixture();
 try{
  f.background.observe(f.snapshot);f.requests[0]!.reject(new ProviderError(code,undefined,{stage:code==='invalid-response'?'parse-response':'provider-http',outcome:code==='invalid-response'?'completed':'rejected'}));await turn();await turn();
  let replied=1;
  for(let i=0;i<20;i++){while(replied<f.requests.length)f.reply(replied++);await turn();}
  const count=f.requests.length;
  f.advance(5001);f.background.observe(f.snapshot);await turn();await turn();
  assert.equal(f.requests.length,count+(code==='transient'?1:0));
  if(code==='transient'){
   assert.equal(readPromptMaterial(f.requests.at(-1)!.request.prompt).facts.validationError,undefined);
   assert.doesNotMatch(f.requests.at(-1)!.request.prompt,/上一份回复|格式纠错/);
   f.reply(f.requests.length-1);await turn();await turn();
  }
 }finally{f.background.pause();await f.background.drain();}
});

test('one background call runs at a time; pause drains and rejects late publication',async()=>{
 const f=backgroundFixture();f.background.observe(f.snapshot);assert.equal(f.requests.length,1);f.advance(30001);assert.equal(f.requests.length,1);
 assert.ok(f.requests.every(x=>x.request.prompt.length<=HYBRID_PROMPT_CHARACTERS));f.background.pause();await f.background.drain();assert.equal(f.background.settling,false);assert.equal((f.records.get('state') as HybridState).directive,null);
});

test('one strategic review publishes without scheduling redundant sector calls',async()=>{
 const f=backgroundFixture();f.background.observe(f.snapshot);const i=f.requests.findIndex(x=>x.request.prompt.includes('"kind":"strategy"'));assert.ok(i>=0);f.reply(i);await turn();
 const saved=f.records.get('state') as HybridState;assert.ok(saved.directive);assert.equal(f.requests.length,1);assert.ok(saved.tasks.every(t=>!t.id.startsWith('sector-')));f.background.pause();await f.background.drain();
});

test('invalid commander interpretation remains unapplied without automatic retry; a new version can be translated',async()=>{
 const f=backgroundFixture(),target=f.o.view.outposts.find(p=>p.owner!==0)!;
 f.state.commanderDirectives={version:1,text:'不要攻击'+f.o.outpostNames![target.id]};
 let answered=0,commanders=0;
 const settle=async(succeed=false)=>{for(let i=0;i<40;i++){while(answered<f.requests.length){const at=answered++,brief=readPromptMaterial(f.requests[at]!.request.prompt);
  if(brief.kind==='commander'){commanders++;f.reply(at,succeed?assessment():assessment({summary:null} as any));}
  else f.reply(at);
 }await turn();}};
 try{
  f.background.observe(f.snapshot);await settle();assert.equal(commanders,1);
  for(const delay of [5001,30001,60001]){f.advance(delay);f.background.observe(f.snapshot);await settle();assert.equal(commanders,1);}
  assert.notEqual((f.records.get('state') as HybridState).directive?.commanderVersion,1);
  f.state.commanderDirectives={version:2,text:f.state.commanderDirectives.text};
  f.background.observe(f.snapshot);await settle(true);assert.equal(commanders,2);
  assert.equal((f.records.get('state') as HybridState).directive?.commanderVersion,2);
 }finally{f.background.pause();await f.background.drain();}
});

test('new commander version invalidates in-flight old interpretation',async()=>{
 const f=backgroundFixture();f.state.commanderDirectives={version:1,text:'留守蓝方工厂'};f.background.observe(f.snapshot);
 const i=f.requests.findIndex(x=>x.request.prompt.includes('"kind":"commander"'));assert.ok(i>=0);
 f.state.commanderDirectives={version:2,text:'不要攻击'};f.background.observe(f.snapshot);f.reply(i,assessment({protectedSources:[f.o.view.outposts[0]!.id]}));await turn();
 assert.notEqual((f.records.get('state') as HybridState).directive?.commanderVersion,1);f.background.pause();await f.background.drain();
});

test('long commander interpretation is split and no partial constraints become authoritative',async()=>{
 const f=backgroundFixture();f.state.commanderDirectives={version:1,text:'保护核心据点。'.repeat(1500)};f.background.observe(f.snapshot);
 assert.equal(f.requests.length,1);assert.ok(f.requests.every(x=>x.request.prompt.length<=HYBRID_PROMPT_CHARACTERS));f.reply(0);await turn();assert.equal(f.requests.length,2);assert.notEqual((f.records.get('state') as HybridState).directive?.commanderVersion,1);
 f.background.pause();await f.background.drain();
});

test('unilateral diplomacy cannot be promoted to mutually confirmed treaty',async()=>{
 const f=backgroundFixture();f.snapshot.chat=[{id:'incoming',from:1,to:0,text:'提议停战',tick:0,sentAt:0}];f.snapshot.chatCursor=1;f.background.observe(f.snapshot);
 const i=await diplomacyRequest(f);
 f.reply(i,assessment({agreement:{status:'confirmed',summary:'双方停战',forbidAttack:true,forbiddenTargets:[],internalIntent:'保留转向空间',expiresWorldDay:null}}));await turn();assert.equal((f.records.get('state') as HybridState).directive?.agreements.some(a=>a.status==='confirmed')??false,false);
 f.background.pause();await f.background.drain();
});

for(const status of ['accepted','failed','unknown'])test(`chat delivery alone never activates a joint offensive estimate: ${status}`,async()=>{
 const f=backgroundFixture();f.o.view.playerCount=3;f.snapshot.chatCount=3;f.snapshot.roster!.push({gamePlayer:2,chatPlayer:2});
 f.o.intel.push({...f.o.intel[1]!,player:2,active:true});
 f.snapshot.chat=[{id:'joint-offer',from:2,to:0,text:'160日前我们各从一侧进攻红方，我打东边，你选西边目标。',tick:100,sentAt:0}];
 f.background.observe(f.snapshot);
 try{
  const i=await diplomacyRequest(f);
  f.reply(i,assessment({message:'行，160日前一起打红方。',agreement:{status:'confirmed',summary:'各从一侧打红方',forbidAttack:false,forbiddenTargets:[],internalIntent:'真实参与两线进攻',expiresWorldDay:null,jointAttack:{enemy:1,until:160}}}));await turn();
  let saved=f.records.get('state') as HybridState;assert.equal(saved.messages[0]!.status,'pending');assert.equal(jointAttackGuidance(f.o,saved.directive).attackDefenseFactors.length,0);
  const services={model:{step:async()=>{throw Error('Unexpected model call in local fixture');}},local:async(r:AgentRequest,run:(r:AgentRequest)=>Promise<AgentResult>)=>run(r),latest:<T>(k:string)=>f.records.get(k) as T|undefined,record:(k:string,v:Record<string,unknown>)=>{f.records.set(k,structuredClone(v));},markAssessed:()=>{}};
  const input={state:f.state,snapshot:f.snapshot,history:[],feedback:[],efficiency:{cacheReports:true,cacheRoutes:true},suffix:'',routes:f.routes},request={prompt:'',model:'mock',signal:new AbortController().signal};
  await hybridMode.communicate!({...services,state:f.state,snapshot:f.snapshot,wake:()=>{},send:async id=>({requestId:id,status:status==='failed'?'rejected':status as 'accepted'|'unknown',result:{status}})});
  saved=f.records.get('state') as HybridState;assert.equal(jointAttackGuidance(f.o,saved.directive).attackDefenseFactors.length,0);assert.deepEqual(f.o.diplomacy!.agreements,[]);
 }finally{f.background.pause();await f.background.drain();}
});

test('spoken agreement and duplicate replies remain unbound without a formal signature',async()=>{
 const f=backgroundFixture();f.snapshot.chat=[{id:'offer',from:1,to:0,text:'我们互不攻击到第160世界日。',tick:100,sentAt:0}];
 f.background.observe(f.snapshot);
 try{
  const i=await diplomacyRequest(f);
  f.reply(i,assessment({message:'同意，160日前互不攻击。',agreement:{status:'confirmed',summary:'双方互不攻击至160日',forbidAttack:true,forbiddenTargets:[],internalIntent:'换取发育窗口',expiresWorldDay:160}}));await turn();
  let saved=f.records.get('state') as HybridState;
  assert.equal(saved.messages[0]!.status,'pending');assert.equal(saved.messages[0]!.agreement.status,'none');assert.deepEqual(saved.directive!.agreements,[]);
  const services={model:{step:async()=>{throw Error('Unexpected model call in local fixture');}},local:async(request:AgentRequest,compute:(r:AgentRequest)=>Promise<AgentResult>)=>compute(request),latest:<T>(k:string)=>f.records.get(k) as T|undefined,record:(k:string,v:Record<string,unknown>)=>{f.records.set(k,structuredClone(v));},markAssessed:()=>{}};
  const input={state:f.state,snapshot:f.snapshot,history:[],feedback:[],efficiency:{cacheReports:true,cacheRoutes:true},suffix:'',routes:f.routes},request={prompt:'',model:'mock',signal:new AbortController().signal};
  await hybridMode.communicate!({...services,state:f.state,snapshot:f.snapshot,wake:()=>{},send:async id=>({requestId:id,status:'accepted',result:{status:'accepted'}})});
  saved=f.records.get('state') as HybridState;assert.equal(saved.messages[0]!.status,'accepted');assert.deepEqual(saved.directive!.agreements,[]);assert.deepEqual(f.o.diplomacy!.agreements,[]);
  f.snapshot.chat.push({id:'repeat-offer',from:1,to:0,text:'还是互不攻击到第160世界日。',tick:100,sentAt:1});f.background.observe(f.snapshot);
  let answered=0;
  for(let pass=0;pass<12;pass++){
   while(answered<f.requests.length){const j=answered++;if(j===i)continue;const kind=readPromptMaterial(f.requests[j]!.request.prompt).kind;
    f.reply(j,kind==='diplomacy'?assessment({message:'同意，160日前互不攻击。',agreement:{status:'confirmed',summary:'双方互不攻击至160日',forbidAttack:true,forbiddenTargets:[],internalIntent:'换取发育窗口',expiresWorldDay:160}}):assessment());
   }
   await turn();if((f.records.get('state') as HybridState).handledMessages?.includes('repeat-offer'))break;
  }
  saved=f.records.get('state') as HybridState;assert.ok(saved.handledMessages?.includes('repeat-offer'));assert.equal(saved.messages.length,1);assert.deepEqual(saved.directive!.agreements,[],'duplicate chat cannot manufacture a signed agreement');
 }finally{f.background.pause();await f.background.drain();}
});

test('guidance guards combined spending, construction cost, enemy ownership and protected sources',()=>{
 const f=fixture(),source=f.o.view.outposts.find(p=>p.owner===0)!,target=f.o.view.outposts.find(p=>p.owner===1)!;
 const g={forbiddenPlayers:[],protectedSources:[],reserves:[{source:source.id,drillers:10}],objectives:[],rotation:0};
 const launch=(n:number)=>({id:String(n),issueTick:f.o.view.tick,action:{kind:'launch',source:source.id,destination:target.id,drillers:n}});
 assert.equal(tacticalGuidanceAllows(f.o,[launch((source.drillers??0)-10)],g),true);
 assert.equal(tacticalGuidanceAllows(f.o,[launch((source.drillers??0)-10),launch(1)],g),false);
 assert.equal(tacticalGuidanceAllows(f.o,[launch(1)],{...g,forbiddenPlayers:[1]}),false);
 assert.equal(tacticalGuidanceAllows(f.o,[launch(1)],{...g,protectedSources:[source.id]}),false);
});

test('fallback preserves ordinary search; immediate operations do not reserve future resources',()=>{
 const f=fixture(),source=f.o.view.outposts.find(p=>p.owner===0)!;
 assert.equal(operationGuidance(f.o,null,[],1),undefined);
 const d={version:1,basis:basisOf(f.o),summary:'',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[{source:source.id,drillers:10}],reviewOn:[],commanderVersion:0,commanderConstraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]},agreements:[]};
 const op:OperationState={id:'immediate',objective:'support',basis:basisOf(f.o),strategyVersion:1,status:'accepted',drafts:[{id:'now',issueTick:f.o.view.tick,action:{kind:'launch',source:source.id,destination:source.id,drillers:20}}],orders:[],fleets:[],issues:[]};
 assert.equal(operationGuidance(f.o,d,[op],1)!.reserves[0]!.drillers,10);
 d.reserves[0]!.drillers=50;assert.equal(operationGuidance(f.o,d,[op],1)!.reserves[0]!.drillers,50);
 const next=structuredClone(f.o);next.view.tick+=6;assert.equal(operationGuidance(next,d,[op],1)!.reserves[0]!.drillers,50);
});

test('shared search respects treaty through refinement and combinations',()=>{
 const f=fixture();const decision=planBot(f.o,f.routes,{maxSimulations:50,maxElapsedMs:5000,guidance:{forbiddenPlayers:[1],protectedSources:[],reserves:[],objectives:[],rotation:0}});
 assert.ok(decision.assessments.every(a=>!a.candidate.drafts.some(d=>f.o.view.outposts.find(p=>p.id===d.action.destination)?.owner===1)));
});

test('operation completion requires actual linked settlements; disappearance is not success',()=>{
 const f=fixture(),op:OperationState={id:'op',objective:'capture:test',basis:basisOf(f.o),strategyVersion:1,status:'underway',drafts:[{id:'d',issueTick:0,action:{kind:'launch'}}],orders:['fleet-one'],fleets:['fleet-one'],issues:[]};
 assert.notEqual(reconcileOperations([op],f.o)[0]!.status,'completed');
 const o=structuredClone(f.o);o.activity=[{id:1,kind:'arrival',tick:1,seconds:0,actor:0,subject:'fleet-one',source:null,destination:null,drillers:1,enabled:null,arrival:{outpost:'target',outcome:'delivered',drillers:1}}];
 assert.equal(reconcileOperations([op],o)[0]!.status,'completed');
});

test('latest treaty and commander constraints are checked immediately before effects',()=>{
 const f=fixture(),saved=initialHybridState();saved.directive={version:1,basis:basisOf(f.o),summary:'',objectives:[],forbiddenPlayers:[1],protectedSources:[],reserves:[],reviewOn:[],commanderVersion:0,commanderConstraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]},agreements:[]};
 const source=f.o.view.outposts.find(p=>p.owner===0)!,target=f.o.view.outposts.find(p=>p.owner===1)!;
 assert.throws(()=>hybridMode.beforeExecute!({state:f.state,snapshot:f.snapshot,tool:'order',arguments:{action:{kind:'launch',source:source.id,destination:target.id,drillers:1}},latest:<T>()=>saved as T}));
 f.state.commanderDirectives={version:2,text:'禁止进攻'};assert.throws(()=>hybridMode.beforeExecute!({state:f.state,snapshot:f.snapshot,tool:'order',arguments:{action:{kind:'check-in'}},latest:<T>()=>saved as T}));
});

test('worker deadline returns only a completed checkpoint and cancellation terminates work',async()=>{
 const f=fixture();try{
  // This case exercises checkpoint fallback, not cold forecast-pool startup.
  await computeBot(f.o,f.routes,{maxElapsedMs:10000,maxSimulations:2});
  const decision=await computeBot(f.o,f.routes,{maxElapsedMs:1500,maxSimulations:50,guidance:{forbiddenPlayers:[],protectedSources:[],reserves:[],objectives:[],rotation:0}});
  assert.equal(decision.basisRevision,f.o.revision);assert.ok(decision.assessments.every(a=>a.status!=='evaluated'||a.score));
  await assert.rejects(async()=>computeBot(f.o,f.routes,{signal:AbortSignal.abort()}));
 }finally{closeBotForecastPool();}
});


for(const pendingCommander of [false,true])test(`slow background ${pendingCommander?'commander interpretation holds actions':'initial strategy uses foreground fallback'} without blocking tick readiness`,async t=>{
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;setup.match={mode:'mining',neptuniumGoal:200};
 const h=protocolHarness(t,{room:{state:createFleetScenario(setup),scheduled:[]}}),api=await createOwnerPlayerApi(h,{});api.listen(0,'127.0.0.1');await once(api,'listening');
 const store=new AiStore(':memory:'),requests:{request:AgentRequest;resolve:(r:import('../packages/ai/src/controller/contracts/types.js').ModelResult<unknown>)=>void;reject:(e:unknown)=>void}[]=[];
 const gateway=new PlayerGateway(`http://127.0.0.1:${(api.address() as {port:number}).port}`,h.ownerCredentials.credentials[0]!.token,h.ownerAccess.roomId,0,2);
 const state=initialState(h.ownerAccess.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'});
 if(pendingCommander)state.commanderDirectives={version:1,text:'先维持现状，禁止离开蓝方工厂'};
 const runner=new SeatRunner(state,store,gateway,{step:request=>new Promise((resolve,reject)=>{requests.push({request,resolve,reject});request.signal.addEventListener('abort',()=>reject(Error('paused')),{once:true});})});
 try{
  await runner.poll(0,true);await turn();
  assert.ok(requests.length>0,'background is still awaiting a model reply');
  assert.equal(state.error,null,JSON.stringify(store.latest(state.roomId,0,'error')));
  assert.ok(store.latest(state.roomId,0,'completed'),'foreground completes before any model response');
  if(pendingCommander){
   assert.equal(h.store.load()!.room.state.commands.length,0,'pending commander authority cannot submit autonomous actions');
   assert.equal(store.latest(state.roomId,0,'analysis-cache'),null,'a hold does not precompute attack routes');
   assert.equal(store.latest(state.roomId,0,'mode-hybrid-search'),null);
  }
  for(let i=1;i<=4&&!runner.advanceReadiness();i++)await runner.poll(i*10000);
  assert.ok(runner.advanceReadiness(),'completed foreground can report ready while model is unresolved');
  const current=h.store.load()!;h.store.commit(advanceRoom(current.room,current.room.state.economy.tick+1),current.revision);
  await runner.poll(50000);assert.equal(state.error,null);
  if(pendingCommander){
   await runner.poll(65000); // Allow the ordinary event coalescing window to close.
   assert.equal(h.store.load()!.room.state.commands.length,0);
   assert.ok(runner.advanceReadiness(),'commander hold remains ready in the next tick');
   const request=requests.find(r=>readPromptMaterial(r.request.prompt).kind==='commander')!;
   request.resolve({tokens:5,reply:intentWire(assessment(),'commander')});
   for(let i=0;i<12&&!store.latest<HybridState>(state.roomId,0,'mode-hybrid-state')?.directive;i++)await turn();
   assert.equal(store.latest<HybridState>(state.roomId,0,'mode-hybrid-state')?.directive?.commanderVersion,1);
   assert.equal(runner.advanceReadiness(),null,'published constraints wake the foreground before its next readiness');
  }
 }finally{runner.pause();await runner.drainBackground();store.close();api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));closeBotForecastPool();}
});

test('hybrid runner uses managed background model, submits through ordinary player executor and pauses cleanly',async t=>{
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;setup.match={mode:'mining',neptuniumGoal:200};
 const h=protocolHarness(t,{room:{state:createFleetScenario(setup),scheduled:[]}}),api=await createOwnerPlayerApi(h,{});api.listen(0,'127.0.0.1');await once(api,'listening');
 const store=new AiStore(':memory:');let calls=0;
 const gateway=new PlayerGateway(`http://127.0.0.1:${(api.address() as {port:number}).port}`,h.ownerCredentials.credentials[0]!.token,h.ownerAccess.roomId,0,2);
 const state=initialState(h.ownerAccess.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'});
 const runner=new SeatRunner(state,store,gateway,{step:async request=>{calls++;assert.ok(request.responseSchema);return {tokens:5,usage:{inputTokens:3,outputTokens:2},usageKnown:{provenance:'reported',input:true,output:true,cached:false},reply:intentWire(assessment(),readPromptMaterial(request.prompt).kind)};}});
 try{
  await runner.poll(0);await turn();await runner.poll(10000,true);await turn();
  assert.equal(state.error,null,JSON.stringify(store.latest(state.roomId,0,'error')));assert.ok(calls>0);assert.ok(store.latest(state.roomId,0,'mode-hybrid-state'));
  assert.ok(store.latest(state.roomId,0,'mode-hybrid-feedback'));assert.equal(store.latest(state.roomId,0,'call-reserved'),null);
  assert.ok(h.store.load()!.room.state.fleets.some(f=>f.owner===0&&f.drillers>0));
  const operations=store.latest<{operations:OperationState[]}>(state.roomId,0,'mode-hybrid-operations')!.operations;assert.ok(operations.some(p=>['accepted','underway'].includes(p.status)&&p.orders.length>0),JSON.stringify(operations));
 }finally{runner.pause();await runner.drainBackground();store.close();api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));closeBotForecastPool();}
});

for(const apiStyle of ['chat','responses'] as const)for(const responseFormat of ['json_schema','json_object','none'] as const)test(`semantic transport supports ${apiStyle}/${responseFormat} without game envelope`,async()=>{
 let body:Record<string,unknown>={};
 const provider=new OpenAICompatibleProvider({apiKey:'synthetic',baseUrl:'https://example.invalid/v1',apiStyle,responseFormat,fetchImpl:(async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify(apiStyle==='chat'?{choices:[{finish_reason:'stop',message:{content:JSON.stringify(assessment())}}],usage:{prompt_tokens:5,completion_tokens:3}}:{status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify(assessment())}]}],usage:{input_tokens:5,output_tokens:3}}));}) as typeof fetch});
 const result=await provider.step({prompt:'synthetic semantic judgment',model:'fake',responseSchema:assessmentSchema,signal:new AbortController().signal});
 assert.ok(result.reply&&typeof result.reply==='object');assert.equal(result.tokens,8);assert.equal(result.usageKnown?.input,true);
 assert.ok(JSON.stringify(body).includes('forbiddenPlayers'),'every transport must deliver the semantic output contract');
 const prompt=apiStyle==='chat'?(body.messages as {content:string}[])[0]!.content:body.input as string;
 if(responseFormat==='json_schema')assert.equal(prompt,'synthetic semantic judgment');
 else assert.ok(prompt.includes(JSON.stringify(assessmentSchema)));
});

test('pause and resume reschedule cancelled work rather than losing fingerprints',async()=>{
 const f=backgroundFixture();f.background.observe(f.snapshot);const first=f.requests.length;f.background.pause();await f.background.drain();f.background.observe(f.snapshot);assert.ok(f.requests.length>first);f.background.pause();await f.background.drain();
});

test('background failure cannot overwrite newer tactical message receipts',async()=>{
 const f=backgroundFixture();f.background.observe(f.snapshot);const saved=f.records.get('state') as HybridState;
 saved.messages.push({id:'sent',conversation:'1',to:[1],text:'停战',basis:basisOf(f.o),messageIds:[],status:'accepted',agreement:{conversation:'1',players:[1],status:'proposed',summary:'提议',forbidAttack:true,forbiddenTargets:[],internalIntent:'',expiresWorldDay:null,evidence:[],tick:0}});f.records.set('state',saved);
 f.requests[0]!.resolve({tokens:0,reply:{invalid:true}});await turn();assert.equal((f.records.get('state') as HybridState).messages[0]!.status,'accepted');f.background.pause();await f.background.drain();
});
import {hybridCommanderPrompt} from '../plugins/hybrid/src/commander.js';
import type {CommanderThread,CommanderMessage} from '../packages/contracts/src/index.js';

test('hybrid commander discussion uses published guidance and stays below the short-context ceiling',()=>{
 const f=fixture(),saved=initialHybridState();saved.directive={version:7,basis:basisOf(f.o),summary:'已发布东部夺矿战略',objectives:[],forbiddenPlayers:[1],protectedSources:[],reserves:[],reviewOn:[],commanderVersion:2,commanderConstraints:{forbiddenPlayers:[1],protectedSources:[],reserves:[]},agreements:[]};
 const message:CommanderMessage={id:'question',role:'player',text:'现在准备怎样行动？',references:[],tick:100,sentAt:0,status:'queued'};
 const thread:CommanderThread={roomId:f.o.roomId,player:0,messages:[message],directives:{version:2,text:'保护核心据点',appliedVersion:1}};
 const prompt=hybridCommanderPrompt({mode:'discuss',state:f.state,thread,message,observation:f.o,roster:f.snapshot.roster!,latest:<T>(kind:string)=>kind==='state'?saved as T:undefined});
 assert.equal(readPromptMaterial(prompt).planning,undefined);assert.equal(readPromptMaterial(prompt).attackAssessment,undefined);
 assert.ok(prompt.length<=HYBRID_PROMPT_CHARACTERS);assert.match(prompt,/已发布东部夺矿战略/);assert.match(prompt,/保护核心据点/);assert.match(prompt,/待玩家确认/);
});

test('hybrid commander receives only scoped program attack conclusions instead of a tactical shortlist',()=>{
 const f=fixture(),saved=initialHybridState(),message:CommanderMessage={id:'attack-question',role:'player',text:'集中兵力进攻天火',references:[],tick:f.o.view.tick,sentAt:0,status:'queued'};
 const thread:CommanderThread={roomId:f.o.roomId,player:0,messages:[message],directives:{version:0,text:'',appliedVersion:0}};
 const prompt=hybridCommanderPrompt({mode:'discuss',state:f.state,thread,message,observation:f.o,roster:[{chatPlayer:1,gamePlayer:1,displayName:'天火'}],latest:<T>()=>undefined as T|undefined});
 const b=readPromptMaterial(prompt);
 assert.equal(b.planning,undefined);assert.equal(b.attackAssessment.assessedAtWorldDay,f.o.view.tick+f.o.secondsSinceLastTick/600);
 assert.ok(b.attackAssessment.targets.length>0);assert.ok(b.attackAssessment.targets.length<=3);
 for(const assessment of b.attackAssessment.targets){
  assert.ok(Object.values(f.o.outpostNames!).includes(assessment.target));
  assert.deepEqual(Object.keys(assessment).sort(),['conclusion','reasons','target']);
  assert.equal(typeof assessment.conclusion,'string');
 }
 assert.match(prompt,/不要让玩家手工补/);assert.match(prompt,/不再附加玩家确认条件/);assert.ok(prompt.length<=HYBRID_PROMPT_CHARACTERS);
});

test('old local treaty records cannot impose hard constraints on a server-contract snapshot',async()=>{
 const f=backgroundFixture();f.background.observe(f.snapshot);const i=f.requests.findIndex(x=>x.request.prompt.includes('"kind":"strategy"'));f.reply(i);await turn();
 const saved=f.records.get('state') as HybridState;saved.directive!.agreements=[{conversation:'1',players:[1],status:'confirmed',summary:'临时停战',forbidAttack:true,forbiddenTargets:[],internalIntent:'',expiresWorldDay:f.o.view.tick+1,evidence:[],tick:f.o.view.tick}];f.records.set('state',saved);
 assert.equal(constraints(saved.directive,f.o,saved).forbiddenPlayers.includes(1),false);const next=structuredClone(f.snapshot);next.observation.view.tick+=2;f.background.observe(next);
 const current=f.records.get('state') as HybridState;assert.deepEqual(current.directive!.agreements,[]);assert.equal(constraints(current.directive).forbiddenPlayers.includes(1),false);f.background.pause();await f.background.drain();
});

test('a definitely rejected revision conflict replans only once; unknown writes never replan',async()=>{
 const f=fixture();f.state.sequence=1;const saved=new Map<string,unknown>();let refreshes=0;
 const input={state:f.state,snapshot:f.snapshot,history:[],feedback:[{id:'ai-0-1-0',tool:'batch',arguments:{},result:{results:[{status:'rejected',outcome:'rejected',code:'REVISION_CONFLICT'}]}}],efficiency:{cacheReports:true,cacheRoutes:true},suffix:'',routes:f.routes};
 const services={model:{step:async()=>{throw Error('Unexpected model call in local fixture');}},local:async(request:AgentRequest,compute:(r:AgentRequest)=>Promise<AgentResult>)=>compute(request),latest:<T>(kind:string)=>saved.get(kind) as T|undefined,record:(kind:string,data:Record<string,unknown>)=>{saved.set(kind,structuredClone(data));},markAssessed:()=>{},refreshSnapshot:async()=>{refreshes++;return f.snapshot;}};
 const request={prompt:'',model:'fake',signal:new AbortController().signal};
 try{
  await hybridMode.prepare(input).run(request,services);assert.equal((saved.get('repair-attempt') as {sequence:number}).sequence,1);assert.ok(refreshes>0);
  const before=refreshes;const again=await hybridMode.prepare(input).run(request,services);assert.equal(again.reply.tool,'finish');assert.equal(refreshes,before);
  const unknown={...input,feedback:[{id:'ai-0-1-1',tool:'batch',arguments:{},result:{results:[{status:'unknown',outcome:'unknown',code:'REVISION_CONFLICT'}]}}]};await hybridMode.prepare(unknown).run(request,services);assert.equal(refreshes,before);
 }finally{closeBotForecastPool();}
});

test('oversized diplomacy blocks before model calls without partial publication or repeated merge work',async()=>{
 const f=backgroundFixture();f.snapshot.chat=Array.from({length:20},(_,i)=>({id:'long-'+i,from:1,to:0,text:('讨论条件'+i+'。').repeat(Math.ceil(HYBRID_PROMPT_CHARACTERS/80)),tick:100,sentAt:i}));f.snapshot.chatCursor=20;f.background.observe(f.snapshot);
 try{
  f.reply(0);await turn();await turn();
  const saved=f.records.get('state') as HybridState,blocked=saved.tasks.find(t=>t.kind==='diplomacy');
  assert.equal(blocked?.status,'blocked-context');assert.ok(blocked.characters>HYBRID_PROMPT_CHARACTERS);
  assert.match(blocked.error!,/完整外交材料超过上下文上限/);
  assert.equal(saved.messages.length,0);assert.equal(saved.handledMessages?.length??0,0);
  assert.deepEqual(saved.chat,f.snapshot.chat,'all unhandled original messages remain available');
  const count=f.requests.length;
  for(let i=0;i<8;i++){f.background.observe(f.snapshot);await turn();}
  assert.equal(f.requests.length,count,'unchanged blocked evidence does not restart partition or merge calls');
  assert.ok(f.requests.every(r=>readPromptMaterial(r.request.prompt).kind!=='diplomacy'));
 }finally{f.background.pause();await f.background.drain();}
});

test('pressure evidence is grounded in visible threat and limited tactical search, not hold alone',async()=>{
 const f=fixture(),saved=initialHybridState();
 const d=await planBot(f.o,f.routes,{maxSimulations:4,maxElapsedMs:1500,internalTransfers:false});
 assert.equal(diplomacyNeeds(f.o,d,saved,[]).length,0);
 const own=f.o.view.outposts.find(p=>p.owner===0)!;
 f.o.view.fleets.push({id:'pressure-attack',owner:1,drillers:1000,state:'waiting',position:own.position,gift:false,destination:{kind:'outpost',id:own.id}});
 const pressured=await planBot(f.o,attackRoutes(f.o,{attackTicks:144,localTicks:144,holdTicks:24}),{maxSimulations:4,maxElapsedMs:1500,internalTransfers:false});
 const need=diplomacyNeeds(f.o,pressured,saved,[]).find(n=>n.kind==='defense-pressure');
 assert.ok(need);assert.deepEqual(need.targets,[own.id]);assert.match(JSON.stringify(need.evidence),/pressure-attack/);assert.match(need.limits.join(''),/不能证明/);
});

test('attack distress requires an explicit unfulfilled goal and respects treaties and underway actions',async()=>{
 const f=fixture(),target=f.o.view.outposts.find(p=>p.owner===1)!,saved=initialHybridState();
 target.drillers=10000;
 const d=await planBot(f.o,attackRoutes(f.o,{attackTicks:144,localTicks:144,holdTicks:24}),{maxSimulations:50,maxElapsedMs:4000,internalTransfers:false});
 // Only attack candidates are relevant: other defensive/economic choices are not proof of progress.
 const directive={version:1,basis:basisOf(f.o),summary:'攻坚',objectives:[{id:'front',kind:'capture' as const,targets:[target.id],priority:80,reason:'阻止领先者'}],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],commanderVersion:0,commanderConstraints:{forbiddenPlayers:[] as number[],protectedSources:[],reserves:[]},agreements:[]};
 saved.directive=directive;
 assert.ok(diplomacyNeeds(f.o,d,saved,[]).some(n=>n.kind==='attack-stalled'));
 directive.commanderConstraints.forbiddenPlayers=[1];assert.ok(!diplomacyNeeds(f.o,d,saved,[]).some(n=>n.kind==='attack-stalled'));
 directive.commanderConstraints.forbiddenPlayers=[];
 const op:OperationState={id:'underway',objective:'capture',basis:basisOf(f.o),strategyVersion:1,status:'underway',drafts:[{id:'d',issueTick:0,action:{kind:'launch',destination:target.id}}],orders:['accepted'],fleets:[],issues:[]};
 assert.ok(!diplomacyNeeds(f.o,d,saved,[op]).some(n=>n.kind==='attack-stalled'));
});

test('stalled attack requires three distinct world ticks and persists across serialization',()=>{
 const f=fixture(),state=initialHybridState(),target=f.o.view.outposts.find(p=>p.owner===1)!;
 const need:DiplomacyNeed={id:`attack:${target.id}:1`,kind:'attack-stalled',targets:[target.id],opponents:[1],evidence:{search:{complete:false}},limits:['未搜索不判失败']};
 const step=()=>updateDiplomacyPressure(state,pressureFeedback(f,[need]),f.o,0);
 assert.equal(step().length,0);for(let i=0;i<8;i++){f.o.revision+='x';assert.equal(step().length,0);}
 f.o.view.tick++;assert.equal(step().length,0);
 state.diplomacyPressure=JSON.parse(JSON.stringify(state.diplomacyPressure));f.o.view.tick++;assert.equal(step().length,1);
 f.o.view.tick++;updateDiplomacyPressure(state,pressureFeedback(f,[]),f.o,0);f.o.view.tick++;assert.equal(step().length,0);
 const stale=pressureFeedback(f,[need]);stale.basis.commanderVersion=9;assert.equal(updateDiplomacyPressure(state,stale,f.o,0).length,0);
 stale.basis.commanderVersion=0;stale.basis.tick-=25;assert.equal(updateDiplomacyPressure(state,stale,f.o,0).length,0);
});

test('diplomatic helper ranking prefers third parties and uses explicit chat identities',()=>{
 const f=fixture();const third=structuredClone(f.o.intel[1]!);third.player=2;third.active=true;f.o.intel.push(third);
 f.snapshot.roster=[{gamePlayer:0,chatPlayer:10},{gamePlayer:1,chatPlayer:11},{gamePlayer:2,chatPlayer:12}];
 const peers=diplomacyPeers(f.snapshot,[defenseNeed(f)]);assert.equal(peers[0]!.chat,12);assert.equal(peers[0]!.role,'seek-cooperation');assert.equal(peers[1]!.role,'negotiate-with-opponent');
 f.snapshot.roster=f.snapshot.roster.filter(r=>r.gamePlayer!==2);assert.ok(!diplomacyPeers(f.snapshot,[defenseNeed(f)]).some(p=>p.game===2));
});

test('defensive distress schedules a short diplomatic review without waiting for periodic patrol',async()=>{
 const f=backgroundFixture(),need=defenseNeed(f);f.records.set('feedback',pressureFeedback(f,[need]));
 f.snapshot.roster=[{gamePlayer:0,chatPlayer:10},{gamePlayer:1,chatPlayer:11}];f.snapshot.chatPlayer=10;
 try{
  f.background.observe(f.snapshot);await turn();
  const index=await diplomacyRequest(f);
  const request=f.requests[index]!.request,brief=readPromptMaterial(request.prompt);
  assert.equal(brief.scope,'11');assert.equal(brief.guidance.diplomacyPurpose.needs[0].kind,'defense-pressure');assert.match(request.prompt,/两线夹击/);assert.ok(request.prompt.length<=HYBRID_PROMPT_CHARACTERS);
  f.reply(index,assessment({summary:'暂不承诺，等待对方收益明确',reviewOn:['pressure-change']}));await turn();
  const pressure=(f.records.get('state') as HybridState).diplomacyPressure!;assert.equal(pressure.attempts[need.id]!.peer,1);
  const count=f.requests.length;for(let i=0;i<5;i++)f.background.observe(f.snapshot);assert.equal(f.requests.length,count);
  f.advance(60001);f.o.view.tick+=6;f.records.set('feedback',pressureFeedback(f,[need]));f.background.observe(f.snapshot);
  assert.equal(f.requests.length,count,'unchanged pressure is not a new diplomatic cause after cooldown');
  assert.equal((f.records.get('state') as HybridState).messages.length,0,'review is not an agreement or a sent message');
  const stronger=structuredClone(need);(stronger.evidence as any).actualIncoming[0].drillers=600;
  f.records.set('feedback',pressureFeedback(f,[stronger]));f.background.observe(f.snapshot);
  assert.equal(f.requests.length,count+1,'changed actual incoming force is reviewed');
 }finally{f.background.pause();await f.background.drain();}
});

test('pressure review keys survive serialization and ignore ordinary production, search churn and prose',()=>{
 const f=fixture(),saved=initialHybridState(),need=defenseNeed(f);
 const first=pressureReviewKey(f.snapshot,saved,[need],1);
 recordDiplomacyReview(saved,f.snapshot,[need],[1],1000);
 assert.equal(JSON.parse(JSON.stringify(saved)).diplomacyPressure.contacts['1'].reviewKey,first);
 f.o.view.tick+=6;f.o.revision='new-observation';f.o.view.outposts.find(p=>p.owner===0)!.drillers!++;
 (need.evidence as any).search={simulations:80};(need.evidence as any).selected='different-candidate';need.limits=['different wording'];
 assert.equal(pressureReviewKey(f.snapshot,JSON.parse(JSON.stringify(saved)),[need],1),first);
 (need.evidence as any).actualIncoming.push({id:'second-attack',owner:1,drillers:10});
 assert.equal(pressureReviewKey(f.snapshot,saved,[need],1),first,'a small new wave inside the same force band is merged');
 (need.evidence as any).actualIncoming[1].drillers=300;
 assert.notEqual(pressureReviewKey(f.snapshot,saved,[need],1),first,'a materially larger force remains a new cause');
 saved.directive={version:1,basis:basisOf(f.o),summary:'',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],commanderVersion:0,commanderConstraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]},agreements:[{...assessment().agreement,status:'confirmed',conversation:'1',players:[1],evidence:[],tick:f.o.view.tick,expiresWorldDay:f.o.view.tick+12}]};
 const distant=pressureReviewKey(f.snapshot,saved,[need],1);f.o.view.tick+=6;
 assert.notEqual(pressureReviewKey(f.snapshot,saved,[need],1),distant,'near-expiry re-evaluation remains possible');
});

test('incoming analysis does not mark pressure arriving during inference as already reviewed',async()=>{
 const f=backgroundFixture();f.snapshot.chat=[{id:'in-flight-new-pressure',from:1,to:0,text:'先讨论边界',tick:f.o.view.tick,sentAt:0}];
 try{
  f.background.observe(f.snapshot);const i=await diplomacyRequest(f);
  const need=defenseNeed(f);f.records.set('feedback',pressureFeedback(f,[need]));f.background.observe(f.snapshot);
  f.reply(i,assessment({message:null}));await turn();await turn();
  const count=f.requests.length;f.o.view.tick++;f.records.set('feedback',pressureFeedback(f,[need]));f.background.observe(f.snapshot);
  assert.equal(f.requests.length,count+1,'new pressure was not in the captured diplomatic brief');
 }finally{f.background.pause();await f.background.drain();}
});

test('proactive diplomacy reuses cooldown while current incoming replies remain exempt',async()=>{
 const f=backgroundFixture();f.state.lastSpoke=f.o.view.tick*600;f.o.secondsSinceLastTick=100;
 assert.equal(canInitiateDiplomacy(f.snapshot,f.state,[1]),false);
 f.records.set('feedback',pressureFeedback(f,[defenseNeed(f)]));
 try{
  f.background.observe(f.snapshot);f.reply(0);await turn();await turn();
  assert.equal(f.requests.length,1,'known blocked unsolicited contact does not consume a model request');
  f.snapshot.chat=[{id:'cooldown-incoming',from:1,to:0,text:'新的具体要约',tick:0,sentAt:0}];
  assert.equal(canInitiateDiplomacy(f.snapshot,f.state,[1]),true);
  f.background.observe(f.snapshot);await turn();
  assert.equal(f.requests.length,2,'incoming review is not blocked by proactive contact budget');
  f.reply(1,assessment({message:null}));await turn();await turn();
  const saved=f.records.get('state') as HybridState;
  assert.ok(saved.handledMessages!.includes('cooldown-incoming'));assert.equal(saved.messages.length,0);
  f.advance(60001);f.o.view.tick+=6;f.o.secondsSinceLastTick=0;f.records.set('feedback',pressureFeedback(f,[defenseNeed(f)]));f.background.observe(f.snapshot);
  assert.equal(f.requests.length,2,'incoming analysis already covered the same pressure');
 }finally{f.background.pause();await f.background.drain();}
});

test('one proactive conversation merges all current pressure and a resolved episode permits fresh review',async()=>{
 const f=backgroundFixture(),need=defenseNeed(f),other={...defenseNeed(f),id:'defense:other'};
 f.records.set('feedback',pressureFeedback(f,[need,other]));
 try{
  f.background.observe(f.snapshot);const i=await diplomacyRequest(f);
  const brief=readPromptMaterial(f.requests[i]!.request.prompt);
  assert.equal(brief.guidance.diplomacyPurpose.needs.length,2);
  f.reply(i);await turn();await turn();const count=f.requests.length;
  f.o.view.tick++;f.records.set('feedback',pressureFeedback(f,[]));f.background.observe(f.snapshot);
  f.advance(60001);f.o.view.tick+=6;f.records.set('feedback',pressureFeedback(f,[need,other]));f.background.observe(f.snapshot);
  assert.equal(f.requests.length,count+1,'a pressure that actually resolved and returned is new evidence');
 }finally{f.background.pause();await f.background.drain();}
});

test('incoming discussion and pressure are combined instead of replacing the conversation evidence',async()=>{
 const f=backgroundFixture();f.records.set('feedback',pressureFeedback(f,[defenseNeed(f)]));
 f.snapshot.chat=[{id:'request-help',from:1,to:0,text:'我们可以商议共同对手',tick:0,sentAt:0}];
 try{
  f.background.observe(f.snapshot);await turn();
  await diplomacyRequest(f);const diplomacy=f.requests.map(r=>readPromptMaterial(r.request.prompt)).filter(b=>b.kind==='diplomacy');assert.equal(diplomacy.length,1);
  assert.match(JSON.stringify(diplomacy[0]),/request-help/);assert.equal(diplomacy[0]!.guidance.diplomacyPurpose.needs.length,1);
 }finally{f.background.pause();await f.background.drain();}
});

test('changing tactical pressure does not supersede analysis of the same unread message',async()=>{
 const f=backgroundFixture();
 f.snapshot.chat=[{id:'stable-inbox',from:1,to:0,text:'我们可以交换边界情报',tick:0,sentAt:0}];
 try{
  f.background.observe(f.snapshot);await turn();
  const index=await diplomacyRequest(f);
  f.records.set('feedback',pressureFeedback(f,[defenseNeed(f)]));
  f.background.observe(f.snapshot);
  f.reply(index,assessment({summary:'先根据边界情报判断合作收益'}));await turn();await turn();
  const saved=f.records.get('state') as HybridState;
  assert.equal(saved.tasks.find(t=>t.id==='diplomacy-1')!.status,'completed');
  assert.ok(saved.handledMessages?.includes('stable-inbox'));
  const requests=f.requests.filter(r=>readPromptMaterial(r.request.prompt).kind==='diplomacy');
  assert.equal(requests.length,1,'the same evidence must not start a duplicate review');
 }finally{f.background.pause();await f.background.drain();}
});

test('resolved pressure alone does not discard an otherwise legal returned reply',async()=>{
 const f=backgroundFixture();f.records.set('feedback',pressureFeedback(f,[defenseNeed(f)]));
 try{
  f.background.observe(f.snapshot);await turn();
  const i=await diplomacyRequest(f);
  f.o.view.tick++;f.records.set('feedback',pressureFeedback(f,[]));f.background.observe(f.snapshot);
  f.reply(i,assessment({message:'请求援助旧防线'}));await turn();
  const state=f.records.get('state') as HybridState;assert.equal(state.messages.length,1);assert.ok(state.tasks.some(t=>t.id==='diplomacy-1'&&t.status==='completed'),JSON.stringify(state.tasks));
 }finally{f.background.pause();await f.background.drain();}
});

test('new commander interpretation prevents proactive pressure diplomacy until constraints are ready',async()=>{
 const f=backgroundFixture();f.state.commanderDirectives={version:1,text:'不可许诺交出核心据点'};
 const feedback=pressureFeedback(f,[defenseNeed(f)]);feedback.basis.commanderVersion=1;f.records.set('feedback',feedback);
 try{
  f.background.observe(f.snapshot);assert.equal(f.records.get('diplomacy-trigger'),undefined);
  assert.ok(f.requests.some(r=>readPromptMaterial(r.request.prompt).kind==='commander'));
 }finally{f.background.pause();await f.background.drain();}
});


test('returned strategy survives new reviews and structural changes with its original observation basis',async()=>{
 const f=backgroundFixture();
 try{
  f.background.observe(f.snapshot);await turn();assert.ok(f.requests.length);
  const post=f.o.view.outposts.find(p=>p.owner===0)!;
  const next=structuredClone(f.snapshot);next.observation.view.outposts.find(p=>p.id===post.id)!.type='mine';next.observation.revision='mine-completed';next.observation.view.tick++;
  f.background.observe(next);
  f.reply(0,assessment({summary:'这里还没有矿，应建首矿'}));await turn();await turn();
  const saved=f.records.get('state') as HybridState;
  assert.ok(f.calls.some(c=>c.task==='overview'&&c.status==='completed'));
  assert.equal(saved.directive?.summary,'这里还没有矿，应建首矿');
  assert.equal(saved.directive?.summaryBasis?.revision,f.o.revision);
  assert.equal(saved.directive?.basis.revision,'mine-completed');
  f.background.observe(next);
  assert.equal((f.records.get('state') as HybridState).directive?.summary,'这里还没有矿，应建首矿');
  assert.ok(f.requests.length>1);f.reply(1,assessment({summary:'保有矿场并重新比较生产'}));await turn();await turn();
  assert.equal((f.records.get('state') as HybridState).directive?.summary,'保有矿场并重新比较生产');
 }finally{f.background.pause();await f.background.drain();}
});


test('oversized context yields to control I/O between partitions and pause cancels the continuation',async()=>{
 const f=backgroundFixture();
 try{
  f.background.observe(f.snapshot);f.reply(0);await turn();await turn();
  const before=f.requests.length;
  f.snapshot.chat=Array.from({length:20},(_,i)=>({id:'yield-'+i,from:1,to:0,text:('讨论条件'+i+'。').repeat(Math.ceil(HYBRID_PROMPT_CHARACTERS/80)),tick:100,sentAt:i}));f.snapshot.chatCursor=20;
  const heartbeat=new Promise<number>(resolve=>setImmediate(()=>resolve(f.requests.length-before)));
  f.background.observe(f.snapshot);assert.equal(f.requests.length,before,'no synchronous partition cascade');
  assert.equal(await heartbeat,0,'control callbacks run before another partition is constructed');
  f.background.pause();await turn();assert.equal(f.requests.length,before);assert.equal(f.background.settling,false);
 }finally{f.background.pause();await f.background.drain();}
});


test('local confirmation and compressed chat cannot stand in for server signature evidence',async()=>{
 const f=backgroundFixture(),saved=initialHybridState();
 saved.directive={version:1,basis:basisOf(f.o),summary:'已有协议',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],commanderVersion:0,commanderConstraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]},agreements:[{conversation:'1',players:[1],status:'confirmed',fulfillment:'rules',summary:'既有停战',forbidAttack:true,forbiddenTargets:[],internalIntent:'',expiresWorldDay:160,evidence:['original-both-sides'],tick:100}]};
 f.records.set('state',saved);f.snapshot.chat=[{id:'followup',from:1,to:0,text:'继续按160天停战。',tick:100,sentAt:0}];
 f.background.observe(f.snapshot);
 try{
  const i=await diplomacyRequest(f);
  f.reply(i,assessment({agreement:{status:'confirmed',fulfillment:'rules',summary:'维持原条款',forbidAttack:true,forbiddenTargets:[],internalIntent:'继续原协议',expiresWorldDay:160}}));await turn();
  const current=f.records.get('state') as HybridState;
  assert.ok(current.handledMessages?.includes('followup'));assert.deepEqual(current.directive!.agreements,[]);assert.deepEqual(f.o.diplomacy!.agreements,[]);
  assert.equal(current.tasks.find(t=>t.kind==='diplomacy')!.status,'completed');
 }finally{f.background.pause();await f.background.drain();}
});






test('confirmation evidence cannot authorize changed, expired or unilateral agreement terms',()=>{
 const current={conversation:'1',players:[1],status:'confirmed' as const,forbidAttack:true,forbiddenTargets:['a','b'],expiresWorldDay:160,jointAttack:{enemy:2,until:150},summary:'',internalIntent:'',evidence:['accepted'],tick:100};
 assert.equal(isConfirmedContinuation(current,{...current,forbiddenTargets:['b','a']},101),true);
 for(const next of [{...current,forbidAttack:false},{...current,forbiddenTargets:['a']},{...current,expiresWorldDay:170},{...current,jointAttack:{enemy:3,until:150}},{...current,jointAttack:{enemy:2,until:151}}])assert.equal(isConfirmedContinuation(current,next,101),false);
 assert.equal(isConfirmedContinuation(current,current,161),false);assert.equal(isConfirmedContinuation({...current,status:'proposed'},current,101),false);assert.equal(isConfirmedContinuation(undefined,current,101),false);
});


test('hybrid model briefs exclude expired intents even before status reconciliation',()=>{
 const f=fixture(),saved=initialHybridState(),now=f.o.view.tick+f.o.secondsSinceLastTick/600;
 const intent=(id:string,status:'pending'|'completed'|'expired'|'cancelled',until:number)=>({id,version:1,authority:'model' as const,commanderVersion:0,spec:{kind:'avoid' as const,target:f.o.view.outposts[0]!.id,until,reason:id+'-reason'},status,reason:id+'-reason',createdAt:now,updatedAt:now});
 saved.intents=[intent('expired-status','expired',now+10),intent('expired-deadline','pending',now),intent('expired-result','completed',now-1),intent('live-intent','pending',now+10),intent('completed-result','completed',now+10),intent('cancelled-result','cancelled',now+10)];
 const before=structuredClone(saved);
 for(const kind of ['strategy','diplomacy','commander'] as const){
  const result=makeBrief({id:'expiry-test',kind,scope:'test',posts:[],messageIds:[],players:[]},f.state,f.snapshot,saved);
  const guidance=result.brief.guidance as any,facts=result.brief.facts as any;
  assert.deepEqual(guidance.intentTasks.rows.map((r:any[])=>r[0]),kind==='diplomacy'?[]:['live-intent']);
  if(kind==='diplomacy'){
   assert.ok(!guidance.readOnlyIntentTasks.columns.includes('id'));
   assert.ok(JSON.stringify(guidance.readOnlyIntentTasks).includes('live-intent-reason'));
  }
  assert.deepEqual(guidance.recentResults.rows.map((r:any[])=>r[0]),['completed-result','cancelled-result']);
  assert.deepEqual(guidance.intentCoverage,{active:1,terminalListed:2,terminalTotal:2});
  for(const id of ['expired-status','expired-deadline','expired-result']){
   assert.ok(!result.prompt.includes(id+'-reason'));
  }
 }
 assert.deepEqual(saved,before,'context filtering must not remove stored execution evidence');
});


test('closed agreements and their saved conversation notes do not enter model briefs',()=>{
 const f=fixture(),saved=initialHybridState(),now=f.o.view.tick+f.o.secondsSinceLastTick/600;
 const base={...assessment().agreement,conversation:'test',players:[1],tick:now,evidence:[],summary:'hidden-agreement-summary',internalIntent:'hidden-agreement-intent'};
 saved.directive={version:1,basis:basisOf(f.o),summary:'当前战略',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],commanderVersion:0,commanderConstraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]},agreements:[]};
 saved.conversations={test:{summary:'hidden-conversation-summary',internalIntent:'hidden-conversation-intent',archived:3}};
 const closed=[...(['fulfilled','expired','terminated','violated','none'] as const).map(status=>({...base,status})),{...base,status:'confirmed' as const,expiresWorldDay:now},{...base,status:'proposed' as const,tick:now-72}];
 for(const agreement of closed){
  saved.directive.agreements=[agreement];const before=structuredClone(saved);
  const result=makeBrief({id:'closed-test',kind:'diplomacy',scope:'test',posts:[],messageIds:[],players:[1]},f.state,f.snapshot,saved);
  const guidance=result.brief.guidance as any;
  assert.deepEqual(guidance.agreements,[]);assert.equal(guidance.conversation,null);
  for(const text of ['hidden-agreement-summary','hidden-agreement-intent','hidden-conversation-summary','hidden-conversation-intent'])assert.ok(!result.prompt.includes(text),text);
  assert.deepEqual(saved,before);
 }
 saved.directive.agreements=[{...base,status:'confirmed',expiresWorldDay:now+10}];
 const active=makeBrief({id:'active-test',kind:'diplomacy',scope:'test',posts:[],messageIds:[],players:[1]},f.state,f.snapshot,saved);
 assert.ok(!active.prompt.includes('hidden-agreement-summary'));assert.ok(!active.prompt.includes('hidden-agreement-intent'),'local confirmation cannot re-enter authoritative contract context');
});

test('every sector receives global mine, incoming and driller payment facts',()=>{
 const f=fixture(),own=f.o.view.outposts.filter(p=>p.owner===0),target=own[0]!;

 target.type='mine';
 f.o.view.fleets.push({id:'incoming-fixture',owner:1,drillers:37,state:'waiting',position:target.position,gift:false,destination:{kind:'outpost',id:target.id}});
 const material=makeBrief({id:'remote',kind:'strategy',scope:'remote',posts:[],messageIds:[],players:[]},f.state,f.snapshot,initialHybridState());
 const g=material.brief.global as {criticalAssets:{mines:{name:string}[];hostileApproaches:{id:string;drillers:number}[]};economy:{mineCreation:{resource:string;neptuniumIsPayment:boolean};ownPosts:unknown[][]}};
 assert.ok(g.criticalAssets.mines.some(p=>p.name===f.o.outpostNames![target.id]));assert.ok(g.criticalAssets.hostileApproaches.some(f=>f.id==='incoming-fixture'&&f.drillers===37));
 assert.equal(g.economy.mineCreation.resource,'drillers');assert.equal(g.economy.mineCreation.neptuniumIsPayment,false);assert.equal(g.economy.ownPosts.length,own.length);assert.match(material.prompt,/不消耗矿量/);
});


test('a new message does not discard a returned answer or consume unseen conversation evidence',async()=>{
 const f=backgroundFixture();
 f.snapshot.chat=[{id:'captured-inbox',from:1,to:0,text:'交换边界情报如何？',tick:0,sentAt:0}];
 try{
  f.background.observe(f.snapshot);const i=await diplomacyRequest(f);
  f.snapshot.chat.push({id:'later-inbox',from:1,to:0,text:'还有一个问题。',tick:1,sentAt:1});
  f.background.observe(f.snapshot);
  f.reply(i,assessment({summary:'先评估交换边界情报',message:'可以交换情报。'}));await turn();await turn();
  const saved=f.records.get('state') as HybridState;
  assert.ok(f.calls.some(c=>c.task==='diplomacy-1'&&c.status==='completed'));
  assert.ok(saved.handledMessages?.includes('captured-inbox'));
  assert.ok(!saved.handledMessages?.includes('later-inbox'));
  assert.equal(saved.messages.find(m=>m.messageIds.includes('captured-inbox'))?.text,'可以交换情报。');
  const later=f.requests.slice(i+1).map(r=>readPromptMaterial(r.request.prompt)).find(b=>b.kind==='diplomacy');
  assert.ok(later);assert.match(JSON.stringify(later),/later-inbox/);
 }finally{f.background.pause();await f.background.drain();}
});

test('a returned reply with a concrete current ownership conflict is discarded atomically',async()=>{
 const f=backgroundFixture(),own=f.o.view.outposts.find(p=>p.owner===0)!;
 try{
  f.background.observe(f.snapshot);
  const next=structuredClone(f.snapshot);next.observation.view.outposts.find(p=>p.id===own.id)!.owner=1;
  next.observation.revision='home-lost';next.observation.view.tick++;
  f.background.observe(next);
  f.reply(0,assessment({summary:'不能发布的旧配置',intentEdits:{upsert:[{id:null,task:{kind:'configure',target:own.id,until:f.o.view.tick+50,priority:50,minDrillers:10,maxDrillers:null,maintain:true,reason:'守备'}}],cancel:[]}}));
  await turn();await turn();
  const saved=f.records.get('state') as HybridState;
  const discarded=f.calls.find(c=>c.task==='overview'&&c.status==='stale-dependency');
  assert.ok(discarded);assert.equal(discarded.error,null);
  assert.equal(saved.directive,null);assert.equal(saved.intents?.length??0,0);
 }finally{f.background.pause();await f.background.drain();}
});
