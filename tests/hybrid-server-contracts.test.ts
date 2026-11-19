import {hybridBriefPrompt} from '../plugins/hybrid/src/prompts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {initialHybridState,type StrategicAssessment} from '../plugins/hybrid/src/contracts.js';
import {publishContractIntent,contractCommandStep} from '../plugins/hybrid/src/server-contracts.js';
import {operationGuidance,constraints} from '../plugins/hybrid/src/operations.js';
import {jointAttackGuidance} from '../plugins/hybrid/src/joint-attack.js';
import {tacticalGuidanceAllows} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {normalizeIntentResult} from '../plugins/hybrid/src/intent-compatibility.js';
import {intentSchemaFor} from '../plugins/hybrid/src/intent-schema.js';
import {parseIntentResult} from '../plugins/hybrid/src/intent-protocol.js';
import {namedBrief,resolveIntentNames} from '../plugins/hybrid/src/model-names.js';
import type {BotModeServices} from '../packages/ai/src/controller/contracts/bot-mode.js';
import type {DiplomacyAction} from '../packages/rules/src/index.js';
import {initialState,type AiSnapshot,type GameGateway} from '../packages/ai/src/controller/contracts/types.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {ControllerSeatRunner} from '../packages/ai/src/controller/runtime/runner.js';
import {ProtocolGraphic} from '../packages/client/src/AgentLiveGraphics.js';
import {liveOperations} from '../plugins/hybrid/src/live-operations.js';
import {renderToStaticMarkup} from 'react-dom/server';
import React from 'react';
import type {BotLiveSnapshot} from '../packages/contracts/src/index.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {resolveBotSettings} from '../packages/contracts/src/index.js';
import {relationAdvice,cooperationBonus} from '../plugins/hybrid/src/relation-policy.js';

function room(){
 const setup:FleetSetup={size:{width:40,height:40},positions:{a:{x:0,y:0},b:{x:3,y:0},c:{x:15,y:0}},economy:{initialTick:0,teamSize:0,
  players:Array.from({length:3},()=>({active:true,neptunium:100,minesCreated:0})),outposts:['a','b','c'].map((id,owner)=>({id,owner,type:'generator',drillers:100,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))}};
 return {state:createFleetScenario(setup),scheduled:[]};
}
const proposal:DiplomacyAction={kind:'propose-agreement',peer:1,terms:{kind:'ceasefire',outposts:['a','b']},subsidy:{payer:0,amount:10},counterTo:null};
function assessment(action:DiplomacyAction|null):StrategicAssessment{
 return {summary:'',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],message:null,agreement:{status:'none',fulfillment:'none',summary:'边界合作',internalIntent:'稳定边界',forbidAttack:false,forbiddenTargets:[],jointAttack:null,expiresWorldDay:null},diplomacyAction:action,intentEdits:{upsert:[],cancel:[]}};
}

test('relation advice respects public capacity, signed liability and hidden peer slots',()=>{
 const r=room(),fresh=observation(r,0,'test');
 const before=structuredClone(fresh),initial=relationAdvice(fresh);
 assert.equal(initial.captureGoal,1);
 assert.equal(initial.suggestedSubsidyCeiling,5);
 assert.deepEqual(fresh,before);
 r.state=submitFleetOrder(r.state,{id:'joint-budget',player:0,action:{kind:'propose-agreement',peer:1,terms:{kind:'joint-attack',enemy:2},subsidy:null,counterTo:null}}).state;
 let o=observation(r,0,'test');assert.equal(relationAdvice(o).obligations.length,1,'outgoing proposals retain the capture obligation');
 r.state=submitFleetOrder(r.state,{id:'accept-budget',player:1,action:{kind:'respond-agreement',agreementId:'joint-budget',response:'accept'}}).state;
 o=observation(r,0,'test');const advice=relationAdvice(o);
 assert.equal(advice.agreementCapacity.find(p=>p.player===0)!.remainingJointAttacks,1);
 assert.equal(advice.agreementCapacity.find(p=>p.player===1)!.complete,false);
 assert.equal(advice.agreementCapacity.find(p=>p.player===1)!.remainingJointAttacks,undefined,'private peer capacity is not inferred');
 assert.equal(advice.captureGoal,1);
 o.diplomacy!.agreements[0]!.fulfilled[0]=true;
 assert.equal(relationAdvice(o).obligations.length,0);
 assert.equal(relationAdvice(o).agreementCapacity.find(p=>p.player===0)!.remainingJointAttacks,1,'personal completion does not release server capacity');
 o.diplomacy!.relations=o.diplomacy!.relations.map(r=>({...r,trust:r.from===0?20:-20}));
 assert.equal(cooperationBonus(o,1),2,'mutual trust is directional, not a symmetric alliance flag');
});

