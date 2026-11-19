import test from 'node:test';
import assert from 'node:assert/strict';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {initialHybridState,type HybridState,type StrategicAssessment} from '../plugins/hybrid/src/contracts.js';
import {initialState,type AiSnapshot,type GameGateway} from '../packages/ai/src/controller/contracts/types.js';
import type {BatchEffect} from '../packages/ai/src/controller/contracts/batch-effect.js';
import type {BotModeServices} from '../packages/ai/src/controller/contracts/bot-mode.js';
import {ceasefirePlan,ceasefireAvoidTargets} from '../plugins/hybrid/src/ceasefire.js';
import {publishContractIntent,contractCommandStep} from '../plugins/hybrid/src/server-contracts.js';
import {reconcileDiplomacy} from '../plugins/hybrid/src/diplomacy-execution.js';
import {guardHybridExecution} from '../plugins/hybrid/src/execution-guard.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {executeToolResult} from '../packages/ai/src/controller/execution/tool-results.js';
import {ControllerSeatRunner} from '../packages/ai/src/controller/runtime/runner.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {GameTransportError} from '../packages/ai/src/controller/transport/gateway.js';
import {BatchTransportError} from '../packages/ai/src/controller/execution/batch-outcome.js';
import {tacticalGuidanceAllows,type TacticalGuidance} from '../packages/ai/src/controller/analysis/tactical-planner.js';

function fixture(){
 const setup:FleetSetup={size:{width:40,height:40},positions:{a:{x:0,y:0},b:{x:3,y:0},c:{x:15,y:0}},economy:{initialTick:0,teamSize:0,
  players:Array.from({length:3},()=>({active:true,neptunium:100,minesCreated:0})),outposts:['a','b','c'].map((id,owner)=>({id,owner,type:'generator',drillers:100,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))}};
 const room={state:createFleetScenario(setup),scheduled:[]};
 room.state=submitFleetOrder(room.state,{id:'attack',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:41}}).state;
 room.state=submitFleetOrder(room.state,{id:'offer',player:1,action:{kind:'propose-agreement',peer:0,terms:{kind:'ceasefire',outposts:['a','b']},subsidy:null,counterTo:null}}).state;
 const saved=initialHybridState(),records=new Map<string,any>();let receipt:unknown,sequence=1;
 const services={record:(kind:string,value:unknown)=>records.set(kind,{...structuredClone(value as object),sequence}),latest:(kind:string)=>records.get(kind),attemptReceipt:()=>receipt?{requestId:'same',receipt}:undefined} as unknown as BotModeServices;
 const observe=()=>observation(room,0,'test');
 const assessment:StrategicAssessment={summary:'',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],message:null,agreement:{status:'none',fulfillment:'none',summary:'',internalIntent:'已评估撤军损失',forbidAttack:false,forbiddenTargets:[],jointAttack:null,expiresWorldDay:null},diplomacyAction:{kind:'respond-agreement',agreementId:'offer',response:'accept'},intentEdits:{upsert:[],cancel:[]}};
 const publish=()=>publishContractIntent(saved,observe(),assessment,'1',[1],0);
 const guard=(tool:string,args:string|Record<string,unknown>,batchEffect?:BatchEffect,current?:AiSnapshot)=>{
  const o=current?.observation??observe(),state=initialState(o.roomId,0,{mode:'hybrid',model:'',personality:'schemer'});state.sequence=sequence;
  const snapshot:AiSnapshot=current??{observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3};
  guardHybridExecution({state,snapshot,tool,arguments:args,...(batchEffect?{batchEffect}:{}),latest:services.latest} as Parameters<typeof guardHybridExecution>[0]);
 };
 return {room,saved,observe,assessment,publish,records,services,guard,nextRound:()=>sequence++,setReceipt:(r:unknown)=>receipt=r};
}

