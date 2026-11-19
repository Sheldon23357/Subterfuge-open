import test from 'node:test';
import assert from 'node:assert/strict';
import {codexGenerationSchema,restoreCodexOptionals} from '../packages/ai/src/application/providers/codex-schema.js';
import {modelResponseSchema,fixedModelResponseSchema,decodeModelResponse} from '../plugins/hybrid/src/model-wire.js';
import {intentSchemaFor,parseIntentResult} from '../plugins/hybrid/src/intent-protocol.js';
import {normalizeIntentResult} from '../plugins/hybrid/src/intent-compatibility.js';
import {applyIntentEdits} from '../plugins/hybrid/src/intents.js';
import {initialHybridState} from '../plugins/hybrid/src/contracts.js';
import {expandSchemaReferences} from './helpers/schema.js';

test('diplomacy subsidy is atomic across strict generation, restoration and semantic validation',()=>{
 const source=fixedModelResponseSchema('diplomacy',true),schema=codexGenerationSchema(source);
 assert.equal(source.properties.subsidyPayer,undefined);assert.equal(source.properties.subsidyAmount,undefined);
 assert.deepEqual(source.properties.subsidy.required,['payer','amount']);
 assert.ok(JSON.stringify(schema).includes('payer'));
 for(const value of [undefined,null,{payer:0,amount:0},{payer:1,amount:5}]){
  const raw={summary:'',tasks:[],cancel:[],reviewOn:[],action:{present:true,value:'ceasefire'},peer:null,subsidy:{present:value!==undefined,value:value??null},outposts:['A'],agreementSummary:null,internalIntent:null};
  const restored=restoreCodexOptionals(raw,source),decoded=decodeModelResponse(restored,'diplomacy',[],{peer:1});
  const result=parseIntentResult(normalizeIntentResult(decoded,[],'diplomacy',0,[],true).value,'diplomacy',2,new Set(['A']));
  assert.deepEqual(result.diplomacyAction?.kind==='propose-agreement'?result.diplomacyAction.subsidy:undefined,value??null);
 }
 for(const [value,path] of [[{payer:null,amount:3},'subsidy.payer'],[{payer:1,amount:null},'subsidy.amount']] as const){
  const decoded=decodeModelResponse({action:'ceasefire',peer:1,outposts:['A'],subsidy:value},'diplomacy');
  assert.throws(()=>parseIntentResult(normalizeIntentResult(decoded,[],'diplomacy',0,[],true).value,'diplomacy',2,new Set(['A'])),e=>e instanceof Error&&e.message.includes(path));
 }
});

test('strict diplomacy projection omits unsupported uniqueness without changing original terms validation',()=>{
 const source=modelResponseSchema(intentSchemaFor('diplomacy',['A','E'],[],[],{self:0,peers:[1],enemies:[2],ceasefirePosts:['A','E'],agreements:[]}));
 const before=structuredClone(source),wire=codexGenerationSchema(source);
 assert.match(JSON.stringify(source),/"uniqueItems":true/);
 assert.doesNotMatch(JSON.stringify(wire),/"uniqueItems"/);
 assert.deepEqual(source,before);
 const parse=(outposts:string[])=>parseIntentResult(normalizeIntentResult(decodeModelResponse({summary:'',tasks:[],cancel:[],reviewOn:[],action:'ceasefire',peer:1,outposts},'diplomacy'),[],'diplomacy',10).value,'diplomacy',3,new Set(['A','E']));
 assert.equal(parse(['A']).diplomacyAction?.kind,'propose-agreement');
 assert.throws(()=>parse(['A','A']));
 assert.throws(()=>parse(['unavailable']));
});

