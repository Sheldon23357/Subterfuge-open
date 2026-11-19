import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareModelMaterial,prepareModelReferences,expandModelReferences} from '../plugins/hybrid/src/model-material.js';
import {encodeModelData,decodeModelData} from '../packages/contracts/src/model-data.js';
import type {SituationBrief} from '../plugins/hybrid/src/contracts.js';
const id=(letter:string)=>'p0-'+letter.repeat(64);
function fixture():SituationBrief{return {format:'hybrid-brief/1',kind:'strategy',scope:'overview',basis:{roomId:'r',revision:'v',tick:10,commanderVersion:0,player:0},
 global:{time:{worldDay:10},self:{active:true,drillers:30,neptunium:20,outpostCount:1,capacity:100,mineCreationCost:100},players:{columns:['player','active','drillers','neptunium','numOutposts','currentLossIfMineCaptured','staticVictoryWorldDays'],rows:[[0,true,30,20,1,4,50]]},mining:{balance:20,oneLossCost:4,staticVictoryWorldDays:51,mineCount:1},ownOutposts:1,identities:{columns:['name','owner','visibility'],rows:[['HOME',0,2]]},ownFleets:{columns:['id','drillers','state'],rows:[[id('a'),3,'moving']]},planning:{candidates:{columns:['target','score','reasons'],rows:[['ENEMY',5,['unique risk']]]}},feedback:{selected:{actions:[['launch','HOME','ENEMY',3]],status:'evaluated'},conditionalAlternatives:[{differenceFromSelected:{add:[],remove:[]},status:'evaluated'},{differenceFromSelected:{add:[['launch','HOME','OTHER',4]],remove:[]},status:'evaluated'}]}},
 facts:{outposts:[{name:'ENEMY',owner:1,drillers:null,shield:0}]},
 guidance:{executionRules:{reserves:[{source:'HOME',drillers:0}],forbiddenPlayers:[1]},commander:{text:'完整指挥官正文'},strategic:{summary:'keep our goal'},fixedConversation:{scope:'overview'},intentTasks:{byKind:{}},executionFeasibility:[{taskId:'intent-1',capBelowScreenedEstimate:true}],serverAgreements:{current:{jointAttack:{columns:['id','deadline','ownCapturesRemaining'],rows:[[id('b'),50,3]]}}},contractResults:{columns:['kind','agreementId','result'],rows:[['agreement-signed',id('b'),{before:0,after:2}]]}},changes:{triggers:[{kind:'review',reason:'真实触发',entities:['HOME']}]},evidence:{messages:[{id:'message',text:'原始来信'}]},unknowns:['fog']};}
const schema=()=>({properties:{fleetId:{enum:[id('a')]},agreementId:{enum:[id('b')]}}});

test('model material removes exact copies but preserves distinct estimates, unique facts, constraints and original data',()=>{
 const input=fixture(),before=structuredClone(input),m=prepareModelMaterial(input,schema());
 assert.deepEqual(input,before);assert.deepEqual(m.brief.evidence,input.evidence);assert.deepEqual(m.brief.changes,input.changes);
 const g=m.brief.global as any,h=m.brief.guidance as any,f=m.brief.facts as any;
 assert.equal(g.self.neptunium,undefined);assert.equal(g.self.capacity,100);assert.equal(g.mining.staticVictoryWorldDays,51,'different estimates cannot be removed');
 assert.deepEqual(g.planning,(input.global as any).planning);assert.deepEqual(h.executionRules,(input.guidance as any).executionRules);assert.deepEqual(h.executionFeasibility,(input.guidance as any).executionFeasibility);
 assert.equal(g.feedback.conditionalAlternatives.length,1);
 assert.deepEqual(f.outposts,(input.facts as any).outposts);
 for(const k of ['global','guidance','facts'] as const)assert.deepEqual(decodeModelData(encodeModelData({[k]:m.brief[k]})),JSON.parse(JSON.stringify({[k]:m.brief[k]})));
});

