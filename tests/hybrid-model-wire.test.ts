import {expandSchemaReferences} from './helpers/schema.js';
import {readPromptMaterial} from '../packages/contracts/src/prompt-sections.js';
import {modelWireInstructionsFor} from '../plugins/hybrid/src/prompts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {modelResponseSchema,decodeModelResponse} from '../plugins/hybrid/src/model-wire.js';
import {intentSchemaFor,parseIntentResult} from '../plugins/hybrid/src/intent-protocol.js';
import {normalizeIntentResult} from '../plugins/hybrid/src/intent-compatibility.js';
import {resolveIntentNames} from '../plugins/hybrid/src/model-names.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';
import {initialHybridState} from '../plugins/hybrid/src/contracts.js';
import type {IntentTask} from '../plugins/hybrid/src/contracts.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';

test('flat task output becomes exact internal edits and keeps military validation',()=>{
 const raw={tasks:[{kind:'transfer',source:'a',target:'b',drillers:12,until:120}],cancel:['intent-1'],reviewOn:['到达后复查']};
 const decoded=decodeModelResponse(raw,'strategy');
 const result=parseIntentResult(normalizeIntentResult(decoded,[],'strategy',0).value,'strategy',2,new Set(['a','b']));
 assert.equal(result.intentEdits!.upsert[0]!.task.kind,'transfer');assert.deepEqual(result.intentEdits!.cancel,['intent-1']);
 assert.deepEqual(raw.tasks[0],{kind:'transfer',source:'a',target:'b',drillers:12,until:120});
 assert.throws(()=>parseIntentResult(normalizeIntentResult(decodeModelResponse({tasks:[{kind:'transfer',target:'b',until:120}]},'strategy'),[],'strategy',0).value,'strategy',2,new Set(['b'])));
});
test('flat diplomatic actions only choose an enemy and preserve subsidy and exact response identity',()=>{
 const decoded=decodeModelResponse({action:'joint-attack',peer:1,enemy:2,subsidy:{payer:1,amount:5},agreementSummary:'夹击',internalIntent:'履约'},'diplomacy') as any;
 const a=parseIntentResult(normalizeIntentResult(decoded,[],'diplomacy',0,[],true).value,'diplomacy',3,new Set());
 assert.deepEqual(a.diplomacyAction,{kind:'propose-agreement',peer:1,terms:{kind:'joint-attack',enemy:2},subsidy:{payer:1,amount:5},counterTo:null});
 assert.deepEqual((decodeModelResponse({action:'accept',agreementId:'exact'},'diplomacy') as any).diplomacyAction,{kind:'respond-agreement',agreementId:'exact',response:'accept'});
 const audit:any[]=[];const idle=decodeModelResponse({action:'none',subsidy:{payer:1,amount:20},peer:1},'diplomacy',audit) as any;
 assert.equal(idle.diplomacyAction,null);assert.equal(idle.peer,undefined);assert.equal(audit.length,2);
 assert.throws(()=>decodeModelResponse({forbiddenPlayers:[]},'commander'),/all three/);
 const schema=modelResponseSchema(intentSchemaFor('diplomacy',['a']));
 assert.equal(schema.properties.tasks.type,'array');assert.equal(schema.properties.diplomacyAction,undefined);assert.equal(schema.properties.agreement,undefined);
});