test('Codex strict schema preserves closed action alternatives and exact authorized values',()=>{
 for(const role of ['strategy','diplomacy','commander'] as const){
  const source=modelResponseSchema(intentSchemaFor(role,['A','B'],['intent-1'],['F1']),{friendlyPosts:['A'],activeAgreementIds:['signed']});
  const before=structuredClone(source),wire=codexGenerationSchema(source);
  assert.deepEqual(source,before);
  const walk=(s:any)=>{
   if(s.properties){assert.equal(s.additionalProperties,false);assert.deepEqual(s.required,Object.keys(s.properties));Object.values(s.properties).forEach(walk);}
   s.anyOf?.forEach(walk);if(s.items)walk(s.items);
  };walk(wire);
  const variants=wire.properties.tasks.items.anyOf;
  assert.equal(wire.properties.tasks.items.properties,undefined);
  const transfer=variants.find((v:any)=>v.properties?.kind.enum[0]==='transfer');
  assert.deepEqual(transfer.properties.source.enum,['A']);assert.deepEqual(transfer.properties.target.enum,['A']);
  assert.equal(transfer.properties.drillers.anyOf[0].minimum,1);
  assert.equal(variants.find((v:any)=>v.properties?.kind.enum[0]==='return-fleet').properties.target,undefined);
  if(role==='diplomacy')assert.deepEqual(wire.properties.fulfillAgreementId.anyOf[1].properties.value.anyOf[0].enum,['signed']);
 }
});

test('optional nullable limits preserve omission, explicit clearing and zero when updating an existing task',()=>{
 const source=modelResponseSchema(intentSchemaFor('strategy',['A'],['intent-1']));
 const wire=codexGenerationSchema(source);
 const capture=wire.properties.tasks.items.anyOf.find((s:any)=>s.properties.kind.enum[0]==='capture');
 const envelope=capture.properties.maxDrillersPerPlan;
 assert.deepEqual(envelope.anyOf[0].required,['present','value']);
 assert.deepEqual(envelope.anyOf[0].properties.present.enum,[false]);
 assert.equal(envelope.anyOf[0].properties.value.type,'null');
 const observation={view:{tick:10,player:0,outposts:[{id:'A',owner:1}],fleets:[]},secondsSinceLastTick:0} as any;
 for(const [provided,value,expected] of [[false,null,30],[true,null,null],[true,0,0],[true,12,12]] as const){
  const saved=initialHybridState();saved.intents=[{id:'intent-1',version:1,spec:{kind:'capture',target:'A',priority:50,until:80,reason:'',maxDrillersPerPlan:30},authority:'model',commanderVersion:0,status:'pending',reason:'',createdAt:0,updatedAt:0}];
  const output={summary:'',tasks:[{id:{present:true,value:'intent-1'},kind:'capture',target:'A',priority:50,until:100,reason:null,maxDrillersPerPlan:{present:provided,value}}],cancel:[],reviewOn:[],betrayAgreements:null};
  const before=structuredClone(output),restored=restoreCodexOptionals(output,source);
  assert.deepEqual(output,before);
  assert.equal(Object.hasOwn(restored.tasks[0],'maxDrillersPerPlan'),provided);
  const parsed=parseIntentResult(normalizeIntentResult(decodeModelResponse(restored,'strategy'),saved.intents,'strategy',10).value,'strategy',2,new Set(['A']));
  applyIntentEdits(saved,parsed.intentEdits!,'model',0,observation);
  assert.equal(saved.intents[0]!.spec.kind==='capture'&&saved.intents[0]!.spec.maxDrillersPerPlan,expected);
 }
});

