import {modelResponseSchema} from '../plugins/hybrid/src/model-wire.js';
import {intentSchemaFor} from '../plugins/hybrid/src/intent-schema.js';
import {readPromptMaterial} from '../packages/contracts/src/prompt-sections.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {diplomacyContext} from '../plugins/hybrid/src/diplomacy-context.js';
import {hybridBriefPrompt} from '../plugins/hybrid/src/prompts.js';
import type {SituationBrief} from '../plugins/hybrid/src/contracts.js';
import type {StrategicAssessment} from '../plugins/hybrid/src/contracts.js';
import {validateDiplomacyMessage} from '../plugins/hybrid/src/diplomacy-message.js';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {initialHybridState} from '../plugins/hybrid/src/contracts.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';

function fixture():SituationBrief{return {format:'hybrid-brief/1',basis:{roomId:'test',player:0,revision:'r',tick:100,commanderVersion:0},kind:'diplomacy',scope:'4',
 global:{time:{worldDay:100},identities:[['ALPHA',0,2],['BRAVO',1,1],['CHARLIE',2,2]],roster:{columns:['gamePlayer','chatPlayer','name'],rows:[[0,3,'Self'],[1,4,'Peer'],[2,5,'Enemy']]},planning:{candidates:{columns:['target','additionalForceEstimate','launchSources'],rows:[['CHARLIE',11,{columns:['source','travelWorldDays'],rows:[['ALPHA',70]]}]]}}},
 facts:{outposts:[{name:'CHARLIE',owner:2,drillers:0,shield:10}]},changes:{},
 guidance:{fixedConversation:{identities:[{gamePlayer:1,chatPlayer:4}]},relationAdvice:{agreementCapacity:[{player:0,complete:true,ceasefires:0,jointAttacks:1,remainingJointAttacks:1},{player:1,complete:false,ceasefires:0,jointAttacks:0}]},
 serverAgreements:{columns:['id','peer','kind','status','allowedActions','enemy','ownCapturesRemaining','peerCapturesRemaining','deadline'],rows:[['signed',1,'joint-attack','active','none',2,3,3,160]]},
 intentTasks:{columns:['id','kind','target','status','reason','originAgreementId','maxDrillersPerPlan','until'],rows:[['intent-1','capture','CHARLIE','pending','等待可执行方案','signed',3,160]]}},
 evidence:{messages:[{id:'own',from:3,to:4,text:'先等待',tick:90},{id:'old',from:4,to:3,text:'收到',tick:91},{id:'new',from:4,to:3,text:'新的问题',tick:99}]},unknowns:[]};}

test('diplomatic facts preserve hidden capacity and distinct chat/game identities',()=>{
 const input=fixture(),before=structuredClone(input),b=diplomacyContext(input,new Set(['old'])),h=b.guidance as any;
 assert.deepEqual(input,before,'model projection enrichment never modifies authoritative input');
 assert.deepEqual(h.communicationFacts.newIncomingIds,['new']);
 assert.equal(h.communicationFacts.selfChat,3);
 assert.deepEqual(h.communicationFacts.ownOutposts,['ALPHA']);
 assert.deepEqual(h.communicationFacts.peerOutposts,[{player:1,outposts:['BRAVO']}]);
 assert.equal(h.relationAdvice.agreementCapacity[1].jointAttacks,undefined);
 assert.equal(h.relationAdvice.agreementCapacity[1].visibleJointAttacksLowerBound,0);
 assert.equal(h.relationAdvice.agreementCapacity[1].remainingJointAttacks,null);
 assert.equal(h.relationAdvice.agreementCapacity[0].remainingJointAttacks,1);
});

test('actual named brief feeds diplomacy facts with default core outpost facts',()=>{
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'dialogue-test');
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const saved=initialHybridState(),state=initialState('dialogue-test',0,{mode:'hybrid',model:'fake',personality:'schemer'});
 const m=makeBrief({id:'one',kind:'diplomacy',scope:'1',posts:[],messageIds:[],players:[1]},state,snapshot,saved);
 const b=readPromptMaterial(m.prompt),facts=b.guidance.communicationFacts;
 assert.deepEqual(b.global.identities.columns,['name','owner','type','drillers','shield']);
 const groups=facts.ceasefireOutpostsByOwner.rows.map((r:any[])=>({player:r[0],outposts:r[1]}));
 const own=groups.find((r:any)=>r.player===0).outposts;
 assert.deepEqual(own,o.view.outposts.filter(p=>p.owner===0&&!p.destroyed).map(p=>o.outpostNames?.[p.id]??p.id));
 assert.ok(own.every((name:unknown)=>typeof name==='string'));
 assert.equal(facts.contactStage,'first-contact');
 assert.equal(facts.eligibleCeasefireOutposts,undefined);
 assert.deepEqual(new Set(groups.flatMap((r:any)=>r.outposts)),new Set(m.brief.guidance&&(m.brief.guidance as any).communicationFacts.eligibleCeasefireOutposts));
});