test('formal proposal enters durable command queue without military constraints; received talk cannot sign',()=>{
 const o=observation(room(),0,'test'),saved=initialHybridState();
 publishContractIntent(saved,o,assessment(proposal),'1',[1],0);
 assert.equal(saved.contractCommands?.length,1);assert.equal(saved.contractCommands?.[0]!.status,'pending');
 assert.deepEqual(constraints(null,o,saved).forbiddenTargets,[]);
 publishContractIntent(saved,o,assessment(proposal),'1',[1],0);assert.equal(saved.contractCommands?.length,1);
 const other=initialHybridState();publishContractIntent(other,o,{...assessment(null),agreement:{...assessment(null).agreement,status:'confirmed',forbidAttack:true}},'1',[1],0);
 assert.equal(other.contractCommands?.length??0,0);assert.deepEqual(constraints(null,o,other).forbiddenPlayers,[]);
 assert.throws(()=>publishContractIntent(saved,o,assessment(proposal),'2',[2],0),/会话/);
});

test('contract command dispatch persists unknown before transport and never repeats without receipt proof',()=>{
 const o=observation(room(),0,'test'),saved=initialHybridState(),records:string[]=[];
 publishContractIntent(saved,o,assessment(proposal),'1',[1],0);
 let receipt:unknown;
 const services={latest:()=>undefined,record:(kind:string)=>{records.push(kind);},attemptReceipt:()=>receipt?{requestId:'same-request',receipt}:undefined} as unknown as BotModeServices;
 const result=contractCommandStep(saved,o,services,0)!;
 assert.equal(result.reply.tool,'order');assert.equal(saved.contractCommands![0]!.status,'unknown');assert.ok(records.includes('contract-attempt'));
 assert.equal(contractCommandStep(saved,o,services,0)!.reply.tool,'finish');
 receipt={result:{commandReceipt:{status:'accepted'}}};
 assert.equal(contractCommandStep(saved,o,services,0),null);assert.equal(saved.contractCommands![0]!.status,'accepted');
 assert.equal(o.diplomacy!.agreements.length,0,'accepted command is not fabricated server signature');
});

test('actual server signature produces overridable policy, not an independent hard constraint',()=>{
 const r=room();r.state=submitFleetOrder(r.state,{id:'offer',player:0,action:proposal}).state;
 r.state=submitFleetOrder(r.state,{id:'accept',player:1,action:{kind:'respond-agreement',agreementId:'offer',response:'accept'}}).state;
 const o=observation(r,0,'test'),saved=initialHybridState();
 const g=operationGuidance(o,null,[],0,saved)!;
 assert.deepEqual(g.forbiddenTargets,[]);assert.deepEqual(g.contractAvoidTargets,['b']);
 const attack=[{id:'attack',issueTick:0,action:{kind:'launch',source:'a',destination:'b',drillers:10}}];
 assert.equal(tacticalGuidanceAllows(o,attack,g),false);
 assert.equal(tacticalGuidanceAllows(o,attack,{...constraints(null,o,saved),objectives:[],rotation:0}),false);
 saved.betrayAgreements=['offer'];assert.equal(tacticalGuidanceAllows(o,attack,{...constraints(null,o,saved),objectives:[],rotation:0}),true);
 saved.betrayAgreements=['offer'];assert.equal(operationGuidance(o,null,[],0,saved),undefined);
});

