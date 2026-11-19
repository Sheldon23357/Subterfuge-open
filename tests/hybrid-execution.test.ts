import {readPromptMaterial} from '../packages/contracts/src/prompt-sections.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {basisOf,initialHybridState,type OperationState,type DiplomacyMessage} from '../plugins/hybrid/src/contracts.js';
import {acceptOperationReceipt,reconcileOperations,operationActivity,constraints,mergeOperationProgress} from '../plugins/hybrid/src/operations.js';
import {settleDiplomacyMessage,reconcileDiplomacy,updatedAgreement} from '../plugins/hybrid/src/diplomacy-execution.js';
import {compactHybrid} from '../plugins/hybrid/src/compact.js';
import {HybridBackground} from '../plugins/hybrid/src/background.js';
import {initialState,type AgentRequest,type ModelResult as AgentResult,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {parseIntentResult} from '../plugins/hybrid/src/intent-protocol.js';
import {namedBrief} from '../plugins/hybrid/src/model-names.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {reconcileIntents,applyIntentEdits} from '../plugins/hybrid/src/intents.js';
import {diplomacyPeers} from '../plugins/hybrid/src/diplomacy-pressure.js';
import {pressureBrief} from '../plugins/hybrid/src/pressure-brief.js';
function fixture(){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const game=createFleetScenario(c),o=observation({state:game,scheduled:[]},0,'lifecycle'),state=initialHybridState();
 state.directive={version:1,basis:basisOf(o),summary:'测试战略',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],commanderVersion:0,commanderConstraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]},agreements:[]};
 const op=(actions:Record<string,unknown>[]):OperationState=>({id:'op',objective:'capture',basis:basisOf(o),strategyVersion:1,status:'proposed',drafts:actions.map((action,i)=>({id:'draft'+i,issueTick:o.view.tick,action})),orders:[],fleets:[],issues:[]});
 const message:DiplomacyMessage={id:'accept',conversation:'1',to:[1],text:'行，给你停增援。',basis:basisOf(o),messageIds:['offer'],status:'pending',agreement:{conversation:'1',players:[1],status:'confirmed',summary:'停止增援',forbidAttack:false,forbiddenTargets:[],internalIntent:'真实履约',expiresWorldDay:140,evidence:['offer'],tick:100},intentEdits:{upsert:[{id:null,task:{kind:'avoid',target:'蓝方工厂',until:150,reason:'履约'}}],cancel:[]},fulfillment:{state:'staged',taskIds:[],reason:'等待发送'}};
 state.messages=[message];return {o,state,op,message,game};
}
function activate(f:ReturnType<typeof fixture>){
 f.game=submitFleetOrder(f.game,{id:'contract',player:0,action:{kind:'propose-agreement',peer:1,terms:{kind:'ceasefire',outposts:['蓝方工厂','红方矿场']},subsidy:null,counterTo:null}}).state;
 f.game=submitFleetOrder(f.game,{id:'sign',player:1,action:{kind:'respond-agreement',agreementId:'contract',response:'accept'}}).state;
 Object.assign(f.o,observation({state:f.game,scheduled:[]},0,'lifecycle'));
 applyIntentEdits(f.state,f.message.intentEdits!,'model',0,f.o,{kind:'diplomacy',conversation:'1',agreementId:'contract'});
}
test('chat receipt cannot activate diplomatic military tasks or hard constraints',()=>{
 const f=fixture();assert.equal(f.state.intents,undefined);
 settleDiplomacyMessage(f.state,'accept','unknown',f.o);assert.equal(f.state.intents,undefined);
 settleDiplomacyMessage(f.state,'accept','accepted',f.o);
 assert.equal(f.state.intents,undefined);assert.deepEqual(constraints(f.state.directive,f.o,f.state).forbiddenTargets,[]);
 const before=structuredClone(f.state);settleDiplomacyMessage(f.state,'accept','accepted',f.o);assert.deepEqual(f.state,before);
});
test('both proposed and locally confirmed spoken promises remain nonbinding',()=>{
 const f=fixture();f.message.agreement.fulfillment='tasks';f.message.agreement.status='proposed';settleDiplomacyMessage(f.state,'accept','accepted',f.o);assert.equal(f.message.fulfillment!.state,'none');assert.equal(f.state.intents,undefined);
 f.message.agreement.status='confirmed';settleDiplomacyMessage(f.state,'accept','accepted',f.o);assert.equal(f.message.fulfillment!.state,'none');assert.equal(f.state.intents,undefined);assert.deepEqual(f.o.diplomacy!.agreements,[]);
});
test('information exchange and counterproposals preserve existing confirmed military terms',()=>{
 const f=fixture(),current={...f.message.agreement,status:'confirmed' as const,fulfillment:'rules' as const,jointAttack:{enemy:2,until:140}};
 for(const next of [{...current,status:'confirmed' as const,fulfillment:'message' as const,jointAttack:null},{...current,status:'negotiating' as const,jointAttack:null}])assert.deepEqual(updatedAgreement(current,next,100),current);
 assert.equal(updatedAgreement(current,{...current,status:'terminated'},100).status,'terminated');
});
test('failed sends, expired terms and superseded commander instructions never activate staged tasks',()=>{
 for(const result of ['failed','expired','superseded'] as const){const f=fixture();if(result==='expired')f.o.view.tick=141;if(result==='superseded')f.state.commanderVersion=1;
  settleDiplomacyMessage(f.state,'accept',result==='failed'?'failed':'accepted',f.o);assert.equal(f.state.intents,undefined,result);assert.notEqual(f.message.fulfillment?.state,'active');}
});
test('a late old send result cannot replace a newer agreement or restore old restrictions',()=>{
 for(const status of ['failed','accepted'] as const){const f=fixture(),newer={...f.message.agreement,tick:110,summary:'新的局部边界'};f.state.directive!.agreements=[newer];settleDiplomacyMessage(f.state,'accept',status,f.o);assert.deepEqual(f.state.directive!.agreements,[newer]);assert.equal(f.state.intents,undefined);}
});
test('legacy message attempts resolve by exact scoped journal identity, including definite rejection',()=>{
 const store=new AiStore(':memory:');try{
  const state=initialState('audit-room',0,{mode:'hybrid',model:'fake',personality:'schemer'});
  store.saveEvents(state,[{kind:'mode-hybrid-message-attempt',details:{id:'diplomacy-1-9',sequence:2,step:3}},{kind:'tool-intent',details:{id:'ai-0-2-3',tool:'say',arguments:{text:'测试'}}},{kind:'tool-rejected',details:{id:'ai-0-2-3',tool:'say',code:'REVISION_CONFLICT'}}]);
  const found=store.modeReceipt('audit-room',0,'mode-hybrid-message-attempt','diplomacy-1-9');assert.equal(found!.requestId,'ai-0-2-3');assert.equal((found!.receipt as {result:{status:string}}).result.status,'rejected');assert.equal(store.modeReceipt('other-room',0,'mode-hybrid-message-attempt','diplomacy-1-9'),undefined);assert.equal(store.modeReceipt('audit-room',1,'mode-hybrid-message-attempt','diplomacy-1-9'),undefined);
 }finally{store.close();}
});
test('expiry releases treaty rules and tasks without retracting already accepted operations',()=>{
 const f=fixture();activate(f);const op=f.op([{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:1}]);op.status='underway';op.intentBindings=[{id:f.state.intents![0]!.id,version:1}];const before=structuredClone(op);
 f.game=advanceFleetScenario(f.game,200);Object.assign(f.o,observation({state:f.game,scheduled:[]},0,'lifecycle'));
 assert.equal(reconcileDiplomacy(f.state,f.o),true);assert.equal(f.o.diplomacy!.agreements[0]!.status,'completed');assert.equal(f.state.intents![0]!.status,'cancelled');assert.deepEqual(op,before);assert.deepEqual(constraints(f.state.directive,f.o,f.state).forbiddenTargets,[]);
});
test('undated local proposals and confirmations cannot become server obligations',()=>{
 const f=fixture();f.state.directive!.agreements=[{...f.message.agreement,status:'proposed',expiresWorldDay:null,tick:1},{...f.message.agreement,conversation:'other',status:'confirmed',expiresWorldDay:null,tick:1}];
 reconcileDiplomacy(f.state,f.o);assert.deepEqual(f.state.directive!.agreements,[]);assert.deepEqual(f.o.diplomacy!.agreements,[]);
});
const receipt=(statuses:string[],orders:string[])=>({id:'batch',tool:'batch',result:{results:statuses.map((status,index)=>({index,id:'command'+index,status,protocolReceipt:{effects:{orderId:orders[index]}}}))}});
test('instant operations close on actual acceptance and transport remains open until exact settlement evidence',()=>{
 const f=fixture(),p=f.op([{kind:'hire',choice:0,hireNumber:0},{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:1}]);
 acceptOperationReceipt(p,receipt(['accepted','accepted'],['instant','fleet']),f.o);
 let next=reconcileOperations([p],f.o)[0]!;assert.equal(next.commands![0]!.state,'completed');assert.equal(next.commands![1]!.state,'accepted');assert.notEqual(next.status,'completed');
 f.o.activity=[{id:0,kind:'fleet-arrived',tick:101,seconds:0,actor:0,subject:'fleet',source:'蓝方工厂',destination:{kind:'outpost',id:'红方矿场'},drillers:1,enabled:null,arrival:{outpost:'红方矿场',outcome:'delivered',drillers:1}}];
 next=reconcileOperations([next],f.o)[0]!;assert.equal(next.status,'completed');assert.equal(next.commands![1]!.evidenceId,0);assert.deepEqual(next.issues,[]);
});
test('rejection closes a failed operation; unknown or missing children never inherit sibling acceptance',()=>{
 const f=fixture(),p=f.op([{kind:'hire'},{kind:'hire'}]);acceptOperationReceipt(p,receipt(['accepted','rejected'],['one','two']),f.o);assert.equal(reconcileOperations([p],f.o)[0]!.status,'failed');
 const unknown=f.op([{kind:'hire'},{kind:'hire'}]);acceptOperationReceipt(unknown,receipt(['accepted'],['one']),f.o);const next=reconcileOperations([unknown],f.o)[0]!;assert.equal(next.status,'review');assert.equal(next.commands![1]!.state,'unknown');
});

