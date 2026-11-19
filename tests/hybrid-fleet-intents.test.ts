import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup,type FleetOrder} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {initialState,type AiSnapshot,type AgentRequest} from '../packages/ai/src/controller/contracts/types.js';
import type {BotModeServices} from '../packages/ai/src/controller/contracts/bot-mode.js';
import {initialHybridState,basisOf,type OperationState,type IntentSpec} from '../plugins/hybrid/src/contracts.js';
import {applyIntentEdits,reconcileIntents,fleetIntentDraft,configurationCandidates,intentBindings} from '../plugins/hybrid/src/intents.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {constraints,reconcileOperations} from '../plugins/hybrid/src/operations.js';
import {tacticalGuidanceAllows,planBot} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {intentSchemaFor,parseIntentResult} from '../plugins/hybrid/src/intent-protocol.js';
import {resolveIntentNames} from '../plugins/hybrid/src/model-names.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
function fixture(){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 let game=submitFleetOrder(createFleetScenario(c),{id:'our-fleet',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:12}}).state;
 const observe=()=>observation({state:game,scheduled:[]},0,'fleet-intents');
 const o=observe(),saved=initialHybridState(),state=initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'});state.sequence=1;
 const add=(kind:'return-fleet',authority:'model'|'commander'='model')=>applyIntentEdits(saved,{upsert:[{id:null,task:{kind,fleetId:'our-fleet',until:150,reason:'外交真实意图'}}],cancel:[]},authority,0,o);
 const execute=(action:FleetOrder['action'])=>{game=submitFleetOrder(game,{id:'intent-command',player:0,action}).state;};
 const advance=(tick:number)=>{game=advanceFleetScenario(game,tick);};
 return {o,saved,state,add,observe,execute,advance};
}
const wire=(task:unknown)=>({summary:'外交真实决策',tasks:{upsert:[{id:null,task}],cancel:[]},reviewOn:[]});
test('fleet intent schema and parser distinguish fleets from named outposts and reject foreign entities',()=>{
 const f=fixture(),task:IntentSpec={kind:'return-fleet',fleetId:'our-fleet',until:150,reason:'交换'};
 const s=intentSchemaFor('strategy',['蓝方工厂'],[],['our-fleet']);
 assert.ok(s.properties.tasks.properties.upsert.items.properties.task.anyOf.some((x:any)=>x.properties.fleetId?.enum.includes('our-fleet')));
 assert.throws(()=>parseIntentResult(wire(task),'strategy',2,new Set(['蓝方工厂'])),/task/);
 assert.equal(parseIntentResult(resolveIntentNames(wire(task),f.o),'strategy',2,new Set(['蓝方工厂']),new Set(['our-fleet'])).intentEdits!.upsert.length,1);
 assert.throws(()=>applyIntentEdits(f.saved,{upsert:[{id:null,task:{...task,fleetId:'enemy'}}],cancel:[]},'model',0,f.o),/own fleet/);
});
test('removed intent kinds are absent from schemas and rejected by strict parsing',()=>{
 const schema=intentSchemaFor('strategy',['蓝方工厂'],[],['our-fleet']);
 const variants=schema.properties.tasks.properties.upsert.items.properties.task.anyOf;
 assert.deepEqual(variants.map((v:any)=>v.properties.kind.enum[0]).sort(),['avoid','capture','configure','return-fleet','transfer'].sort());
 for(const kind of ['stop-reinforcing','cancel-departure']){
  const task=kind==='stop-reinforcing'?{kind,target:'蓝方工厂',until:150,reason:'旧任务'}:{kind,fleetId:'our-fleet',until:150,reason:'旧任务'};
  assert.throws(()=>parseIntentResult(wire(task),'strategy',2,new Set(['蓝方工厂']),new Set(['our-fleet'])),/Invalid intent task|Unexpected fields/);
 }
});

test('return is immediate and closes once from the actual return event',()=>{
 const f=fixture();f.add('return-fleet');const command=fleetIntentDraft(f.o,f.saved,[])!;
 f.execute(command.draft.action as FleetOrder['action']);const destroyed=f.observe();
 assert.equal(destroyed.view.fleets.length,1);assert.equal(destroyed.view.fleets[0]!.returned,true);
 reconcileIntents(destroyed,f.saved,[]);assert.equal(f.saved.intents![0]!.status,'completed');
 assert.equal(fleetIntentDraft(destroyed,f.saved,[]),null);assert.match(f.saved.intents![0]!.reason,/兵力减半/);
});

