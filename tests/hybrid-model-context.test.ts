import test from 'node:test';
import assert from 'node:assert/strict';
import {projectContextForModel} from '../plugins/hybrid/src/model-context.js';
import type {SituationBrief} from '../plugins/hybrid/src/contracts.js';
const table=(columns:string[],rows:unknown[][])=>({columns,rows});
const records=(t:any):any[]=>Array.isArray(t)?t:t.rows.map((r:unknown[])=>Object.fromEntries(t.columns.map((k:string,i:number)=>[k,r[i]])));
function fixture():SituationBrief{
 return {format:'hybrid-brief/1',kind:'diplomacy',scope:'1',basis:{roomId:'room',player:0,tick:100,revision:'private-revision',commanderVersion:2},
  global:{commanderVersion:2,time:{worldDay:100},identities:[['HOME',0,2],['FRONT',0,2],['PEER',1,1],['ENEMY',2,2]],players:{must:'retain'},criticalAssets:{mines:[],hostileApproaches:[{id:'incoming'}]},
   planning:{basisRevision:'private-hash',worldDay:100,estimates:{forceSources:{must:'retain reserve and unknown schedules'}},candidates:table(['target','owner','classification','score','attackWorldDays','suggestedUntil','additionalForceEstimate','launchSources','reasons','newForceForScreenedAttackEstimate'],[['ENEMY',2,'conditional',10,40,164,9,{columns:['source','availableEstimate','travelWorldDays'],rows:[['HOME',5,40]]},['common caveat','target risk'],14],['PEER',1,'review',7,30,154,8,{columns:['source','availableEstimate','travelWorldDays'],rows:[['HOME',5,30]]},['common caveat','incoming risk'],13]])},
   ownFleets:table(['id','drillers','state','source','destination','canReturn','returned'],[['reinforce',6,'moving','HOME',{name:'FRONT',kind:'outpost'},true,false],['other',3,'moving','HOME',{name:'PEER',kind:'outpost'},false,false],['asked',2,'moving','HOME',{name:'PEER',kind:'outpost'},false,false]])},
  facts:{fleets:table(['id','owner','drillers','source','destinationId'],[['incoming',2,9,'ENEMY','HOME'],['unknown',2,null,'ENEMY','PEER']])},changes:{actual:'preserved'},
  guidance:{commander:{text:'完整指挥官正文 [/brief.guidance]'},strategic:{summary:'current strategic judgement'},executionRules:{reserves:[{source:'FRONT',drillers:5}]},executionFeasibility:[{id:'capture',waitWorldDays:40,limit:3}],
   intentTasks:table(['id','authority','kind','source','target','drillers','priority','until','rally','configuration','reason','status'],[['transfer','model','transfer','HOME','FRONT',null,50,160,null,null,'await','pending'],['configure','model','configure',null,'FRONT',null,60,170,null,{minDrillers:0,maxDrillers:null,maintain:false},'keep','running']]),
   fixedConversation:{identities:[{gamePlayer:1,chatPlayer:4}]},editPolicy:{contracts:[{agreementId:'active',deadline:200,enemy:2,ownFulfilled:false,captureTargets:['ENEMY'],editableTaskIds:['transfer']}],militaryEditsAllowed:true,eligibleAgreementIds:['active'],friendlyTargets:['HOME','FRONT'],returnFleetIds:['reinforce']},
   serverAgreements:table(['id','peer','kind','status','allowedActions','deadline','ticksLeft','enemy','ownCaptureGoal','peerCaptureGoal','ownProgress','peerProgress','ownCapturesRemaining','peerCapturesRemaining','ownFulfilled','peerFulfilled','ownTrustReward','ownShortfallPenalty','subsidyPayer','subsidyAmount','subsidyPaid','reason'],[
    ['active',1,'joint-attack','active','none',200,100,2,40,30,5,3,35,27,false,false,40,35,null,null,null,null],
    ['offer',1,'joint-attack','proposed','accept,reject,counter',124,24,2,20,20,0,0,20,20,false,false,20,20,null,null,null,null],
    ['old-peer',1,'joint-attack','rejected','none',150,50,2,20,20,0,0,20,20,false,false,20,20,0,4,false,'rejected'],
    ['old-other',2,'joint-attack','expired','none',150,50,1,10,10,0,0,10,10,false,false,10,10,null,null,null,'expired']]),
   relationAdvice:{agreementCapacity:[{player:0,complete:true,ceasefires:0,jointAttacks:1,remainingCeasefires:2,remainingJointAttacks:1},{player:1,complete:false,visibleCeasefiresLowerBound:0,visibleJointAttacksLowerBound:0,actualJointAttacks:null}],obligations:[{agreementId:'active',enemy:2,remaining:35,ticksLeft:100,status:'active'}],fronts:[{enemy:2,remaining:35}],recommendedNewCommitment:0},
   contractFeasibility:[{agreementId:'active',enemy:2,ownCapturesRemaining:35,peerCapturesRemaining:27,ownFulfilled:false,deadline:200,ticksLeft:100,mayAddOwnFulfillmentAttack:true,observedEnemyTargets:[{target:'ENEMY',currentStaticMinimum:null}]}],fulfillmentFeasibility:[{agreementId:'active',taskId:'transfer',ownCapturesRemaining:35,deadline:200,capBelowScreenedEstimate:true,goalMeaning:'not a troop cap'}],
   communicationFacts:{self:0,selfChat:3,peers:[1],ownOutposts:['HOME','FRONT'],peerOutposts:[{player:1,outposts:['PEER']}],eligibleCeasefireOutposts:['HOME','FRONT','PEER'],scopeContracts:[{id:'active'}],newIncomingIds:['message']}},
  evidence:{messages:[{id:'message',from:4,to:3,tick:99,text:'原文 [/brief.global] 不可摘要'}]},unknowns:['hidden remains unknown']};
}