test('authoritative transport settlement is distinct from rejection and never claims delivery after defeat or recall',()=>{
 for(const outcome of ['defeated','removed','recovered','recalled','cancelled'] as const){
  const f=fixture(),p=f.op([{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:1}]);
  acceptOperationReceipt(p,receipt(['accepted'],['fleet']),f.o);
  const event={id:0,kind:'fleet-arrived',tick:f.o.view.tick,seconds:0,actor:0,subject:'fleet',source:'蓝方工厂',destination:{kind:'outpost' as const,id:'红方矿场'},drillers:1,enabled:null};
  f.o.activity=[outcome==='defeated'?{...event,arrival:{outpost:'红方矿场',outcome,drillers:0}}:outcome==='removed'||outcome==='recovered'?{...event,kind:'fleet-removed',termination:{outcome,outpost:null,drillers:0}}:{...event,kind:outcome==='recalled'?'fleet-recalled':'launch-cancelled'}];
  const next=reconcileOperations([p],f.o)[0]!;
  assert.equal(next.status,outcome==='recalled'||outcome==='cancelled'?'cancelled':'ended');
  assert.equal(next.commands![0]!.settlement,outcome);assert.equal(next.commands![0]!.evidenceId,0);
  assert.notEqual(next.commands![0]!.state,'completed');assert.notEqual(next.commands![0]!.state,'failed');
  assert.deepEqual(mergeOperationProgress([p],[next])[0],next,'terminal settlement cannot regress to accepted');
 }
});
test('historical authorized settlements repair old operations and non-launch receipts do not wait for fleet arrivals',async()=>{
 const f=fixture(),p=f.op([{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:1}]);p.receiptIds=['batch'];p.status='accepted';p.orders=['fleet'];f.o.activity=[];f.o.activityCursor=2;
 const event={id:0,kind:'fleet-arrived',tick:101,seconds:0,actor:0,subject:'fleet',source:'蓝方工厂',destination:{kind:'outpost',id:'红方矿场'},drillers:1,enabled:null,arrival:{outpost:'红方矿场',outcome:'delivered' as const,drillers:1}};
 const result=await operationActivity([p],f.o,0,async(after,through)=>({events:[{...event,id:after}],nextCursor:after+1,through}),()=>receipt(['accepted'],['fleet']));
 assert.equal(result.cursor,2);assert.equal(result.operations[0]!.status,'completed');
 const instant=f.op([{kind:'create-mine',outpostId:'蓝方工厂'}]);instant.receiptIds=['batch'];instant.status='accepted';instant.orders=['order'];assert.equal(reconcileOperations([instant],f.o,()=>receipt(['accepted'],['order']))[0]!.status,'completed');
 await assert.rejects(operationActivity([p],f.o,0,async()=>({events:[],through:2,nextCursor:2})),/Incomplete/);
});
test('compaction bounds ended records, preserves unresolved operations and unread evidence, and is idempotent',()=>{
 const f=fixture(),ops=Array.from({length:40},(_,i)=>({...f.op([]),id:'op'+i,status:'completed' as const}));
 const unresolved={...f.op([]),id:'uncertain',status:'review' as const};
 f.state.chat=Array.from({length:40},(_,i)=>({id:'chat'+i,from:i%2,to:i%2===0?1:0,text:'消息',tick:i,sentAt:0}));f.state.handledMessages=f.state.chat.slice(0,38).map(m=>m.id);
 const next=compactHybrid(f.state,[...ops,unresolved],0);assert.equal(next.length,13);assert.ok(next.includes(unresolved));assert.ok(f.state.chat.some(m=>m.id==='chat38'));assert.ok(f.state.chat.some(m=>m.id==='chat39'));assert.ok(f.state.chat.length<=4);
 const before=structuredClone(f.state);assert.deepEqual(compactHybrid(f.state,next,0),next);assert.deepEqual(f.state,before);
});