test('all declared inactive diplomacy metadata is inert and audited rather than rejecting an exact response',()=>{
 for(const action of ['none','accept','reject','withdraw']){
  const raw={action,peer:2,enemy:3,subsidy:{payer:2,amount:99},outposts:['a'],counterTo:'old',agreementId:'exact'};
  const audit:any[]=[];const decoded=decodeModelResponse(raw,'diplomacy',audit) as any;
  assert.deepEqual(decoded.diplomacyAction,action==='none'?null:{kind:'respond-agreement',agreementId:'exact',response:action});
  assert.ok(audit.some(a=>a.path==='$.subsidy'&&a.rule==='drop-extra-field'));
  assert.equal(raw.subsidy.amount,99,'raw audit source is not mutated');
 }
});
test('fulfilment placement is lossless and conflicting explicit identities cannot be merged',()=>{
 const audit:any[]=[];const decoded=decodeModelResponse({tasks:[{kind:'capture',target:'a',until:120,fulfillAgreementId:'signed'}]},'diplomacy',audit) as any;
 assert.equal(decoded.fulfillAgreementId,'signed');assert.equal(decoded.tasks.upsert[0].task.fulfillAgreementId,undefined);
 assert.equal(audit[0].rule,'move-fulfilment');
 assert.throws(()=>decodeModelResponse({fulfillAgreementId:'first',tasks:[{kind:'capture',fulfillAgreementId:'other'}]},'diplomacy'),/one exact signed agreement/);
});
test('schemas retain exact update identities, per-kind required fields and current diplomatic edit capability',()=>{
 const internal=intentSchemaFor('strategy',['a','b'],['intent-7']);const schema=expandSchemaReferences(modelResponseSchema(internal,{friendlyPosts:['a']}));
 for(const branch of schema.properties.tasks.items.anyOf)assert.deepEqual(branch.properties.id,internal.properties.tasks.properties.upsert.items.properties.id);
 assert.equal(schema.properties.tasks.items.anyOf[0].properties.until.exclusiveMinimum,undefined);
 assert.equal(schema.properties.tasks.items.anyOf[0].properties.until.minimum,0);
 const transfer=schema.properties.tasks.items.anyOf.find((s:any)=>s.properties.kind.enum[0]==='transfer');
 assert.equal(transfer.type,'object');assert.equal(transfer.additionalProperties,false);
 assert.deepEqual(schema.required,['summary','tasks','cancel','reviewOn']);
 assert.ok(transfer.required.includes('source'));assert.ok(transfer.required.includes('drillers'));
 assert.deepEqual(transfer.properties.source.enum,['a']);assert.deepEqual(transfer.properties.target.enum,['a']);
 assert.deepEqual(schema.properties.tasks.items.anyOf.find((s:any)=>s.properties.kind.enum[0]==='configure').properties.target.enum,['a']);
 const none=modelResponseSchema(intentSchemaFor('diplomacy',['a']),{activeAgreementIds:[]});
 assert.equal(none.properties.tasks.maxItems,0);assert.equal(none.properties.cancel.maxItems,0);
 const signed=modelResponseSchema(intentSchemaFor('diplomacy',['a']),{activeAgreementIds:['signed']});
 assert.deepEqual(signed.properties.fulfillAgreementId.anyOf[0].enum,['signed']);
 for(const branch of signed.properties.tasks.items.anyOf)assert.deepEqual(branch.properties.fulfillAgreementId,signed.properties.fulfillAgreementId);
 assert.equal(signed.properties.tasks.maxItems,12);
 const returned=modelResponseSchema(intentSchemaFor('strategy',['a'],[],['F1'])).properties.tasks.items.anyOf.find((s:any)=>s.properties.kind.enum[0]==='return-fleet');
 assert.ok(returned.required.includes('fleetId'));assert.equal(returned.properties.target,undefined);
});

test('every model role requires an explicit priority for capture, configure and transfer edits',()=>{
 for(const role of ['strategy','diplomacy','commander'] as const){
  const schema=modelResponseSchema(intentSchemaFor(role,['a','b'],['intent-1'],['fleet']),{activeAgreementIds:['signed']});
  const item=schema.properties.tasks.items;
  assert.equal(schema.properties.tasks.type,'array');
  assert.equal(item.properties,undefined);
  for(const variant of item.anyOf){
   const kind=variant.properties.kind.enum[0];
   assert.equal(variant.required.includes('priority'),['capture','configure','transfer'].includes(kind),`${role}/${kind}`);
   if(variant.required.includes('priority'))assert.deepEqual(variant.properties.priority,{type:'number',minimum:0,maximum:100});
  }
  assert.match(modelWireInstructionsFor(role,schema),/capture\/configure\/transfer无论新增还是更新都必须填写priority/);
 }
});

test('large task catalogs share exact allowlists without broadening action scopes or changing the source',()=>{
 const posts=Array.from({length:80},(_,i)=>'OUTPOST-'+String(i).padStart(3,'0'));
 const friendly=posts.slice(0,5);
 for(const role of ['strategy','commander','diplomacy'] as const){
  const internal=intentSchemaFor(role,posts,['intent-1'],['F1']);
  const before=structuredClone(internal),schema=modelResponseSchema(internal,{friendlyPosts:friendly,activeAgreementIds:['signed']});
  const expanded=expandSchemaReferences(schema),variants=expanded.properties.tasks.items.anyOf;
  assert.deepEqual(internal,before);
  assert.equal(schema.properties.tasks.items.properties,undefined);
  assert.ok(schema.$defs);
  assert.ok(JSON.stringify(expanded).length-JSON.stringify(schema).length>JSON.stringify(posts).length/2);
  const task=(kind:string)=>variants.find((v:any)=>v.properties.kind.enum[0]===kind);
  assert.deepEqual(task('capture').properties.target.enum,posts);
  assert.deepEqual(task('avoid').properties.target.enum,posts);
  assert.deepEqual(task('configure').properties.target.enum,friendly);
  assert.deepEqual(task('transfer').properties.source.enum,friendly);
  assert.deepEqual(task('transfer').properties.target.enum,friendly);
  assert.equal(expanded.properties.needsInformation,undefined);
  assert.deepEqual(task('return-fleet').properties.fleetId.enum,['F1']);
  assert.equal(task('return-fleet').properties.target,undefined);
  assert.ok(task('configure').anyOf.every((v:any)=>v.required.length===1));
  for(const variant of variants){
   assert.equal(variant.additionalProperties,false);
   assert.ok(variant.required.includes('until'));
  }
 }
});