test('stable exact references are shared by prompt and schema and expand only actionable output fields',()=>{
 const a=prepareModelMaterial(fixture(),schema()),b=prepareModelMaterial(fixture(),schema());assert.deepEqual(a.references,b.references);
 assert.equal(a.references['F1-AAAAAAAA'],id('a'));assert.equal(a.references['A1-BBBBBBBB'],id('b'));
 assert.deepEqual(a.responseSchema.properties.fleetId.enum,['F1-AAAAAAAA']);assert.deepEqual(a.responseSchema.properties.agreementId.enum,['A1-BBBBBBBB']);
 const output={tasks:[{kind:'return-fleet',fleetId:'F1-AAAAAAAA',fulfillAgreementId:'A1-BBBBBBBB'}],betrayAgreements:['A1-BBBBBBBB'],message:'F1-AAAAAAAA',summary:'A1-BBBBBBBB'};
 const restored=expandModelReferences(output,a.references) as any;
 assert.equal(restored.tasks[0].fleetId,id('a'));assert.equal(restored.tasks[0].fulfillAgreementId,id('b'));assert.deepEqual(restored.betrayAgreements,[id('b')]);
 assert.equal(restored.message,output.message);assert.equal(restored.summary,output.summary);assert.equal(output.tasks[0]!.fleetId,'F1-AAAAAAAA');
});

test('event-only fleet subjects and typed fleet destinations use stable aliases after units leave the current list',()=>{
 const input=fixture(),departed='p2-'+ 'c'.repeat(64),arrived='p3-'+ 'd'.repeat(64),other=id('e'),unknown=id('f');
 (input.global as any).ownFleets=[];
 (input.changes as any).activity={columns:['id','kind','tick','subject','source','destination','arrival','termination'],rows:[
  [4,'departed',1,departed,'HOME',{kind:'outpost',name:'ENEMY'},null,null],
  [5,'fleet-arrived',18,arrived,'HOME',{kind:'outpost',name:'ENEMY'},{outpost:'ENEMY',outcome:'delivered',drillers:0},null],
  [6,'fleet-removed',21,arrived,'HOME',null,null,{outcome:'removed',outpost:null,drillers:0}],
  [7,'mine-created',22,other,null,null,null,null],
  [8,'future-event',23,unknown,null,null,null,null],
  [9,'battle',24,departed,'HOME',{kind:'fleet',id:arrived},null,null],
 ]};
 const before=structuredClone(input),m=prepareModelMaterial(input,schema()),table=(m.brief.changes as any).activity;
 assert.deepEqual(input,before);
 assert.deepEqual(table.rows.map((r:any[])=>r[3]),['F3-CCCCCCCC','F4-DDDDDDDD','F4-DDDDDDDD',other,unknown,'F3-CCCCCCCC']);
 assert.deepEqual(table.rows[5][5],{kind:'fleet',id:'F4-DDDDDDDD'});
 assert.deepEqual(table.rows[1][6],{outpost:'ENEMY',outcome:'delivered',drillers:0});assert.deepEqual(table.rows[2][7],{outcome:'removed',outpost:null,drillers:0});
 assert.equal(m.references['F3-CCCCCCCC'],departed);assert.equal(m.references['F4-DDDDDDDD'],arrived);
 assert.ok(!JSON.stringify(m.responseSchema).includes('F3-CCCCCCCC'));assert.ok(!JSON.stringify(m.responseSchema).includes('F4-DDDDDDDD'),'historical events grant no current action or query permission');
 assert.ok(!Object.values(m.references).includes(other));assert.ok(!Object.values(m.references).includes(unknown),'an arbitrary hash is not proof of a fleet');
 const later=structuredClone(input);(later.changes as any).activity.rows.reverse();assert.deepEqual(prepareModelMaterial(later,schema()).references,m.references,'row order cannot rename units');
});