test('background rejects military commitments attached only to an unsigned spoken offer',async()=>{
 const f=fixture(),s=initialState(f.o.roomId,0,{mode:'hybrid',model:'fake',personality:'schemer'});s.enabled=true;s.sequence=1;
 const records=new Map<string,unknown>(),calls:{request:AgentRequest;resolve:(r:AgentResult)=>void}[]=[];
 const snapshot:AiSnapshot={observation:f.o,chat:[{id:'offer',from:1,to:0,text:'你停止向蓝方工厂增援，我就不进攻。',tick:100,sentAt:0}],notifications:[],chatCursor:1,notificationCursor:0,chatPlayer:0,chatCount:2};
 const background=new HybridBackground({state:s,latest:<T>(k:string)=>records.get(k) as T|undefined,record:(k,v)=>records.set(k,structuredClone(v)),wake:()=>{},model:{step:request=>new Promise((resolve,reject)=>{calls.push({request,resolve});request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})}});
 try{
  background.observe(snapshot);assert.equal(readPromptMaterial(calls[0]!.request.prompt).kind,'strategy');
  calls[0]!.resolve({tokens:0,reply:{summary:'维持守备并等待会话评审',tasks:{upsert:[],cancel:[]},reviewOn:[]}});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(readPromptMaterial(calls[1]!.request.prompt).kind,'diplomacy');
  const agreement={...f.message.agreement,fulfillment:'tasks'} as Record<string,unknown>;delete agreement.conversation;delete agreement.players;delete agreement.evidence;delete agreement.tick;agreement.jointAttack=null;
  calls[1]!.resolve({tokens:0,reply:namedBrief({summary:'以停增援换取局部缓压',tasks:f.message.intentEdits,reviewOn:[],message:'行，我停增援。',agreement},f.o)});
  await new Promise<void>(resolve=>setImmediate(resolve));
  const rejected=records.get('state') as ReturnType<typeof initialHybridState>;
  assert.equal(rejected.messages.length,0);assert.ok(!rejected.intents?.length);
  assert.ok(rejected.tasks.some(t=>t.status==='failed'&&/协议|permission denied/.test(t.error??'')),'invalid publication must retain its explicit validation failure');

 }finally{background.pause();await background.drain();}
});