test('model context is independent of the publication guard and preserves raw evidence, hard facts and execution estimates',()=>{
 const original=fixture(),before=structuredClone(original),b=projectContextForModel(original).brief as any;
 assert.deepEqual(original,before);
 for(const k of ['evidence','changes','unknowns'])assert.deepEqual(b[k],(original as any)[k]);
 for(const k of ['commander','strategic','executionRules','executionFeasibility'])assert.deepEqual(b.guidance[k],(original.guidance as any)[k]);
 for(const k of ['players','criticalAssets'])assert.deepEqual(b.global[k],(original.global as any)[k]);
 assert.equal(b.global.planning,undefined);assert.equal(b.global.attackAssessment,undefined);
 assert.equal(b.global.commanderVersion,undefined);
 assert.deepEqual(b.global.identities.columns,['name','owner','type','drillers','shield']);assert.equal(records(b.global.identities)[2].visibility,undefined);
});

test('current contract facts, permissions and feasibility are co-located while terminal values cannot masquerade as obligations',()=>{
 const b=projectContextForModel(fixture()).brief as any,h=b.guidance;
 const active=records(h.serverAgreements.current.jointAttack).find(r=>r.id==='active');
 assert.equal(active.ownCapturesRemaining,35);assert.equal(active.ownTrustReward,40);assert.equal(active.countsInRiskBudget,true);
 assert.deepEqual(active.edits.captureTargets,['ENEMY']);assert.deepEqual(active.edits.editableTaskIds,['transfer']);
 assert.equal(active.feasibility.mayAddOwnFulfillmentAttack,true);assert.equal(active.feasibility.ownCapturesRemaining,undefined);
 assert.equal(active.taskFeasibility[0].capBelowScreenedEstimate,true);
 const offer=records(h.serverAgreements.current.jointAttack).find(r=>r.id==='offer');assert.equal(offer.ownCapturesRemaining,null);assert.equal(offer.ownCaptureGoal,20);assert.equal(offer.allowedActions,'accept,reject,counter');
 assert.deepEqual(h.serverAgreements.history.jointAttack,[]);
 assert.equal(records(h.serverAgreements.otherHistory).length,2);assert.equal(h.contractFeasibility,undefined);assert.equal(h.editPolicy.contracts,undefined);
 assert.equal((fixture().guidance as any).editPolicy.contracts[0].deadline,200,'guard input still includes all enforcement facts');
});