test('activity aliases retain collision, cross-namespace and original-message protections',()=>{
 const input=fixture(),full='p2-'+ 'c'.repeat(64),other='p2-'+ 'c'.repeat(8)+'d'.repeat(56);
 (input.changes as any).activity=[{kind:'departed',subject:full},{kind:'departed',subject:other}];
 assert.ok(!Object.values(prepareModelMaterial(input,schema()).references).includes(full));
 (input.changes as any).activity=[{kind:'departed',subject:full},{kind:'departed',subject:'F3-CCCCCCCC'}];
 assert.ok(!Object.values(prepareModelMaterial(input,schema()).references).includes(full),'a real literal short ID cannot be merged with a hash alias');
 (input.changes as any).activity=[{kind:'departed',subject:full},{kind:'departed',subject:'f3-cccccccc'}];
 assert.ok(!Object.values(prepareModelMaterial(input,schema()).references).includes(full),'case-insensitive fleet resolution must remain unambiguous');
 (input.changes as any).activity=[{kind:'departed',subject:id('b')}];assert.ok(!Object.values(prepareModelMaterial(input,schema()).references).includes(id('b')),'contract/fleet collisions stay exact');
 (input.changes as any).activity=[{kind:'departed',subject:full}];(input.evidence as any).messages[0].text='请核对原始舰队 '+full;
 const protectedResult=prepareModelMaterial(input,schema());assert.ok(!Object.values(protectedResult.references).includes(full));assert.deepEqual(protectedResult.brief.evidence,input.evidence);
});

test('commander reference projection shortens identities without applying strategic pruning',()=>{
 const input=fixture();input.kind='commander';const before=structuredClone(input),m=prepareModelReferences(input,schema());
 assert.deepEqual(input,before);assert.deepEqual((m.brief.global as any).self,(input.global as any).self);
 for(const key of ['commander','executionRules','intentTasks','executionFeasibility'])assert.deepEqual((m.brief.guidance as any)[key],(input.guidance as any)[key]);
 assert.deepEqual(m.responseSchema.properties.fleetId.enum,['F1-AAAAAAAA']);assert.deepEqual(m.brief.evidence,input.evidence);
 assert.deepEqual(expandModelReferences({tasks:[{kind:'return-fleet',fleetId:'F1-AAAAAAAA'}]},m.references),{tasks:[{kind:'return-fleet',fleetId:id('a')}]});
 assert.equal((m.brief.global as any).self.drillers,30);
});

test('ambiguous, prose-protected and cross-namespace identities retain their canonical spelling',()=>{
 const input=fixture(),other='p0-'+ 'a'.repeat(8)+'c'.repeat(56);
 ((input.global as any).ownFleets.rows as any[]).push([other,5,'moving']);
 const collision=prepareModelMaterial(input,schema());assert.ok(!Object.values(collision.references).includes(id('a')));assert.ok(!Object.values(collision.references).includes(other));
 const raw=fixture();(raw.evidence as any).messages[0].text='请核对原始合同 '+id('b');const p=prepareModelMaterial(raw,schema());assert.ok(!Object.values(p.references).includes(id('b')));assert.deepEqual(p.brief.evidence,raw.evidence);
 const cross=fixture();(cross.global as any).ownFleets.rows.push([id('b'),2,'moving']);assert.ok(!Object.values(prepareModelMaterial(cross,schema()).references).includes(id('b')));
});

test('new explanatory fields are never silently discarded',()=>{
 const input=fixture();(input.global as any).future={meaning:'new computed caveat',interpretation:'new exact limitation'};
 (input.global as any).feedback.reviewWhen=['new unique review condition'];
 (input.global as any).feedback.conditionalAlternatives[0].differenceFromSelected.additionalRisk='new comparison field';
 const changed=schema();
 const m=prepareModelMaterial(input,changed);assert.deepEqual((m.brief.global as any).future,(input.global as any).future);
 assert.deepEqual((m.brief.global as any).feedback.reviewWhen,['new unique review condition']);assert.equal((m.brief.global as any).feedback.conditionalAlternatives.length,2);
});