test('ceasefire evaluation states exact odd-force recall loss and never assumes peer withdrawal',()=>{
 const f=fixture(),o=f.observe(),p=ceasefirePlan(o,1,['a','b'],f.saved);
 assert.equal(p.withdrawals.length,1);assert.equal(p.withdrawals[0]!.drillers,41);
 assert.equal(p.withdrawals[0]!.survivingDrillers,20);assert.equal(p.totalOwnLostDrillers,21);
 assert.equal(p.withdrawals[0]!.returnBaseFriendly,true);assert.deepEqual(p.blockers,[]);
 assert.equal(ceasefirePlan(o,1,['a'],f.saved).withdrawals.length,0);
 o.view.fleets.push({...o.view.fleets[0]!,id:'peer',owner:1,destination:{kind:'outpost',id:'a'}});
 assert.equal(ceasefirePlan(o,1,['a','b'],f.saved).peerApproaches[0]!.withdrawalConfirmed,false);
});

function doubleWithdrawal(){
 const f=fixture();
 f.room.state=submitFleetOrder(f.room.state,{id:'attack-two',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:9}}).state;
 f.publish();const batch=contractCommandStep(f.saved,f.observe(),f.services,0)!;
 assert.equal(f.saved.contractCommands![0]!.ceasefireReview!.withdrawals.length,2);
 const calls:string[]=[],contexts:BatchEffect[]=[],o=f.observe(),state=initialState(o.roomId,0,{mode:'hybrid',model:'',personality:'schemer'});
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3};
 const execute=async(options:{beforeChild?:(index:number,current:AiSnapshot)=>void;failRequest?:(index:number)=>void}={})=>{
  f.guard(batch.reply.tool,batch.reply.arguments);
  const result=await executeToolResult(batch.reply.tool,batch.reply.arguments,{
   state,snapshot,id:'recall-batch',now:0,spoken:0,
   beforeEffect:(tool,args,current,effect)=>{
    assert.ok(effect);contexts.push(structuredClone(effect));
    options.beforeChild?.(effect.index,current);f.guard(tool,args,effect,current);
   },
   gateway:{snapshot:async()=>snapshot,request:async(_path,data)=>{
    const order=(data as {order:{id:string;action:{kind:'return-fleet';fleetId:string}}}).order;
    calls.push(order.id);options.failRequest?.(calls.length-1);
    f.room.state=submitFleetOrder(f.room.state,{...order,player:0}).state;
    return f.observe();
   }},
  });
  f.setReceipt({result:result.result});return result.result as {results:{status:string}[];complete:boolean};
 };
 return {...f,batch,calls,contexts,execute};
}

test('attack bans allow own fleet return to own home, while hostile returns and launches remain constrained',()=>{
 const f=fixture(),o=f.observe(),fleet=o.view.fleets.find(f=>f.owner===o.view.player)!;
 const drafts=[{id:'recall',issueTick:0,action:{kind:'return-fleet',fleetId:fleet.id}}];
 for(const field of ['forbiddenTargets','contractAvoidTargets'] as const){
  const guidance:TacticalGuidance={forbiddenPlayers:[],protectedSources:[],reserves:[],objectives:[],rotation:0,[field]:['a']};
  assert.equal(tacticalGuidanceAllows(o,drafts,guidance),true);
  const hostile=structuredClone(o);hostile.view.outposts.find(p=>p.id==='a')!.owner=1;
  assert.equal(tacticalGuidanceAllows(hostile,drafts,guidance),false,'enemy-held home remains an attack target');
  const unknown=structuredClone(o);unknown.view.outposts.find(p=>p.id==='a')!.owner=null;
  assert.equal(tacticalGuidanceAllows(unknown,drafts,guidance),false,'unowned home does not receive a friendly-return exemption');
  const foreign=structuredClone(o);foreign.view.fleets.find(f=>f.id===fleet.id)!.owner=1;
  assert.equal(tacticalGuidanceAllows(foreign,drafts,guidance),false,'foreign fleets do not receive the exemption');
  assert.equal(tacticalGuidanceAllows(o,[{id:'launch',issueTick:0,action:{kind:'launch',source:'a',destination:'b',drillers:1}}],{...guidance,[field]:['b']}),false);
 }
});