test('shared task catalogs survive strict projection and optional restoration',()=>{
 const posts=Array.from({length:80},(_,i)=>'OUTPOST-'+i),ids=posts.map(p=>'intent-'+p);
 const source=modelResponseSchema(intentSchemaFor('strategy',posts,ids),{friendlyPosts:posts.slice(0,5)});
 const before=structuredClone(source),wire=codexGenerationSchema(source),expanded=expandSchemaReferences(wire);
 assert.ok(wire.$defs);
 assert.deepEqual(source,before);
 const capture=expanded.properties.tasks.items.anyOf.find((v:any)=>v.properties.kind.enum[0]==='capture');
 assert.deepEqual(capture.properties.target.enum,posts);
 assert.deepEqual(capture.properties.id.anyOf[1].properties.value.anyOf[0].enum,ids);
 for(const [present,value]of [[false,null],[true,null],[true,0]] as const){
  const raw={tasks:[{id:{present:true,value:ids[0]},kind:'capture',target:posts[79],priority:0,until:100,reason:null,maxDrillersPerPlan:{present,value}}]};
  const restored=restoreCodexOptionals(raw,source);
  assert.equal(restored.tasks[0].id,ids[0]);
  assert.equal(restored.tasks[0].target,posts[79]);
  assert.equal(Object.hasOwn(restored.tasks[0],'maxDrillersPerPlan'),present);
  if(present)assert.equal(restored.tasks[0].maxDrillersPerPlan,value);
  assert.equal(Object.hasOwn(restored.tasks[0],'reason'),false);
 }
});

test('presence restoration preserves nested nullable objects, references and malformed non-null values',()=>{
 const source={$defs:{limit:{anyOf:[{type:'integer'},{type:'null'}]}},type:'object',required:['requiredNull'],properties:{cap:{$ref:'#/$defs/limit'},requiredNull:{type:'null'},nested:{anyOf:[{type:'object',additionalProperties:false,required:[],properties:{flag:{type:['boolean','null']}}},{type:'null'}]}}};
 const projected=codexGenerationSchema(source);
 assert.ok(projected.properties.cap.anyOf[0].properties.present);
 assert.deepEqual(projected.properties.requiredNull,{type:'null'});
 const raw={requiredNull:null,cap:{present:false,value:null},nested:{present:true,value:{flag:{present:true,value:false}}}};
 assert.deepEqual(restoreCodexOptionals(raw,source),{requiredNull:null,nested:{flag:false}});
 for(const malformed of [{present:false,value:3},{present:'false',value:null},{present:false,value:null,extra:true}])assert.deepEqual(restoreCodexOptionals({cap:malformed},source),{cap:malformed});
});

test('transport padding is removed without losing real null, zero, false, or invalid non-null fields',()=>{
 const source=modelResponseSchema(intentSchemaFor('strategy',['A','B'],[],['F1']),{friendlyPosts:['A','B']});
 const raw={summary:'',tasks:[{id:null,kind:'transfer',source:'A',target:'B',drillers:null,priority:0,until:120,reason:null}],cancel:[],reviewOn:[],betrayAgreements:null};
 const before=structuredClone(raw),restored=restoreCodexOptionals(raw,source);
 assert.deepEqual(raw,before);assert.equal(Object.hasOwn(restored,'betrayAgreements'),false);
 assert.equal(Object.hasOwn(restored.tasks[0],'reason'),false);assert.equal(restored.tasks[0].id,null);
 assert.equal(restored.tasks[0].drillers,null);assert.equal(restored.tasks[0].priority,0);
 const parsed=parseIntentResult(normalizeIntentResult(decodeModelResponse(restored,'strategy'),[],'strategy',0).value,'strategy',2,new Set(['A','B']),new Set(['F1']));
 assert.equal((parsed.intentEdits!.upsert[0]!.task as any).drillers,null);
 const invalid=restoreCodexOptionals({...raw,betrayAgreements:'invalid'},source);
 assert.equal(invalid.betrayAgreements,'invalid');
 assert.throws(()=>parseIntentResult(normalizeIntentResult(decodeModelResponse(invalid,'strategy'),[],'strategy',0).value,'strategy',2,new Set(['A','B'])),/betrayal/);
 const configured=restoreCodexOptionals({tasks:[{kind:'configure',id:null,target:'A',priority:0,until:120,reason:null,minDrillers:0,maxDrillers:null,maintain:false}]},source);
 assert.equal(configured.tasks[0].minDrillers,0);assert.equal(configured.tasks[0].maxDrillers,null);assert.equal(configured.tasks[0].maintain,false);
});