test('explicit model priorities make retargeting and task kind changes independent of inheritance',()=>{
 const old:IntentTask={id:'intent-1',version:2,spec:{kind:'capture',target:'a',priority:63,until:100,reason:'old'},authority:'model',commanderVersion:0,status:'pending',reason:'',createdAt:0,updatedAt:0};
 const tasks=[{kind:'capture',target:'b',until:90},
  {kind:'configure',target:'a',until:90,minDrillers:20},
  {kind:'transfer',source:'a',target:'b',until:90,drillers:6}];
 for(const task of tasks)for(const priority of [0,50,100]){
  const raw={tasks:[{id:old.id,...task,priority}]},before=structuredClone(raw);
  const normalized=normalizeIntentResult(decodeModelResponse(raw,'strategy'),[old],'strategy',10);
  const result=parseIntentResult(normalized.value,'strategy',2,new Set(['a','b']));
  assert.equal((result.intentEdits!.upsert[0]!.task as {priority:number}).priority,priority);
  assert.equal(normalized.changes.some(c=>c.rule==='inherit-priority'),false);
  assert.deepEqual(raw,before);
 }
 for(const task of tasks)for(const priority of [null,-1,101]){
  const normalized=normalizeIntentResult(decodeModelResponse({tasks:[{id:old.id,...task,priority}]},'strategy'),[old],'strategy',10);
  assert.throws(()=>parseIntentResult(normalized.value,'strategy',2,new Set(['a','b'])),/priority/);
 }
});
test('actual model material excludes storage fields, preserves raw prose and internal freshness basis',()=>{
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'wire-test');
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const saved=initialHybridState();saved.chat=[{id:'original',from:1,to:0,text:'承诺原文不得改写。',tick:0,sentAt:123}];
 const m=makeBrief({id:'one',kind:'diplomacy',scope:'1',posts:[],messageIds:['original'],players:[1]},initialState('wire-test',0,{mode:'hybrid',model:'fake',personality:'schemer'}),snapshot,saved);
 const b=readPromptMaterial(m.prompt);
 assert.equal(b.global.self.funding,undefined);assert.equal(b.global.self.activity,undefined);assert.equal(b.basis.revision,undefined);
 assert.equal(m.brief.basis.revision,o.revision);assert.equal(m.brief.basis.roomId,o.roomId);
 assert.equal(b.evidence.messages[0].text,saved.chat[0]!.text);assert.equal(b.evidence.messages[0].sentAt,undefined);
 assert.equal(b.guidance.contractGoals,undefined);assert.deepEqual(b.guidance.serverAgreements.current,{ceasefire:[],jointAttack:[]});
 assert.equal(m.responseSchema.properties.tasks.type,'array');
 const nextSnapshot=structuredClone(snapshot);nextSnapshot.observation.secondsSinceLastTick+=30;
 const next=makeBrief({id:'two',kind:'diplomacy',scope:'1',posts:[],messageIds:['original'],players:[1]},initialState('wire-test',0,{mode:'hybrid',model:'fake',personality:'schemer'}),nextSnapshot,saved);
 assert.notEqual(readPromptMaterial(next.prompt).global.time.worldDay,b.global.time.worldDay);
 assert.deepEqual(next.responseSchema,m.responseSchema,'time passing alone must not rewrite the generation schema');
 const empty={summary:'',tasks:[],cancel:[],reviewOn:[]};
 assert.doesNotThrow(()=>parseIntentResult(normalizeIntentResult(resolveIntentNames(decodeModelResponse(empty,'diplomacy'),o),[],'diplomacy',0,[],true).value,'diplomacy',2,new Set(o.view.outposts.map(p=>p.id))));
});