test('real executor recalls both fleets with accepted-prefix evidence before the exact proposal can be signed',async()=>{
 const f=doubleWithdrawal(),outcome=await f.execute();
 assert.equal(outcome.complete,true);assert.deepEqual(outcome.results.map(r=>r.status),['accepted','accepted']);
 assert.deepEqual(f.contexts.map(c=>c.accepted.length),[0,1]);
 assert.deepEqual(f.contexts[1]!.accepted,[{index:0,requestId:'recall-batch-item-0'}]);
 const recalls=f.room.state.events.filter(e=>e.kind==='fleet-recalled');assert.equal(recalls.length,2);
 assert.equal(recalls.reduce((n,e)=>n+Number(e.details.lost),0),26);
 f.nextRound();assert.equal(contractCommandStep(f.saved,f.observe(),f.services,0)!.reply.tool,'order');
 assert.equal(f.saved.contractCommands![0]!.ceasefireReview!.withdrawalStatus,'confirmed');
});

test('child checks reject a forged fleet, missing prefix and disappearance without a successful prior receipt',()=>{
 const f=doubleWithdrawal(),actions=(f.batch.reply.arguments as {actions:BatchEffect['actions']}).actions;
 const effect:BatchEffect={id:'recall-batch',index:0,actions,accepted:[]};
 assert.throws(()=>f.guard('order',{action:{kind:'return-fleet',fleetId:'foreign'}},effect),/子命令/);
 assert.throws(()=>f.guard('order',actions[0]!.arguments),/缺少执行器批次依据/);
 assert.throws(()=>f.guard('order',actions[1]!.arguments,{...effect,index:1}),/前序命令/);
 const changed=structuredClone(actions);changed[1]!.arguments={action:{kind:'return-fleet',fleetId:'foreign'}};
 assert.throws(()=>f.guard('order',actions[0]!.arguments,{...effect,actions:changed}),/子命令/);
});

for(const change of ['force','home','return-permission','new-conflict'] as const)test(`real executor stops on ${change} changes after an accepted recall and never signs`,async()=>{
 const f=doubleWithdrawal(),outcome=await f.execute({beforeChild:(index,current)=>{
  if(index!==1)return;
  const id=f.saved.contractCommands![0]!.ceasefireReview!.withdrawals[1]!.fleetId;
  const fleet=current.observation.view.fleets.find(f=>f.id===id)!;
  if(change==='force')fleet.drillers++;
  if(change==='home')current.observation.view.outposts.find(p=>p.id==='a')!.owner=2;
  if(change==='return-permission')fleet.canReturn=false;
  if(change==='new-conflict')current.observation.view.fleets.push({...fleet,id:'new-conflict'});
 }});
 assert.equal(outcome.complete,false);assert.deepEqual(outcome.results.map(r=>r.status),['accepted','rejected']);
 assert.equal(f.calls.length,1);assert.equal(f.room.state.events.filter(e=>e.kind==='fleet-recalled').length,1);
 f.nextRound();assert.equal(contractCommandStep(f.saved,f.observe(),f.services,0),null);
 assert.equal(f.saved.contractCommands![0]!.status,'failed');assert.equal(f.room.state.diplomacy.agreements[0]!.status,'proposed');
});

test('unknown second recall retains its original request and never repeats or submits the treaty',async()=>{
 const f=doubleWithdrawal();
 await assert.rejects(f.execute({failRequest:index=>{if(index===1)throw new GameTransportError();}}),error=>{
  assert.ok(error instanceof BatchTransportError);assert.deepEqual(error.outcome.results.map(r=>r.status),['accepted','unknown']);
  f.setReceipt({result:error.outcome});return true;
 });
 f.nextRound();assert.equal(contractCommandStep(f.saved,f.observe(),f.services,0)!.reply.tool,'finish');
 assert.equal(f.saved.contractCommands![0]!.ceasefireReview!.withdrawalStatus,'unknown');
 assert.deepEqual(f.calls,['recall-batch-item-0','recall-batch-item-1']);
});