test('new diplomacy replies must explicitly distinguish military fulfillment, direct rules, information and deception',()=>{
 const f=fixture(),agreement={status:'confirmed',summary:'互不攻击',forbidAttack:true,forbiddenTargets:[],internalIntent:'真实边界',expiresWorldDay:140,jointAttack:null};
 const raw={summary:'边界',tasks:{upsert:[],cancel:[]},reviewOn:[],message:'行。',agreement};
 assert.throws(()=>parseIntentResult(raw,'diplomacy',2,new Set()),/fulfillment/);
 assert.equal(parseIntentResult({...raw,agreement:{...agreement,fulfillment:'rules'}},'diplomacy',2,new Set()).agreement.fulfillment,'rules');
 assert.throws(()=>parseIntentResult({...raw,agreement:{...agreement,fulfillment:'none'}},'diplomacy',2,new Set()),/fulfillment/);
 assert.equal(parseIntentResult({...raw,agreement:{...agreement,fulfillment:'deception',forbidAttack:false}},'diplomacy',2,new Set()).agreement.fulfillment,'deception');
});

test('failed atomic publication rolls back strategic edits while preserving the failed call state',async()=>{
 const f=fixture(),s=initialState(f.o.roomId,0,{mode:'hybrid',model:'fake',personality:'schemer'});s.enabled=true;
 const records=new Map<string,unknown>(),calls:{resolve:(r:AgentResult)=>void}[]=[];
 const background=new HybridBackground({state:s,latest:<T>(k:string)=>records.get(k) as T|undefined,record:(k,v)=>records.set(k,structuredClone(v)),wake:()=>{},model:{step:request=>new Promise((resolve,reject)=>{calls.push({resolve});request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})}});
 try{background.observe({observation:f.o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2});calls[0]!.resolve({tokens:0,reply:namedBrief({summary:'不能发布的配置',tasks:{upsert:[{id:null,task:{kind:'configure',target:'红方矿场',until:140,reason:'错误配置',priority:70,minDrillers:10,maxDrillers:null,maintain:false}}],cancel:[]},reviewOn:[]},f.o)});await new Promise<void>(r=>setImmediate(r));
  const state=records.get('state') as ReturnType<typeof initialHybridState>;assert.equal(state.directive,null);assert.ok(!state.intents?.length);assert.equal(state.tasks[0]!.status,'failed');assert.match(state.tasks[0]!.error!,/friendly|permission denied/);
 }finally{background.pause();await background.drain();}
});