test('server joint contract automatically yields personal goals, stops on own fulfilment and ignores local talk',()=>{
 const r=room(),saved=initialHybridState();
 assert.deepEqual(jointAttackGuidance(observation(r,0,'test'),null).objectives,[]);
 r.state=submitFleetOrder(r.state,{id:'joint',player:0,action:{...proposal,terms:{kind:'joint-attack',enemy:2}}}).state;
 r.state=submitFleetOrder(r.state,{id:'accept',player:1,action:{kind:'respond-agreement',agreementId:'joint',response:'accept'}}).state;
 const o=observation(r,0,'test');
 // Target visibility is required for tactical expansion, never infer its hidden local army.
 const visible={...o,view:{...o.view,outposts:o.view.outposts.map(p=>p.id==='c'?{...p,visibility:2 as const}:p)}};
 assert.ok(jointAttackGuidance(visible,null).objectives.some(g=>g.targets.includes('c')));
 visible.diplomacy!.agreements[0]!.fulfilled[0]=true;
 assert.deepEqual(jointAttackGuidance(visible,null).objectives,[]);
 assert.deepEqual(operationGuidance(o,null,[],0,{...saved,betrayAgreements:['joint']})?.attackDefenseFactors??[],[]);
});

test('model action names resolve strictly, fixed duration prompt uses 100/200 and has no custom deadline guidance',()=>{
 const o=observation(room(),0,'test');
 const names=o.outpostNames!;
 const input=normalizeIntentResult({diplomacyAction:{...proposal,terms:{kind:'ceasefire',outposts:[names.a,names.b]}}},[],'diplomacy',0).value;
 const parsed=parseIntentResult(resolveIntentNames(input,o),'diplomacy',3,new Set(['a','b','c']));
 assert.deepEqual(parsed.diplomacyAction,proposal);
 const text=hybridBriefPrompt('diplomacy',true,false,false,{});
 assert.ok(text.includes('固定 100 tick'));assert.ok(text.includes('固定 200 tick'));assert.ok(text.includes('期限不可更改'));
 assert.ok(!text.includes('有明确期限时沿用该绝对世界日'));
 const brief=namedBrief({outposts:[{id:'a',owner:0,visibility:2}],terms:{kind:'ceasefire',outposts:['a','b']}},o);
 assert.deepEqual(brief.terms.outposts,[names.a,names.b]);assert.ok(JSON.stringify(brief.outposts).includes(names.a!));
});

test('real controller dispatches a persisted contract through its normal write ledger and restart does not repeat it',async()=>{
 const r=room(),state=initialState('contract-runner',0,{mode:'hybrid',provider:'offline',model:'',personality:'schemer',bot:resolveBotSettings({schemaVersion:2,maxSimulations:2,maxElapsedMs:1000})});state.enabled=true;
 const snapshot=():AiSnapshot=>({observation:observation(r,0,state.roomId),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3});
 const saved=initialHybridState();publishContractIntent(saved,snapshot().observation,assessment(proposal),'1',[1],0);
 const store=new AiStore(':memory:');let posts=0;
 const gateway:GameGateway={snapshot:async()=>snapshot(),request:async(path,data)=>{
   if(path==='/tool/order'){
    const request=data as {order:{id:string;action:DiplomacyAction};revision:string};
    if(request.order.action.kind==='propose-agreement'||request.order.action.kind==='respond-agreement')posts++;
    r.state=submitFleetOrder(r.state,{...request.order,player:0}).state;
    return snapshot().observation;
   }
   throw Error('Unexpected path '+path);
 }};
 const {createBackground,...mode}=hybridMode;
 try{
  store.saveEvents(state,[{kind:'mode-hybrid-state',details:saved}]);
  const runner=new ControllerSeatRunner(state,store,gateway,{step:async()=>assert.fail('No model required for queued command')},1,{},()=>mode);
  await runner.poll(1000,true,false,{oneRoundPerTick:true});
  assert.equal(posts,1);assert.equal(r.state.diplomacy.agreements.length,1);
  const queue=store.latest<ReturnType<typeof initialHybridState>>(state.roomId,0,'mode-hybrid-state')!.contractCommands!;
  assert.equal(queue[0]!.status,'accepted','receipt projection must be current before the same poll finishes');
  const restarted=new ControllerSeatRunner(state,store,gateway,{step:async()=>assert.fail('No model')},1,{},()=>mode);
  await restarted.poll(2000,true,false,{oneRoundPerTick:true});
  assert.equal(posts,1,'original signed command must be recovered, not posted again');
  assert.equal(store.latest<ReturnType<typeof initialHybridState>>(state.roomId,0,'mode-hybrid-state')!.contractCommands![0]!.status,'accepted');
 }finally{store.close();}
});