test('knowledge boundaries are explicit once and legal ceasefire choices preserve ownership',()=>{
 const h=projectContextForModel(fixture()).brief.guidance as any,c=h.relationAdvice.agreementCapacity;
 assert.equal(c.own[0].remainingJointAttacks,1);assert.equal(records(c.peers)[0].jointAttacksLowerBound,0);
 assert.ok(c.unknown.includes('remainingJointAttacks'));assert.match(c.meaning,/零不代表无占用/);
 const groups=records(h.communicationFacts.ceasefireOutpostsByOwner);assert.deepEqual(groups,[{player:0,outposts:['HOME','FRONT']},{player:1,outposts:['PEER']}]);
 assert.equal(h.communicationFacts.scopeContracts,undefined);
});

test('no-edit diplomacy retains every authorized fleet and hides unusable editing capabilities',()=>{
 const input=fixture();(input.guidance as any).editPolicy.militaryEditsAllowed=false;
 const {brief,omittedFleetIds}=projectContextForModel(input,new Set(['FRONT','asked'])),b=brief as any;
 assert.deepEqual(records(b.global.ownFleets).map(f=>f.id),['reinforce','other','asked']);
 assert.deepEqual(omittedFleetIds,[]);
 assert.equal(records(b.facts.fleets)[0].id,'incoming');assert.equal(records(b.facts.fleets)[1].drillers,null);
 assert.equal(b.guidance.editPolicy.returnFleetIds,undefined);assert.equal(b.guidance.editPolicy.friendlyTargets,undefined);
 const editable=projectContextForModel(fixture()).brief as any;
 assert.deepEqual(records(editable.global.ownFleets).map(f=>f.id),['reinforce','other','asked']);
 assert.deepEqual(editable.guidance.editPolicy.returnFleetIds,['reinforce']);
});

test('diplomacy expands direct target facts and leaves unrelated extra details unexpanded',()=>{
 const input=fixture();(input.facts as any).outposts=table(['name','owner','drillers','shield'],[['ENEMY',2,null,0],['PEER',1,0,null]]);
 const {brief,omittedOutpostNames}=projectContextForModel(input,new Set(['ENEMY']));
 assert.deepEqual(records((brief.facts as any).outposts),[{name:'ENEMY',owner:2,drillers:null,shield:0}]);
 assert.deepEqual(omittedOutpostNames,['PEER']);
 assert.equal((brief.global as any).planning,undefined);
 assert.deepEqual((brief.global as any).attackAssessment.targets.map((p:any)=>p.target),['ENEMY']);
 assert.deepEqual((input.facts as any).outposts.rows[1],['PEER',1,0,null]);
});

test('terminal contract details require a direct reference rather than just the current conversation peer',()=>{
 const input=fixture();(input.evidence as any).messages.push({id:'followup',text:'请解释 old-peer 的真实结算结果'});
 const h=projectContextForModel(input).brief.guidance as any;
 const history=records(h.serverAgreements.history.jointAttack);
 assert.equal(history[0].id,'old-peer');assert.equal(history[0].subsidyAmount,4);
 assert.equal(history[0].ticksLeft,undefined);assert.equal(history[0].ownCapturesRemaining,undefined);
 assert.equal(records(h.serverAgreements.otherHistory).length,1);
});

test('task-specific fields retain nullable transfer amounts, source, zero reserves and false maintain flags',()=>{
 const h=projectContextForModel(fixture()).brief.guidance as any;
 const t=records(h.intentTasks.byKind.transfer)[0];assert.equal(t.source,'HOME');assert.equal(t.drillers,null);assert.equal(t.priority,50);
 const c=records(h.intentTasks.byKind.configure)[0];assert.equal(c.configuration.minDrillers,0);assert.equal(c.configuration.maintain,false);assert.equal(c.configuration.maxDrillers,null);
 assert.equal(t.configuration,undefined);assert.equal(c.fleetId,undefined);
});