test('diplomatic pressure briefs retain causal facts without duplicating full planner traces',()=>{
 const need={id:'defense:蓝方工厂',kind:'defense-pressure' as const,targets:['蓝方工厂'],opponents:[1],evidence:{actualIncoming:[{id:'incoming',drillers:30}],arrivalShortfall:10,estimatedShortfall:20,pressureRatio:2,earliestDeficitTicks:4,selected:'hold',search:{trace:'trace'.repeat(2000)},localResponses:[{trace:'trace'.repeat(2000)}]},limits:['估算不是结算']};
 const before=structuredClone(need),projected=pressureBrief([need]);assert.equal(projected[0]!.evidence.arrivalShortfall,10);assert.equal(projected[0]!.evidence.earliestDeficitWorldDays,4);assert.deepEqual(projected[0]!.evidence.actualIncoming,need.evidence.actualIncoming);assert.ok(JSON.stringify(projected).length<JSON.stringify(need).length/10);assert.deepEqual(need,before);
});


test('foreground publication preserves settlements observed by background while awaiting search or history',()=>{
 const f=fixture(),p=f.op([]),completed={...p,status:'completed' as const,finishedAt:103,commands:[{draftId:'d',requestId:'r',state:'completed' as const,evidenceId:7}]};
 assert.deepEqual(mergeOperationProgress([p],[completed]),[completed]);
 assert.deepEqual(mergeOperationProgress([completed],[p]),[completed]);
 const current={...p,commands:completed.commands},stale={...p,commands:[{draftId:'d',requestId:'r',state:'accepted' as const}]};
 assert.equal(mergeOperationProgress([stale],[current])[0]!.commands![0]!.evidenceId,7);
 assert.equal(mergeOperationProgress([p],[{...completed,id:'other'}]).length,2);
});


test('compaction retains newly settled records even when unresolved rows were kept before old history',()=>{
 const f=fixture(),oldOps=Array.from({length:20},(_,i)=>({...f.op([]),id:'old'+i,status:'completed' as const,finishedAt:i}));
 const recent={...f.op([]),id:'just-settled',status:'completed' as const,finishedAt:120};
 const oldMessages=Array.from({length:12},(_,i)=>({...structuredClone(f.message),id:'old'+i,status:'accepted' as const,basis:{...f.message.basis,tick:i},fulfillment:{state:'none' as const,taskIds:[],reason:''}}));
 const current={...structuredClone(f.message),id:'new-send',status:'accepted' as const,basis:{...f.message.basis,tick:120},fulfillment:{state:'active' as const,taskIds:[],reason:''}};
 f.state.messages=[current,...oldMessages];f.state.directive!.agreements=[current.agreement];
 const next=compactHybrid(f.state,[recent,...oldOps],0);assert.ok(next.some(p=>p.id==='just-settled'));assert.ok(f.state.messages.some(m=>m.id==='new-send'));assert.ok(!f.state.messages.some(m=>m.id==='old0'));
});