test('AI live console projects server contract state even when no model directive exists',()=>{
 const r=room();r.state=submitFleetOrder(r.state,{id:'offer',player:0,action:{...proposal,terms:{kind:'joint-attack',enemy:2}}}).state;
 const o=observation(r,0,'test'),live=liveOperations(o,<T>()=>undefined as T|undefined);
 assert.equal(live.directive,null);assert.equal(live.diplomacy!.agreements[0]!.status,'proposed');
 const html=renderToStaticMarkup(React.createElement(ProtocolGraphic,{data:{...live,generation:'test',round:0,observedTick:0,events:[],names:{a:'甲',b:'乙'}} satisfies BotLiveSnapshot,active:false}));
 assert.ok(html.includes('北辰与赤潮签订'));assert.ok(html.includes('共同攻击天火'));
 assert.ok(html.includes('北辰占领据点'));assert.ok(html.includes('赤潮占领据点'));
 assert.ok(html.includes('待签署'));assert.ok(html.includes('外交协议 1'));
});

test('live configuration intent states its actual garrison bounds, maintenance and deadline',()=>{
 const o=observation(room(),0,'test'),saved=initialHybridState();o.outpostNames={...o.outpostNames,a:'甲据点'};
 saved.intents=[{id:'config',version:1,authority:'model',commanderVersion:0,status:'pending',reason:'等待可执行方案',createdAt:0,updatedAt:0,spec:{kind:'configure',target:'a',minDrillers:20,maxDrillers:30,maintain:true,priority:50,until:180,reason:'守备'}}];
 const live=liveOperations(o,<T>(kind:string)=>kind==='state'?saved as T:undefined);
 const text=live.intents[0]!.description!;
 for(const detail of ['甲据点','驻兵至少 20','驻兵至多 30','持续保持','截止第 180 天'])assert.ok(text.includes(detail),detail);
 const html=renderToStaticMarkup(React.createElement(ProtocolGraphic,{data:{...live,generation:'test',round:0,observedTick:0,events:[],names:{a:'甲据点'}},active:false}));
 assert.ok(html.includes('驻兵至少 20'));assert.ok(html.includes('驻兵至多 30'));
});

test('later fresh negotiation can repeat terms after a prior command ended, without replaying unresolved actions',()=>{
 const o=observation(room(),0,'test'),saved=initialHybridState();publishContractIntent(saved,o,assessment(proposal),'1',[1],0);
 saved.contractCommands![0]!.status='accepted';publishContractIntent(saved,o,assessment(proposal),'1',[1],0);
 assert.equal(saved.contractCommands!.length,2);
 publishContractIntent(saved,o,assessment(proposal),'1',[1],0);assert.equal(saved.contractCommands!.length,2);
});