test('a moving fleet can return',()=>{
 const f=fixture();f.advance(102);const moving=f.observe();
 assert.equal(moving.view.fleets[0]!.state,'moving');
 applyIntentEdits(f.saved,{upsert:[{id:null,task:{kind:'return-fleet',fleetId:'our-fleet',until:150,reason:'返航化解来袭'}}],cancel:[]},'model',0,moving);
 const cmd=fleetIntentDraft(moving,f.saved,[])!;f.execute(cmd.draft.action as FleetOrder['action']);f.advance(103);
 reconcileIntents(f.observe(),f.saved,[]);assert.equal(f.saved.intents![0]!.status,'completed');
});
test('restart, uncertain receipts and duplicate fleet tasks cannot repeat commands',()=>{
 const f=fixture();f.add('return-fleet');const t=f.saved.intents![0]!,cmd=fleetIntentDraft(f.o,f.saved,[])!;
 const op:OperationState={id:'operation-1',phase:'fleet-intent',objective:'gift',basis:basisOf(f.o),strategyVersion:0,status:'review',intentBindings:[{id:t.id,version:t.version}],drafts:[cmd.draft],orders:[],fleets:[],issues:['未确认']};
 const resumed=structuredClone(f.saved);reconcileIntents(f.o,resumed,[op]);assert.equal(resumed.intents![0]!.status,'blocked');assert.equal(fleetIntentDraft(f.o,resumed,[op]),null);
 f.add('return-fleet');
 assert.equal(f.saved.intents!.length,1);
});
test('avoid blocks new dispatch but permits explicit friendly recall without inventing a recall',()=>{
 const f=fixture(),target='蓝方工厂';applyIntentEdits(f.saved,{upsert:[{id:null,task:{kind:'avoid',target,until:120,reason:'停止追加'}}],cancel:[]},'model',0,f.o);
 const g={...constraints(null,f.o,f.saved),objectives:[],rotation:0};
 assert.deepEqual(g.forbiddenTargets,[target]);
 for(const drillers of [1,12])assert.equal(tacticalGuidanceAllows(f.o,[{id:'new',issueTick:100,action:{kind:'launch',source:'红方矿场',destination:target,drillers,}}],g),false);
 assert.equal(tacticalGuidanceAllows(f.o,[{id:'return',issueTick:100,action:{kind:'return-fleet',fleetId:'our-fleet'}}],g),true);
 assert.equal(tacticalGuidanceAllows(f.o,[{id:'out',issueTick:100,action:{kind:'launch',source:target,destination:'红方矿场',drillers:1}}],g),true);
 assert.equal(f.o.view.fleets.find(f=>f.id==='our-fleet')!.returned,false);
 f.o.view.tick=120;reconcileIntents(f.o,f.saved,[]);assert.deepEqual(constraints(null,f.o,f.saved).forbiddenTargets,[]);
});
test('write admission blocks return of a newly foreign fleet',()=>{
 const f=fixture();f.add('return-fleet');const t=f.saved.intents![0]!,cmd=fleetIntentDraft(f.o,f.saved,[])!;
 const op:OperationState={id:'operation-1',phase:'fleet-intent',objective:'gift',basis:basisOf(f.o),strategyVersion:0,status:'proposed',intentBindings:[{id:t.id,version:1}],drafts:[cmd.draft],orders:[],fleets:[],issues:[]};
 const snapshot:AiSnapshot={observation:f.o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const input={state:f.state,snapshot,tool:'order',arguments:{action:cmd.draft.action},latest:<T>(key:string)=>(key==='state'?f.saved:key==='operations'?{operations:[op]}:undefined) as T|undefined};
 assert.doesNotThrow(()=>hybridMode.beforeExecute!(input));f.o.view.fleets[0]!.owner=1;
 assert.throws(()=>hybridMode.beforeExecute!(input),/不属于己方/);
 f.o.view.fleets[0]!.owner=0;t.status='cancelled';assert.throws(()=>hybridMode.beforeExecute!(input),/停止提交/);
});
test('foreground submits confirmed commander return through durable batch and records its receipt',async()=>{
 const f=fixture();f.add('return-fleet','commander');const records=new Map<string,unknown>([['state',f.saved]]);
 const snapshot=():AiSnapshot=>({observation:f.observe(),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2});
 const services:BotModeServices={model:{step:async()=>{throw Error('Unexpected model call in local fixture');}},local:async(r,run)=>run(r),record:(k,v)=>{records.set(k,structuredClone(v));},latest:<T>(k:string)=>records.get(k) as T|undefined,markAssessed:()=>{}};
 const request:AgentRequest={prompt:'',model:'mock',signal:new AbortController().signal};
 const run=(feedback:unknown[]=[])=>hybridMode.prepare({state:f.state,snapshot:snapshot(),history:[],feedback,suffix:'',routes:undefined,efficiency:{cacheReports:true,cacheRoutes:true}}).run(request,services);
 const first=await run();assert.equal(first.reply.tool,'batch');const args=first.reply.arguments as any;
 assert.equal(args.actions[0].arguments.action.kind,'return-fleet');f.execute(args.actions[0].arguments.action);
 await run([{id:'ai-0-1-0',tool:'batch',arguments:args,result:{results:[{index:0,id:'receipt',status:'accepted',protocolReceipt:{effects:{orderId:'intent-command'}}}]}}]);
 assert.equal((records.get('state') as typeof f.saved).intents![0]!.status,'completed');
 const ops=(records.get('operations') as {operations:OperationState[]}).operations;
 assert.equal(reconcileOperations(ops,f.observe())[0]!.status,'completed');
});

test('autonomous return intents enter weighted candidate selection instead of commander dispatch',()=>{
 const f=fixture();f.add('return-fleet');
 assert.equal(fleetIntentDraft(f.o,f.saved,[],new Set(),'commander'),null);
 const candidates=configurationCandidates(f.o,attackRoutes(f.o),f.saved,[]);
 const candidate=candidates.find(c=>c.id.startsWith('intent-return:'))!;
 assert.ok(candidate);assert.equal(candidate.commanderDirected,undefined);
 assert.equal(candidate.drafts[0]!.action.kind,'return-fleet');
 assert.equal(candidate.objective,'return-fleet:intent-1');
 const decision=planBot(f.o,attackRoutes(f.o),{preludeCandidates:[candidate],preludeIndependent:true,preludeOnly:true,maxSimulations:32,maxElapsedMs:5000});
 const evaluated=decision.assessments.find(a=>a.candidate.id===candidate.id)!;
 assert.equal(evaluated.status,'evaluated','recalls must not be rejected as undelivered friendly transports');
 const combined={...candidate,id:'combined',objective:'return+attack'};
 assert.deepEqual(intentBindings(f.saved,combined),[{id:'intent-1',version:1}],'combined returns keep durable task links');
});
test('brief supplies actionable own fleet capabilities without deriving commands from deceptive chat',()=>{
 const f=fixture(),snapshot:AiSnapshot={observation:f.o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 f.saved.chat=[{id:'lie',from:0,to:1,text:'我会销毁这支舰队。',tick:100,sentAt:0}];
 const m=makeBrief({id:'chat',kind:'diplomacy',scope:'1',players:[1],posts:[],messageIds:['lie']},f.state,snapshot,f.saved);
 assert.ok(!(m.brief.global as any).ownFleets.columns.includes('canCancelLaunch'));assert.ok((m.brief.global as any).ownFleets.columns.includes('canReturn'));assert.equal(fleetIntentDraft(f.o,f.saved,[]),null);
 assert.match(m.prompt,/假意接受[^\n]*(?:不下达|不提交操作)/);
});

test('an accepted return receipt survives restart without repeating an irreversible action',()=>{
 const f=fixture();f.add('return-fleet');const cmd=fleetIntentDraft(f.o,f.saved,[])!,t=f.saved.intents![0]!;
 const op:OperationState={id:'operation-1',phase:'fleet-intent',objective:'gift',basis:basisOf(f.o),strategyVersion:0,status:'accepted',intentBindings:[{id:t.id,version:1}],drafts:[cmd.draft],orders:['intent-command'],fleets:[],issues:[],receiptIds:['receipt']};
 const resumed=structuredClone(f.saved);reconcileIntents(f.o,resumed,[op]);assert.equal(resumed.intents![0]!.status,'completed');assert.equal(reconcileOperations([op],f.o)[0]!.status,'completed');
 assert.equal(fleetIntentDraft(f.o,resumed,[op]),null);
 f.execute(cmd.draft.action as FleetOrder['action']);f.advance(101);
 reconcileIntents(f.observe(),resumed,[op]);assert.equal(resumed.intents![0]!.status,'completed');assert.equal(reconcileOperations([op],f.observe())[0]!.status,'completed');
});

test('newly stale return and avoid constraints are checked immediately before writing',()=>{
 const f=fixture();f.add('return-fleet');const cmd=fleetIntentDraft(f.o,f.saved,[])!,t=f.saved.intents![0]!;
 const op:OperationState={id:'operation-1',phase:'fleet-intent',objective:'return',basis:basisOf(f.o),strategyVersion:0,status:'proposed',intentBindings:[{id:t.id,version:1}],drafts:[cmd.draft],orders:[],fleets:[],issues:[]};
 const snapshot:AiSnapshot={observation:f.o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const latest=<T>(key:string)=>(key==='state'?f.saved:key==='operations'?{operations:[op]}:undefined) as T|undefined;
 f.o.view.fleets.find(f=>f.id==='our-fleet')!.canReturn=false;
 assert.throws(()=>hybridMode.beforeExecute!({state:f.state,snapshot,tool:'order',arguments:{action:cmd.draft.action},latest}),/不能返航/);
 applyIntentEdits(f.saved,{cancel:['intent-1'],upsert:[{id:null,task:{kind:'avoid',target:'蓝方工厂',until:150,reason:'停止追加'}}]},'model',0,f.o);
 assert.throws(()=>hybridMode.beforeExecute!({state:f.state,snapshot,tool:'order',arguments:{action:{kind:'launch',source:'红方矿场',destination:'蓝方工厂',drillers:1}},latest:<T>(k:string)=>(k==='state'?f.saved:undefined) as T|undefined}),/禁止派兵/);
});