test('unsubmitted operations close only from scoped supersession evidence with no batch dispatch',()=>{
 const store=new AiStore(':memory:');try{
  const state=initialState('audit-room',0,{mode:'hybrid',model:'fake',personality:'schemer'});
  store.saveEvents(state,[{kind:'mode-hybrid-operations',details:{sequence:9,step:0,operations:[{id:'operation-9',status:'proposed'}]}},{kind:'reply-superseded',details:{sequence:9,step:0}}]);
  const found=store.modeReceipt('audit-room',0,'mode-hybrid-operations','operation-9');assert.equal(found!.requestId,'ai-0-9-0');assert.equal((found!.receipt as any).result.status,'not-executed');
  assert.equal(store.modeReceipt('other-room',0,'mode-hybrid-operations','operation-9'),undefined);assert.equal(store.modeReceipt('audit-room',1,'mode-hybrid-operations','operation-9'),undefined);
  store.saveEvents(state,[{kind:'tool-intent',details:{id:'ai-0-9-1',tool:'batch'}}]);assert.equal(store.modeReceipt('audit-room',0,'mode-hybrid-operations','operation-9'),undefined);
 }finally{store.close();}
});


test('stalemate contact prefers observed respondents and rotates peers beyond the first two seats',()=>{
 const f=fixture();f.o.view.playerCount=4;f.o.intel=[0,1,2,3].map(player=>({...f.o.intel[0]!,player,active:true}));
 const snapshot:AiSnapshot={observation:f.o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:4,roster:[0,1,2,3].map(gamePlayer=>({gamePlayer,chatPlayer:gamePlayer,displayName:'玩家'+gamePlayer}))};
 const need={id:'stalemate',kind:'stalemate' as const,targets:[],opponents:[],evidence:{},limits:[]};
 const chat=[{id:'reply',from:3,to:0,text:'可以合作',tick:90,sentAt:0}];
 assert.equal(diplomacyPeers(snapshot,[need],chat)[0]!.game,3);
 assert.equal(diplomacyPeers(snapshot,[need],[],{'1':{wall:10,tick:90},'2':{wall:20,tick:91}})[0]!.game,3);
 assert.ok(diplomacyPeers(snapshot,[need]).every(p=>Number.isFinite(p.rank)));
});


test('fact reconciliation preserves the last configuration assessment until a new plan evaluation',()=>{
 const f=fixture();activate(f);const t=f.state.intents![0]!;
 t.spec={kind:'configure',target:'蓝方工厂',until:140,reason:'协防',priority:70,minDrillers:100000,maxDrillers:null,maintain:false};t.status='blocked';t.reason='安全可调兵力或期限内航程不足';
 reconcileIntents(f.o,f.state,[]);assert.equal(t.status,'blocked');assert.equal(t.reason,'安全可调兵力或期限内航程不足');
 f.o.view.outposts.find(p=>p.id==='蓝方工厂')!.drillers=100000;reconcileIntents(f.o,f.state,[]);assert.equal(t.status,'completed');
});


test('unsigned unilateral proposals never create constraints at all',()=>{
 const f=fixture();f.message.agreement.status='proposed';f.message.agreement.fulfillment='rules';f.message.agreement.expiresWorldDay=null;
 f.message.intentEdits={upsert:[{id:null,task:{kind:'avoid',target:'红方矿场',until:500,reason:'提案期间克制'}}],cancel:[]};
 settleDiplomacyMessage(f.state,'accept','accepted',f.o);assert.equal(f.state.intents,undefined);
 f.o.view.tick=173;reconcileDiplomacy(f.state,f.o);assert.equal(f.state.intents,undefined);assert.deepEqual(constraints(f.state.directive,f.o,f.state).forbiddenTargets,[]);
});


test('informational follow-up cannot duplicate or modify a signed contract task',()=>{
 const f=fixture();activate(f);
 const id=f.state.intents![0]!.id;
 f.state.messages.push({...structuredClone(f.message),id:'followup',status:'pending',intentEdits:{upsert:[],cancel:[]},fulfillment:{state:'staged',taskIds:[],reason:'等待发送'}});
 settleDiplomacyMessage(f.state,'followup','accepted',f.o);
 assert.equal(f.state.messages[1]!.fulfillment!.state,'none');assert.deepEqual(f.state.messages[1]!.fulfillment!.taskIds,[]);assert.equal(f.state.intents!.length,1);assert.equal(f.state.intents![0]!.id,id);
});