test('proposal roles and protocol instructions follow each side of the actual signing lifecycle',()=>{
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'proposal-stages');
 const own=o.view.outposts.find(p=>p.owner===0)!,peer=o.view.outposts.find(p=>p.owner===1)!;
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const state=initialState(o.roomId,0,{mode:'hybrid',model:'fake',personality:'schemer'});
 for(const stage of ['sent','received','active'] as const){
  o.diplomacy!.agreements=[{id:'proposal',players:stage==='received'?[1,0]:[0,1],terms:{kind:'ceasefire',outposts:[own.id,peer.id]},subsidy:null,
   proposedAt:0,startedAt:stage==='active'?o.view.tick:null,deadline:o.view.tick+24,status:stage==='active'?'active':'proposed',progress:[0,0],fulfilled:[false,false],reason:null,endedAt:null}];
  snapshot.chat=[{id:'consent',from:1,to:0,text:'同意现有条款。',tick:o.view.tick,sentAt:0}];
  const material=makeBrief({id:stage,kind:'diplomacy',scope:'1',posts:[],messageIds:['consent'],players:[1]},state,snapshot,initialHybridState());
  const table=readPromptMaterial(material.prompt).guidance.serverAgreements.current.ceasefire;
  const contract=Object.fromEntries(table.columns.map((key:string,i:number)=>[key,table.rows[0][i]]));
  const responses=material.permissions.diplomacy.responses,actions=responses[0]?.actions??[];
  assert.equal(actions.includes('accept'),stage==='received');
  assert.equal(actions.includes('withdraw'),stage==='sent');
  assert.equal(contract.ownProposalRole,stage==='active'?undefined:stage==='sent'?'发起方':'接收方');
  assert.equal(responses.length,stage==='active'?0:1);

  if(stage==='sent'){
   assert.match(material.prompt,/本方发起时已同意/);
   assert.match(material.prompt,/本方提案角色:发起方/);
   assert.doesNotMatch(material.prompt,/accept只回应|反提是新提案/);
  }
  if(stage==='active')assert.match(material.prompt,/没有待签提案则不输出响应动作/);
 }
});

test('fulfilment feedback separates score quota, static combat cost, plan state and deadline',()=>{
 const h=diplomacyContext(fixture()).guidance as any,f=h.fulfillmentFeasibility[0];
 assert.equal(f.ownCapturesRemaining,3);assert.equal(f.currentStaticMinimum,11);
 assert.equal(f.capBelowCurrentStaticMinimum,true);assert.equal(f.executionReason,'等待可执行方案');
 assert.equal(f.freshLaunchCannotArriveByDeadline,true);
 assert.equal(f.targetMatchesContractEnemy,true);
 const input=fixture();(input.facts as any).outposts[0]={name:'CHARLIE',owner:1};
 const unknown=(diplomacyContext(input).guidance as any).fulfillmentFeasibility[0];
 assert.equal(unknown.currentStaticMinimum,null);assert.equal(unknown.capBelowCurrentStaticMinimum,null);
 assert.equal(unknown.targetMatchesContractEnemy,false);
 assert.equal(unknown.additionalForceEstimate,11,'bounded program estimate is not discarded when exact hidden defense is unknown');
});

test('diplomacy can stay silent while still assessing fulfilment; strategic prompt remains independent',()=>{
 const schema=modelResponseSchema(intentSchemaFor('diplomacy',['ALPHA']),{activeAgreementIds:['signed']});
 const p=hybridBriefPrompt('diplomacy',true,false,false,diplomacyContext(fixture()),schema);
 assert.match(p,/message=null/);assert.match(p,/履约要求实际占领共同敌人任意一个据点/);assert.match(p,/不能以“没有待签提案”回避/);
 assert.match(p,/新发joint-attack\/ceasefire是提议/);
 assert.doesNotMatch(hybridBriefPrompt('strategy',true,false,false,{}),/沉默是正常结果/);
 const b=fixture();b.kind='strategy';assert.equal(diplomacyContext(b),b);
});