test('strategy drops diplomacy capabilities and program counters while keeping obligations, fresh receipts and estimates',()=>{
 const input=fixture(),h=input.guidance as any,g=input.global as any;
 h.serverAgreements.current.jointAttack={columns:['id','deadline','ownCapturesRemaining','allowedActions','inConversation','edits','feasibility','taskFeasibility'],rows:[[id('b'),50,3,'accept,reject',false,{captureTargets:['ENEMY']},null,null]]};
 h.receiptCoverage={available:4,new:1,previousPublicationSourceCount:12,unavailableBeforeWindow:2};
 g.roster={columns:['gamePlayer','chatPlayer','name'],rows:[[0,7,'ME'],[1,9,'PEER']]};
 (input.evidence as any).messages=[];
 const before=structuredClone(input),m=prepareModelMaterial(input,schema()),a=m.brief.guidance as any;
 assert.deepEqual(input,before,'full publication and audit input is immutable');
 assert.deepEqual(a.serverAgreements.current.jointAttack.columns,['id','deadline','ownCapturesRemaining']);
 assert.deepEqual(a.serverAgreements.current.jointAttack.rows,[[m.responseSchema.properties.agreementId.enum[0],50,3]]);
 assert.deepEqual(a.receiptCoverage,{available:4,unavailableBeforeWindow:2});
 assert.deepEqual(a.contractResults,{columns:['kind','agreementId','result'],rows:[['agreement-signed',m.responseSchema.properties.agreementId.enum[0],{before:0,after:2}]]});
 assert.deepEqual((m.brief.global as any).roster,{columns:['gamePlayer','name'],rows:[[0,'ME'],[1,'PEER']]});
 assert.ok(m.excluded.some(x=>x.path==='guidance.receiptCoverage.previousPublicationSourceCount'&&x.reason==='program-audit'));
 assert.ok(m.excluded.some(x=>x.path.endsWith('.edits')&&x.reason==='outside-role'));
 assert.ok(m.deduplicated.includes('guidance.receiptCoverage.new'));
 const changed=structuredClone(input);(changed.guidance as any).receiptCoverage.new=0;
 assert.equal((prepareModelMaterial(changed,schema()).brief.guidance as any).receiptCoverage.new,0,'differing counts remain explicit');
});

test('diplomacy retains actionable permissions and cross-identity mapping; strategy retains actual chat attribution and nonempty feasibility',()=>{
 const input=fixture(),h=input.guidance as any,g=input.global as any;
 input.kind='diplomacy';h.fixedConversation={identities:[{gamePlayer:1,chatPlayer:9}],chatPlayers:[9]};
 g.roster={columns:['gamePlayer','chatPlayer','name'],rows:[[0,7,'ME'],[1,9,'PEER']]};
 h.serverAgreements.current.jointAttack={columns:['id','allowedActions','inConversation','edits','feasibility','taskFeasibility'],rows:[[id('b'),'accept,reject,counter',true,{captureTargets:['ENEMY']},{mayAddOwnFulfillmentAttack:false},[{taskId:'intent-1',targetMatchesContractEnemy:false}]]]};
 h.serverAgreements.current.ceasefire={columns:['id','edits','feasibility','taskFeasibility'],rows:[['ceasefire',null,null,null]]};
 const m=prepareModelMaterial(input,schema()),a=m.brief.guidance as any;
 assert.deepEqual(a.serverAgreements.current.jointAttack.columns,h.serverAgreements.current.jointAttack.columns);
 assert.deepEqual(a.serverAgreements.current.jointAttack.rows[0].slice(1),h.serverAgreements.current.jointAttack.rows[0].slice(1));
 assert.deepEqual((m.brief.global as any).roster,g.roster,'chat IDs differ from game IDs');
 assert.deepEqual(a.serverAgreements.current.ceasefire,{columns:['id'],rows:[['ceasefire']]});
 input.kind='strategy';const strategic=prepareModelMaterial(input,schema());
 assert.deepEqual((strategic.brief.global as any).roster,g.roster,'raw message senders must remain attributable');
 const columns=(strategic.brief.guidance as any).serverAgreements.current.jointAttack.columns;
 assert.ok(columns.includes('feasibility'));assert.ok(columns.includes('taskFeasibility'),'unique estimates survive future producer changes');
 input.kind='commander';assert.deepEqual(prepareModelMaterial(input,schema()).excluded,[],'role pruning never applies to commander translation');
});
