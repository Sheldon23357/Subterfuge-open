import {readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';

// Independent verification of saved source slices; does not use the custom parser.
const out=resolve(process.argv[2]??'outputs/ai-context-audit-20261030');
const read=async name=>JSON.parse(await readFile(join(out,name),'utf8'));
const capture=await read('capture.json'),analysis=await read('analysis.json'),calls=await read('per-call.json'),semantic=await read('semantic-metrics.json');
const targets=['global','guidance','facts'],records=new Map(),categories={},sectionTotals={};
let originalCharacters=0,bodyCharacters=0,framedCharacters=0,sourceFiles=0,topMembers=0;
const semanticChecks={};
const rows=t=>t?.columns&&t.rows?t.rows.map(row=>Object.fromEntries(t.columns.map((column,i)=>[column,row[i]]))):[];
for(const sample of capture.samples){
 const prompt=await readFile(join(out,sample.file),'utf8');
 assert.equal(createHash('sha256').update(prompt).digest('hex'),sample.sha256);
 assert.equal(prompt.length,sample.characters);sourceFiles++;originalCharacters+=prompt.length;
 let position=0;
 for(const section of sample.sections){assert.equal(section.start,position);assert.ok(section.start<=section.bodyStart&&section.bodyStart<section.bodyEnd&&section.bodyEnd<section.end);position=section.end;}
 assert.equal(position,prompt.length);
 const call=calls.find(c=>c.key===sample.key);assert.ok(call);
 const material={};
 for(const name of targets){
  const section=sample.sections.find(s=>s.id==='brief.'+name),stats=call.sections[name];
  const text=prompt.slice(section.bodyStart,section.bodyEnd),value=JSON.parse(text);
  assert.deepEqual(Object.keys(value),[name]);assert.equal(JSON.stringify(value),text);material[name]=value[name];
  assert.equal(text.length,stats.bodyChars);assert.equal(section.end-section.start,stats.framedChars);
  assert.equal(stats.topFields.reduce((n,f)=>n+f.memberCharacters,0)+stats.wrapperCharacters,text.length);
  let last=-1;
  for(const f of stats.topFields){assert.ok(f.start>=last);assert.equal(f.end-f.start,f.memberCharacters);assert.equal(text[f.start],'"');last=f.end;topMembers++;}
  records.set(sample.key+':'+name,{sample,section,prompt,stats,at:section.start,categories:{},spans:0});
  bodyCharacters+=text.length;framedCharacters+=section.end-section.start;
 }
 const {global:g,guidance:h,facts:f}=material;
 const result=semanticChecks[sample.kind]??={contractRows:0,terminalContractRows:0,terminalRowCharacters:0,contractCells:0,nullContractCells:0,sourceMetadataCharacters:0,sourceWorldDayDuplicate:0,uneditableCalls:0,uneditableSelectorCharacters:0,taskRowsMissingTransferDetails:0,ownFleetRows:0,ownFleetRowsWithEta:0,foreignFleetRows:0,foreignFleetRowsWithEta:0,criticalIncomingRows:0,criticalIncomingRowsWithEta:0};
 const contracts=rows(h.serverAgreements);
 result.contractRows+=contracts.length;
 for(let i=0;i<contracts.length;i++){
  const row=h.serverAgreements.rows[i];result.contractCells+=row.length;result.nullContractCells+=row.filter(v=>v===null).length;
  if(!['active','proposed'].includes(contracts[i].status)){result.terminalContractRows++;result.terminalRowCharacters+=JSON.stringify(row).length;}
 }
 const withoutMetadata=structuredClone(g);delete withoutMetadata.planning.basisRevision;delete withoutMetadata.planning.worldDay;delete withoutMetadata.commanderVersion;
 result.sourceMetadataCharacters+=JSON.stringify(g).length-JSON.stringify(withoutMetadata).length;
 if(g.time.worldDay===g.planning.worldDay)result.sourceWorldDayDuplicate++;
 if(h.editPolicy?.militaryEditsAllowed===false){
  result.uneditableCalls++;const restricted=structuredClone(h.editPolicy);delete restricted.friendlyTargets;delete restricted.returnFleetIds;
  result.uneditableSelectorCharacters+=JSON.stringify(h.editPolicy).length-JSON.stringify(restricted).length;
 }
 for(const t of [...rows(h.intentTasks),...rows(h.readOnlyIntentTasks)])if(t.kind==='transfer'&&(!Object.hasOwn(t,'source')||!Object.hasOwn(t,'drillers')))result.taskRowsMissingTransferDetails++;
 for(const [name,fleetRows] of [['ownFleet',rows(g.ownFleets)],['foreignFleet',rows(f.fleets)],['criticalIncoming',g.criticalAssets.hostileApproaches]]){
  result[name+'Rows']+=fleetRows.length;
  result[name+'RowsWithEta']+=fleetRows.filter(row=>Object.keys(row).some(key=>/arrival|eta|travel|remaining.*(?:day|tick)/i.test(key))).length;
 }
}
let spans=0;
const stream=createReadStream(join(out,'character-spans.jsonl.gz')).pipe(createGunzip());
for await(const line of createInterface({input:stream,crlfDelay:Infinity})){
 const span=JSON.parse(line),record=records.get(span.sample+':'+span.section);assert.ok(record);
 assert.equal(span.start,record.at);assert.ok(span.end>span.start&&span.end<=record.section.end);
 const raw=record.prompt.slice(span.start,span.end),size=span.end-span.start;
 if(span.kind==='sectionMarker'){
  assert.ok(span.start===record.section.start&&span.end===record.section.bodyStart||span.start===record.section.bodyEnd&&span.end===record.section.end);
 }else{
  assert.ok(span.start>=record.section.bodyStart&&span.end<=record.section.bodyEnd);
  if(span.kind==='propertyName'||span.kind==='stringValue')assert.equal(typeof JSON.parse(raw),'string');
  else if(span.kind==='null')assert.equal(raw,'null');
  else if(span.kind==='number')assert.equal(typeof JSON.parse(raw),'number');
  else if(span.kind==='boolean')assert.equal(typeof JSON.parse(raw),'boolean');
  else if(span.kind==='whitespace')assert.match(raw,/^[ \t\r\n]+$/);
  else if(span.kind==='punctuation')assert.match(raw,/^[\[\]{},:]$/);
  else assert.fail('Unknown token kind '+span.kind);
  record.categories[span.kind]=(record.categories[span.kind]??0)+size;
  categories[span.kind]=(categories[span.kind]??0)+size;
 }
 record.at=span.end;record.spans++;spans++;
}
for(const r of records.values()){
 assert.equal(r.at,r.section.end);assert.deepEqual(r.categories,r.stats.categories);
 const key=r.sample.kind+':'+r.section.id.slice(6),s=sectionTotals[key]??={bodyChars:0,framedChars:0,categories:{}};
 s.bodyChars+=r.stats.bodyChars;s.framedChars+=r.stats.framedChars;
 for(const [k,n] of Object.entries(r.categories))s.categories[k]=(s.categories[k]??0)+n;
}
for(const [key,s] of Object.entries(sectionTotals)){assert.equal(s.bodyChars,analysis.sectionTotals[key].bodyChars);assert.equal(s.framedChars,analysis.sectionTotals[key].framedChars);assert.deepEqual(s.categories,analysis.sectionTotals[key].categories);}
assert.equal(originalCharacters,analysis.totals.fullPromptCharacters);
assert.equal(bodyCharacters,analysis.totals.selectedBodyCharacters);
assert.equal(framedCharacters,analysis.totals.selectedCharacters);
assert.equal(Object.values(categories).reduce((n,v)=>n+v,0),bodyCharacters);
for(const [role,metrics] of Object.entries(semanticChecks))for(const [key,value] of Object.entries(metrics))assert.equal(value,semantic.roles[role][key],role+':'+key);
const sourcePaths=['plugins/hybrid/src/brief.ts','plugins/hybrid/src/brief-projection.ts','plugins/hybrid/src/diplomacy-context.ts','plugins/hybrid/src/model-wire.ts','plugins/hybrid/src/model-names.ts','plugins/hybrid/src/diplomacy-edit-scope.ts','packages/ai/src/controller/presentation/fleet-labels.ts','packages/contracts/src/prompt-sections.ts','packages/engine/src/world-economy.ts','packages/rules/src/index.ts'];
const sourceHashes={};for(const path of sourcePaths)sourceHashes[path]=createHash('sha256').update(await readFile(path)).digest('hex');
const result={verifiedAt:new Date().toISOString(),passed:true,scope:'Frozen captures and three selected sections; UTF-16 source offsets; no model quality or production behavior assertion',sourceFiles,selectedSections:records.size,spans,topLevelMembers:topMembers,originalCharacters,bodyCharacters,framedCharacters,categories,semanticChecks,sourceHashes};
await writeFile(join(out,'verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