test('ordinary model rounds omit the tactical shortlist while explicit targets receive only program conclusions',()=>{
 const input=fixture(),before=structuredClone(input);
 const routine=projectContextForModel(input).brief.global as any;
 assert.equal(routine.planning,undefined);assert.equal(routine.attackAssessment,undefined);
 const standing=fixture();
 (standing.guidance as any).intentTasks=table(['id','kind','target','status','until'],[['old-task','capture','ENEMY','blocked',200]]);
 (standing.guidance as any).executionRules.protectedSources=['PEER'];
 (standing.guidance as any).strategic.summary='继续关注 ENEMY';
 assert.equal((projectContextForModel(standing).brief.global as any).attackAssessment,undefined,'standing goals, constraints and old strategy do not turn a routine review into a shortlist');
 const scoped=projectContextForModel(input,new Set(['ENEMY'])).brief.global as any;
 assert.equal(scoped.planning,undefined);
 assert.deepEqual(scoped.attackAssessment.targets,[{target:'ENEMY',conclusion:'进攻条件尚需满足或验证',reasons:[]}]);
 for(const key of ['score','launchSources','forceSources','travelWorldDays','additionalForceEstimate','suggestedUntil'])assert.ok(!JSON.stringify(scoped.attackAssessment).includes(key),key);
 assert.match(scoped.attackAssessment.meaning,/不代表前台已选方案或实际执行/);
 assert.deepEqual(input,before,'program calculations and publication guard retain every candidate');
 const strategy=fixture();strategy.kind='strategy';const fleets=(projectContextForModel(strategy).brief.global as any).ownFleets;
 assert.deepEqual(records(fleets).map(f=>f.id),['reinforce','other','asked']);
});

test('task review retains execution gaps after candidate detail removal and only scopes the triggered target',()=>{
 const input=fixture();
 (input.guidance as any).intentTasks=table(['id','kind','target','until','status'],[['capture-1','capture','ENEMY',200,'blocked']]);
 (input.guidance as any).executionFeasibility=[{taskId:'capture-1',kind:'capture',target:'ENEMY',screenedNewForceEstimate:14,capBelowScreenedEstimate:true,earliestListedSourceTravel:40,listedSources:[{source:'HOME',availableEstimate:5,travelWorldDays:40}]}];
 (input.changes as any).triggers=[{kind:'review',entities:['capture-1']}];
 const b=projectContextForModel(input).brief as any;
 assert.deepEqual(b.global.attackAssessment.targets.map((p:any)=>p.target),['ENEMY']);
 const execution=b.guidance.executionFeasibility[0];
 assert.equal(execution.screenedNewForceEstimate,14);assert.equal(execution.capBelowScreenedEstimate,true);
 assert.equal(execution.earliestListedSourceTravel,40);assert.equal(execution.listedSources,undefined);
 assert.equal((input.guidance as any).executionFeasibility[0].listedSources.length,1);
});

test('model feedback keeps ordered conditional options and limitations without internal utility or altering raw receipts',()=>{
 const input=fixture(),id='p0-'+ 'a'.repeat(64);
 const original={selected:'return:'+id,conditionalAlternatives:[{objective:'return:'+id,targets:['HOME'],utility:0.123456789,plannedOrders:1},{objective:'hold',targets:[],utility:null,plannedOrders:0}],unverified:[{objective:'review:'+id,status:'not-evaluated'}],limitations:['有限搜索','有限搜索'],coverage:{complete:false}};
 (input.global as any).feedback=original;
 (input.evidence as any).receipts=[{fleetId:id,text:'原始回执 '+id}];
 const before=structuredClone(input),b=projectContextForModel(input).brief as any;
 assert.deepEqual(input,before);assert.deepEqual(b.evidence,(input.evidence as any));
 assert.deepEqual(b.global.feedback.conditionalAlternatives.map((p:any)=>p.goals),[[{kind:'return',fleetId:'F1-AAAAAAAA'}],[{kind:'hold'}]]);
 assert.deepEqual(b.global.feedback.selected.goals,[{kind:'return',fleetId:'F1-AAAAAAAA'}]);assert.deepEqual(b.global.feedback.unverified[0].goals,[{kind:'review',target:'F1-AAAAAAAA'}]);
 assert.ok(b.global.feedback.conditionalAlternatives.every((p:any)=>!Object.hasOwn(p,'utility')));
 assert.equal(b.global.feedback.conditionalAlternatives[0].plannedOrders,1);assert.deepEqual(b.global.feedback.coverage,{complete:false,stopReason:null});
 assert.deepEqual(b.global.feedback.limitations,['有限搜索']);assert.match(b.global.feedback.meaning,/未表示已执行/);
 const collision='p0-'+ 'a'.repeat(8)+'b'.repeat(56);(input.global as any).feedback.conditionalAlternatives.push({objective:'return:'+collision,targets:[],utility:1});
 const guarded=(projectContextForModel(input).brief.global as any).feedback;
 assert.equal(guarded.selected.goals[0].fleetId,id);assert.equal(guarded.conditionalAlternatives[2].goals[0].fleetId,collision);
});