test('definitive signature failure permits a new intentional acceptance without replaying the accepted command',()=>{
 const r=room();r.state=submitFleetOrder(r.state,{id:'offer',player:0,action:{...proposal,subsidy:{payer:0,amount:200}}}).state;
 const saved=initialHybridState(),action:DiplomacyAction={kind:'respond-agreement',agreementId:'offer',response:'accept'};
 publishContractIntent(saved,observation(r,1,'test'),assessment(action),'0',[0],0);
 saved.contractCommands![0]!.status='accepted';
 r.state=submitFleetOrder(r.state,{id:'accept',player:1,action}).state;
 const failed=observation(r,1,'test');assert.equal(failed.diplomacy!.agreements[0]!.status,'proposed');
 publishContractIntent(saved,failed,assessment(action),'0',[0],0);
 assert.equal(saved.contractCommands!.length,2);assert.equal(saved.contractCommands![1]!.status,'pending');
});


test('server diplomacy schema exposes only private notes, eligible truce posts and actionable proposal identities',()=>{
 const r=room();r.state=submitFleetOrder(r.state,{id:'pending',player:0,action:proposal}).state;
 const o=observation(r,1,'test');
 const options={self:1,peers:[0],enemies:[2],ceasefirePosts:['A','B'],agreements:o.diplomacy!.agreements};
 const schema=intentSchemaFor('diplomacy',['A','B','C'],[],[],options);
 assert.deepEqual(Object.keys(schema.properties.agreement.properties),['summary','internalIntent']);
 const variants=schema.properties.diplomacyAction.anyOf[0].anyOf;
 assert.deepEqual(variants[0].properties.peer,{const:0});
 assert.deepEqual(variants[0].properties.terms.anyOf[0].properties.outposts.items.enum,['A','B']);
 assert.deepEqual(variants.find((v:any)=>v.properties.kind.const==='respond-agreement').properties.agreementId,{const:'pending'});
 r.state=submitFleetOrder(r.state,{id:'accept',player:1,action:{kind:'respond-agreement',agreementId:'pending',response:'accept'}}).state;
 options.agreements=observation(r,1,'test').diplomacy!.agreements;
 const active=intentSchemaFor('diplomacy',['A','B','C'],[],[],options);
 assert.equal(active.properties.diplomacyAction.anyOf[0].anyOf.filter((v:any)=>v.properties.kind.const==='respond-agreement').length,0);
});

test('obsolete local agreement fields are audited and cannot block or create server signature actions',()=>{
 const action:DiplomacyAction={...proposal,terms:{kind:'joint-attack',enemy:2}};
 const raw={summary:'协作',agreement:{status:'proposed',jointAttack:{enemy:2,until:null},summary:'谈判认识',internalIntent:'交换牵制'},diplomacyAction:action};
 const snapshot=structuredClone(raw),normalized=normalizeIntentResult(raw,[],'diplomacy',0,[],true);
 const result=parseIntentResult(normalized.value,'diplomacy',3,new Set(['a','b','c']));
 assert.equal(result.agreement.status,'none');assert.equal(result.agreement.jointAttack,null);assert.deepEqual(result.diplomacyAction,action);
 assert.ok(normalized.changes.some(c=>c.path==='agreement.jointAttack'&&c.rule==='drop-extra-field'));assert.deepEqual(raw,snapshot);
});

test('accepting an exact already signed proposal is a no-op without another write or invented obligation',()=>{
 const r=room();r.state=submitFleetOrder(r.state,{id:'offer',player:0,action:proposal}).state;
 r.state=submitFleetOrder(r.state,{id:'accept',player:1,action:{kind:'respond-agreement',agreementId:'offer',response:'accept'}}).state;
 const saved=initialHybridState(),o=observation(r,1,'test');
 publishContractIntent(saved,o,assessment({kind:'respond-agreement',agreementId:'offer',response:'accept'}),'0',[0],0);
 assert.equal(saved.contractCommands?.length??0,0);assert.equal(o.diplomacy!.agreements[0]!.status,'active');
 assert.ok(operationGuidance(o,null,[],0,saved)?.contractAvoidTargets?.includes('a'));
});