test('outward checks reject explicit subject, capacity, signature and control-language errors without forbidding bluff',()=>{
 const b=diplomacyContext(fixture()),a={message:'我方继续防守BRAVO',agreement:{internalIntent:'维持边界'},intentEdits:{upsert:[],cancel:[]},diplomacyAction:null} as unknown as StrategicAssessment;
 assert.throws(()=>validateDiplomacyMessage(a,b),/主体不符/);
 a.message='你方防守BRAVO，我方继续守住ALPHA';assert.doesNotThrow(()=>validateDiplomacyMessage(a,b));
 a.message='双方均无占用，可直接签署';assert.throws(()=>validateDiplomacyMessage(a,b),/容量表述/);
 (b.guidance as any).communicationFacts.scopeContracts.push({id:'pending',status:'proposed',allowedActions:'accept,reject,counter'});
 a.message='协议已生效';a.diplomacyAction={kind:'respond-agreement',agreementId:'pending',response:'accept'};assert.throws(()=>validateDiplomacyMessage(a,b),/签署表述/);
 a.message='若协议已生效，再核对结果';assert.doesNotThrow(()=>validateDiplomacyMessage(a,b));
 a.message='我方继续防守BRAVO';a.agreement.internalIntent='用威慑信号扰乱对手判断';assert.doesNotThrow(()=>validateDiplomacyMessage(a,b));
 a.message='当前editPolicy不允许';assert.throws(()=>validateDiplomacyMessage(a,b),/内部控制/);
 a.message=null;assert.doesNotThrow(()=>validateDiplomacyMessage(a,b));
});

test('completed personal contribution cannot create another linked attack and truce cannot protect neutral third-party targets',()=>{
 const b=diplomacyContext(fixture()),h=b.guidance as any;
 h.editPolicy={militaryEditsAllowed:true,eligibleAgreementIds:['signed']};h.contractFeasibility[0].ownFulfilled=true;
 const a={message:null,fulfillAgreementId:'signed',intentEdits:{upsert:[{id:null,task:{kind:'capture',target:'CHARLIE'}}],cancel:[]},diplomacyAction:null} as unknown as StrategicAssessment;
 assert.throws(()=>validateDiplomacyMessage(a,b),/占领目标已达标/);
 h.contractFeasibility[0].ownFulfilled=false;a.intentEdits!.upsert[0]!.task={kind:'capture',target:'BRAVO',until:160,reason:'',priority:50};
 assert.throws(()=>validateDiplomacyMessage(a,b),/属于其他敌人/);
 a.intentEdits!.upsert=[];a.diplomacyAction={kind:'propose-agreement',peer:1,terms:{kind:'ceasefire',outposts:['CHARLIE']},subsidy:null,counterTo:null};
 assert.throws(()=>validateDiplomacyMessage(a,b),/停战据点不属于双方/);
 a.diplomacyAction.terms={kind:'ceasefire',outposts:['ALPHA','BRAVO']};assert.doesNotThrow(()=>validateDiplomacyMessage(a,b));
});

test('exact fulfilment identity and deliberate disclosure are separate from ordinary outward explanations',()=>{
 const b=diplomacyContext(fixture()),h=b.guidance as any;
 h.editPolicy={militaryEditsAllowed:true,eligibleAgreementIds:['signed']};
 const a={message:null,fulfillAgreementId:'typo',intentEdits:{upsert:[{id:null,task:{kind:'capture',target:'CHARLIE'}}],cancel:[]},diplomacyAction:null,agreement:{internalIntent:'维持边界'}} as unknown as StrategicAssessment;
 assert.throws(()=>validateDiplomacyMessage(a,b),/不得拼写或猜测/);
 a.intentEdits!.upsert=[];a.fulfillAgreementId=null;
 h.serverAgreements.rows.push(['private',2,'joint-attack','active','none',1,5,5,200]);
 a.message='我方与Enemy仍有既有合同义务，因此暂缓';assert.throws(()=>validateDiplomacyMessage(a,b),/无意披露/);
 a.agreement.internalIntent='主动披露现有合同以换取对方明确边界承诺';assert.doesNotThrow(()=>validateDiplomacyMessage(a,b));
});
