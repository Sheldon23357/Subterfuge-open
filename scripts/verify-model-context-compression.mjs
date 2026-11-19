import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readPromptMaterial,readPromptSections,encodeModelData,decodeModelData} from '../dist/packages/contracts/src/index.js';
import {prepareModelMaterial,expandModelReferences} from '../dist/plugins/hybrid/src/model-material.js';
import {hybridBriefPrompt} from '../dist/plugins/hybrid/src/prompts.js';
import {modelNumberHasDisplayPrecision} from '../dist/plugins/hybrid/src/model-numbers.js';
const source=process.argv[2],target=process.argv[3];
if(!source||!target)throw Error('Usage: node scripts/verify-model-context-compression.mjs <capture-directory-with-details> <output-directory>');
const input=resolve(source),out=resolve(target),capture=JSON.parse(await readFile(join(input,'capture.json'),'utf8'));
await mkdir(out,{recursive:true});
await mkdir(join(out,'prompts'),{recursive:true});
const keys=['global','guidance','facts'],calls=[],groups={};
const rows=t=>Array.isArray(t)?t:t?.columns&&t.rows?t.rows.map(r=>Object.fromEntries(t.columns.map((k,i)=>[k,r[i]]))):[];
const path=(v,k)=>k.split('.').reduce((v,k)=>v?.[k],v);
// Restore only explicitly allowed role omissions for information comparisons.
// The exported prompt remains pruned. Unknown paths or non-null assessments fail.
function verifyRoleExclusions(retained,original,excluded){
 const tables=new Map();
 for(const entry of excluded){
  const {path:p,reason}=entry;
  if(p==='guidance.receiptCoverage.previousPublicationSourceCount'){
   assert.equal(reason,'program-audit');assert.equal(path(retained,p),undefined);
   retained.guidance.receiptCoverage.previousPublicationSourceCount=path(original,p);continue;
  }
  const match=/^(guidance\.serverAgreements\.current\.(?:ceasefire|jointAttack))\.(ownProposalRole|allowedActions|inConversation|edits|feasibility|taskFeasibility)$/.exec(p);
  const owner=match?.[1]??(p==='global.roster.chatPlayer'?'global.roster':null),key=match?.[2]??'chatPlayer';
  assert.ok(owner,'Unrecognized role exclusion '+p);
  if(reason==='outside-role'){
   assert.equal(original.kind,'strategy');assert.ok(['ownProposalRole','allowedActions','inConversation','edits','chatPlayer'].includes(key));
   if(key==='chatPlayer'){assert.equal(original.evidence.messages?.length??0,0);assert.ok(!original.guidance.communicationFacts);assert.equal(original.guidance.fixedConversation?.identities?.length??0,0);assert.equal(original.guidance.fixedConversation?.chatPlayers?.length??0,0);}
  }else{
   assert.equal(reason,'empty-role-placeholder');assert.ok(['edits','feasibility','taskFeasibility'].includes(key));
   assert.ok(rows(path(original,owner)).every(r=>r[key]===null),'Only explicit null placeholders may be omitted');
  }
  const group=tables.get(owner)??new Set();group.add(key);tables.set(owner,group);
 }
 for(const [owner,omitted]of tables){
  const before=path(original,owner),after=path(retained,owner);
  if(Array.isArray(before)){
   assert.equal(after.length,before.length);for(let i=0;i<after.length;i++)for(const key of omitted)if(Object.hasOwn(before[i],key))after[i][key]=before[i][key];
  }else{
   assert.deepEqual(after.columns,before.columns.filter(k=>!omitted.has(k)));assert.equal(after.rows.length,before.rows.length);
   after.rows=after.rows.map((r,i)=>before.columns.map((key,j)=>omitted.has(key)?before.rows[i][j]:r[after.columns.indexOf(key)]));after.columns=[...before.columns];
  }
 }
}
const sumSections=p=>readPromptSections(p).filter(s=>keys.includes(s.id.slice(6))).reduce((n,s)=>n+s.text.length,0);
const framedSections=p=>readPromptSections(p).filter(s=>keys.includes(s.id.slice(6))).reduce((n,s)=>n+s.end-s.start,0);
for(const sample of capture.samples){
 const d=JSON.parse(await readFile(join(input,'details',sample.key+'.json'),'utf8'));
 if(d.request.audit?.contextSelection?.version!=='round-material/2')continue;
 assert.equal(createHash('sha256').update(d.request.prompt).digest('hex'),sample.sha256);
 const material=readPromptMaterial(d.request.prompt),original=structuredClone(material),p=prepareModelMaterial(material,d.request.responseSchema);
 // Recover the explicitly documented same-observation time alias from the
 // surviving world clock before comparing relation freshness.
 const retained=structuredClone(p.brief);
 for(const change of p.numericPresentation){
  assert.ok(modelNumberHasDisplayPrecision(change.path),'Only declared display estimates may change');
  assert.ok(Number.isFinite(change.before)&&Number.isFinite(change.after));assert.ok(!Number.isInteger(change.before));
  assert.ok(Math.abs(change.after-change.before)<=.000500001,'Display precision error bound');
  if(change.before!==0)assert.equal(Math.sign(change.after),Math.sign(change.before),'Nonzero sign and magnitude must survive');
  const owner=change.keys.slice(0,-1).reduce((v,k)=>v[k],retained),key=change.keys.at(-1);
  assert.equal(owner[key],change.after,'Numeric audit must match actual model input');owner[key]=change.before;
 }
 verifyRoleExclusions(retained,original,p.excluded);
 if(retained.global.relations?.observedAt===undefined&&original.global.relations?.observedAt===retained.global.time.worldDay)retained.global.relations.observedAt=retained.global.time.worldDay;
 const canonical=v=>{
  if(typeof v==='string')return Object.hasOwn(p.references,v)?p.references[v]:v;
  if(Array.isArray(v))return v.map(canonical);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!['meaning','interpretation','launchSourceMeaning'].includes(k)).map(([k,x])=>[k,canonical(x)]));
  return v;
 };
 assert.deepEqual(material,original,sample.key+' original mutation');
 assert.deepEqual(p.brief.evidence,original.evidence,sample.key+' raw evidence');
 for(const key of keys)assert.deepEqual(decodeModelData(encodeModelData({[key]:p.brief[key]})),JSON.parse(JSON.stringify({[key]:p.brief[key]})),sample.key+' codec '+key);
 // Selected program conclusions (and legacy captured planning), obligations, task constraints,
 // receipts and selected consequences must survive, not just their counts.
 const preserved=['global.players','global.roster','global.identities','global.criticalAssets','global.ownFleets','global.planning','global.attackAssessment','global.relations','global.economy.ownPosts','global.economy.otherListedOutposts','global.economy.coverage','global.feedback.selected','global.feedback.coverage','global.feedback.sharedRisks','global.feedback.evaluatedDefaults','global.feedback.unverified','global.feedback.limitations','guidance.commander','guidance.executionRules','guidance.intentTasks','guidance.readOnlyIntentTasks','guidance.executionFeasibility','guidance.serverAgreements','guidance.contractResults','guidance.receiptCoverage.available','guidance.receiptCoverage.unavailableBeforeWindow','guidance.receiptCoverage.previousPublicationSourceCount','guidance.strategic','guidance.conversation','guidance.relationAdvice.agreementCapacity','guidance.relationAdvice.fronts','guidance.relationAdvice.serverLimits','guidance.relationAdvice.recommendedNewCommitment','guidance.relationAdvice.suggestedSubsidyCeiling','facts.outposts','facts.taskTargets','facts.fleets','facts.scheduled','changes','unknowns'];
 for(const key of preserved)assert.deepEqual(canonical(path(retained,key)),canonical(path(original,key)),sample.key+' retained '+key);
 const beforeFeedback=original.global.feedback,afterFeedback=p.brief.global.feedback;
 if(beforeFeedback){
  const previous=(beforeFeedback.conditionalAlternatives??[]).map(canonical),actual=(afterFeedback.conditionalAlternatives??[]).map(canonical);let prior=-1;
  for(const plan of actual){const index=previous.findIndex((p,i)=>i>prior&&isDeepStrictEqual(p,plan));assert.ok(index>=0,sample.key+' alternative order/content');prior=index;}
  for(const plan of previous)if(!actual.some(p=>isDeepStrictEqual(p,plan))){
   assert.deepEqual(plan.differenceFromSelected,{add:[],remove:[]},sample.key+' only a zero-difference plan may be omitted');
   const {differenceFromSelected,...consequences}=plan;
   assert.deepEqual({...consequences,actions:canonical(beforeFeedback.selected.actions)},canonical(beforeFeedback.selected),sample.key+' removed option must equal selected in every consequence');
  }
 }
 const beforeCandidates=rows(original.global.planning?.candidates),afterCandidates=rows(p.brief.global.planning?.candidates);assert.equal(afterCandidates.length,beforeCandidates.length);
 const query=p.responseSchema.properties.needsInformation;
 assert.deepEqual(canonical(query.items?.enum??[]),canonical(original.facts.requestableInformation),sample.key+' query permission');
 assert.deepEqual(canonical(p.responseSchema),canonical(d.request.responseSchema),sample.key+' schema scope');
 if(d.call.reply?.arguments){
  const output=d.call.reply.arguments,toShort=new Map(Object.entries(p.references).map(([s,f])=>[f,s]));
  const shrink=v=>typeof v==='string'?toShort.get(v)??v:Array.isArray(v)?v.map(shrink):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,['message','summary','reason','internalIntent','agreementSummary'].includes(k)?x:shrink(x)])):v;
  assert.deepEqual(expandModelReferences(shrink(output),p.references),expandModelReferences(output,p.references),sample.key+' historical output identity equivalence');
 }
 const prompt=hybridBriefPrompt(material.kind,!!original.global.relations,!!original.global.opening,original.guidance.editPolicy?.militaryEditsAllowed===false,p.brief,p.responseSchema);
 assert.deepEqual(readPromptMaterial(prompt),JSON.parse(JSON.stringify(p.brief)),sample.key+' saved prompt decoding');
 await writeFile(join(out,'prompts',sample.key+'.txt'),prompt);
 const record={key:sample.key,role:material.kind,before:sumSections(d.request.prompt),after:sumSections(prompt),beforeFramed:framedSections(d.request.prompt),afterFramed:framedSections(prompt),beforeFull:d.request.prompt.length,afterFull:prompt.length,preservedRoots:preserved.length,excluded:p.excluded,deduplicated:p.deduplicated,numericPresentation:p.numericPresentation,references:Object.keys(p.references).length,beforeHash:sample.sha256,afterHash:createHash('sha256').update(prompt).digest('hex'),schemaHash:createHash('sha256').update(JSON.stringify(p.responseSchema)).digest('hex')};
 calls.push(record);for(const role of ['all',material.kind]){const group=groups[role]??={calls:0,before:0,after:0,beforeFramed:0,afterFramed:0,beforeFull:0,afterFull:0};group.calls++;for(const k of ['before','after','beforeFramed','afterFramed','beforeFull','afterFull'])group[k]+=record[k];}
}
assert.ok(calls.length>0,'No eligible frozen current-version calls');
for(const group of Object.values(groups)){group.reduction=1-group.after/group.before;group.framedReduction=1-group.afterFramed/group.beforeFramed;group.fullReduction=1-group.afterFull/group.beforeFull;}
const passed=Object.values(groups).every(g=>g.reduction>=0.5&&g.framedReduction>=0.5);
const result={passed,at:new Date().toISOString(),source:input,unit:'UTF-16 saved section body characters; full prompt measured separately; no data shifted to another dynamic section',groups,calls,limits:['Frozen same-state replay and exact information/permission checks do not alone establish model decision quality.','Historical outputs are identity-restored for equivalence; these are not fresh model decisions.','Aggregate 50% is required overall and for each sampled role; individual requests vary.']};
await writeFile(join(out,'compression-verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({passed,samples:calls.length,groups},null,2));
if(!passed)process.exitCode=1;