test('controller runner passes real batch evidence through admission, per-child guards and restart recovery',async()=>{
 const f=fixture();f.room.state=submitFleetOrder(f.room.state,{id:'attack-two',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:9}}).state;f.publish();
 const state=initialState('test',0,{mode:'hybrid',model:'',personality:'schemer'}),store=new AiStore(':memory:'),requests:string[]=[];
 const snapshot=():AiSnapshot=>({observation:f.observe(),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3});
 const gateway:GameGateway={snapshot:async()=>snapshot(),request:async(path,data)=>{
  assert.equal(path,'/tool/order');const order=(data as {order:{id:string;action:any}}).order;requests.push(order.action.kind);
  f.room.state=submitFleetOrder(f.room.state,{...order,player:0}).state;return f.observe();
 }};
 const {createBackground,...mode}=hybridMode;
 try{
  store.saveEvents(state,[{kind:'mode-hybrid-state',details:f.saved}]);
  const runner=new ControllerSeatRunner(state,store,gateway,{step:async()=>assert.fail('No model request is needed')},1,{},()=>mode);
  await runner.poll(1000,true,false,{oneRoundPerTick:true});
  assert.deepEqual(requests,['return-fleet','return-fleet']);
  assert.equal(store.latest<HybridState>('test',0,'mode-hybrid-state')!.contractCommands![0]!.ceasefireReview!.withdrawalStatus,'confirmed','whole-batch receipt updates withdrawal state without another round');
  f.room.state=advanceFleetScenario(f.room.state,1);
  const restarted=new ControllerSeatRunner(state,store,gateway,{step:async()=>assert.fail('No model request is needed')},1,{},()=>mode);
  await restarted.poll(2000,true,false,{oneRoundPerTick:true});
  assert.deepEqual(requests,['return-fleet','return-fleet','respond-agreement']);
  assert.equal(f.room.state.diplomacy.agreements[0]!.status,'active');
 }finally{store.close();}
});

test('acceptance recalls first, waits for exact receipts across restart, then signs without later violation',()=>{
 const f=fixture();f.publish();
 const first=contractCommandStep(f.saved,f.observe(),f.services,0)!;
 assert.equal(first.reply.tool,'batch');assert.equal(f.saved.contractCommands![0]!.status,'pending');
 assert.equal(f.saved.contractCommands![0]!.ceasefireReview!.withdrawalStatus,'unknown');
 assert.doesNotThrow(()=>f.guard(first.reply.tool,first.reply.arguments));
 const restored=structuredClone(f.saved);
 assert.equal(contractCommandStep(restored,f.observe(),f.services,0)!.reply.tool,'finish');
 assert.equal(restored.contractCommands![0]!.id,f.saved.contractCommands![0]!.id);
 const fleet=ceasefirePlan(f.observe(),1,['a','b']).withdrawals[0]!;
 f.room.state=submitFleetOrder(f.room.state,{id:'recall',player:0,action:{kind:'return-fleet',fleetId:fleet.fleetId}}).state;
 f.setReceipt({result:{results:[{index:0,status:'accepted'}]}});
 f.nextRound();
 const sign=contractCommandStep(f.saved,f.observe(),f.services,0)!;
 assert.equal(sign.reply.tool,'order');assert.doesNotThrow(()=>f.guard(sign.reply.tool,sign.reply.arguments));
 f.room.state=submitFleetOrder(f.room.state,{id:'sign',player:0,action:f.assessment.diplomacyAction!}).state;
 f.room.state=advanceFleetScenario(f.room.state,50);
 assert.equal(f.room.state.diplomacy.agreements[0]!.status,'active');
 assert.ok(!f.room.state.diplomacy.receipts.some(r=>r.details.reason==='ceasefire-violated'));
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(f.room.state)),f.room.state);
});

test('stale loss, unsafe home or no return permission blocks blind acceptance',()=>{
 const f=fixture(),captured=f.observe(),current=structuredClone(captured);current.view.fleets[0]!.drillers++;
 assert.throws(()=>publishContractIntent(f.saved,current,f.assessment,'1',[1],0,captured),/损失或在途风险已变化/);
 current.view.fleets[0]!.canReturn=false;
 assert.throws(()=>publishContractIntent(f.saved,current,f.assessment,'1',[1],0),/无法安全撤回/);
 const home=current.view.outposts.find(p=>p.id==='a')!;home.owner=2;current.view.fleets[0]!.canReturn=true;
 assert.ok(ceasefirePlan(current,1,['b'],f.saved).blockers.some(b=>b.reason.includes('接收点')));
});

test('withdrawal rejection or new hostile fleet prevents signing and does not resend a recall',()=>{
 const f=fixture();f.publish();contractCommandStep(f.saved,f.observe(),f.services,0);
 f.setReceipt({result:{results:[{index:0,status:'rejected'}]}});
 assert.equal(contractCommandStep(f.saved,f.observe(),f.services,0),null);
 assert.equal(f.saved.contractCommands![0]!.status,'failed');
 const g=fixture();g.publish();const batch=contractCommandStep(g.saved,g.observe(),g.services,0)!;
 g.room.state=submitFleetOrder(g.room.state,{id:'new-attack',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:5}}).state;
 assert.throws(()=>g.guard(batch.reply.tool,batch.reply.arguments),/依据已变化/);
});

test('signature by peer schedules missing recalls once; own pending offers avoid a new hostile launch',()=>{
 const f=fixture();f.room.state=submitFleetOrder(f.room.state,{id:'sign',player:0,action:f.assessment.diplomacyAction!}).state;
 reconcileDiplomacy(f.saved,f.observe());
 assert.equal(f.saved.intents?.filter(t=>t.spec.kind==='return-fleet').length,1);
 reconcileDiplomacy(f.saved,f.observe());assert.equal(f.saved.intents?.length,1);
 assert.deepEqual(ceasefireAvoidTargets(f.observe(),f.saved),['b']);
 f.saved.betrayAgreements=['offer'];assert.deepEqual(ceasefireAvoidTargets(f.observe(),f.saved),[]);
 const g=fixture();g.room.state=submitFleetOrder(g.room.state,{id:'own-offer',player:0,action:{kind:'propose-agreement',peer:1,terms:{kind:'ceasefire',outposts:['a','b']},subsidy:null,counterTo:null}}).state;
 assert.deepEqual(ceasefireAvoidTargets(g.observe(),g.saved),['b']);
});

test('withdrawal recovery distinguishes unopened writes, unresolved writes and real batch receipts by original identity',()=>{
 const store=new AiStore(':memory:'),state=initialState('recall-recovery',0,{mode:'hybrid',model:'',personality:'schemer'});
 try{
  store.saveEvents(state,[{kind:'mode-hybrid-contract-withdrawal-attempt',details:{id:'contract',sequence:2,step:3}}]);
  const lookup=()=>store.modeReceipt(state.roomId,0,'mode-hybrid-contract-withdrawal-attempt','contract');
  assert.equal((lookup()!.receipt as any).result.status,'not-executed');
  store.saveEvents(state,[{kind:'tool-intent',details:{id:'ai-0-2-3',tool:'batch'}}]);
  assert.equal(lookup()!.receipt,undefined);
  const receipt={id:'ai-0-2-3',tool:'batch',result:{results:[{index:0,status:'accepted'}]}};
  store.saveEvents(state,[{kind:'tool-result',details:receipt}]);
  assert.deepEqual((lookup()!.receipt as any).result,receipt.result);assert.equal(lookup()!.requestId,'ai-0-2-3');
  assert.equal(store.modeReceipt(state.roomId,1,'mode-hybrid-contract-withdrawal-attempt','contract'),undefined);
 }finally{store.close();}
});
