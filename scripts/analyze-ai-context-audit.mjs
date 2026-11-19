import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createGzip} from 'node:zlib';
import {once} from 'node:events';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readPromptSections,readPromptMaterial} from '../dist/packages/contracts/src/index.js';
import {inspectJson,selfTest,pruneEmptyMembers,transformTables} from './ai-context-audit-core.mjs';

selfTest();
const out=resolve(process.argv[2]??'outputs/ai-context-audit-20261030'),capture=JSON.parse(await readFile(join(out,'capture.json'),'utf8'));
const targets=['global','guidance','facts'],calls=[],sectionTotals={},fieldTotals={},idTotals={},tableTotals={},blankTotals={},floatTotals={},duplicates=[];
const spanFile=createWriteStream(join(out,'character-spans.jsonl.gz')),zip=createGzip();zip.pipe(spanFile);
const emit=async row=>{if(!zip.write(JSON.stringify(row)+'\n'))await once(zip,'drain');};
const sum=values=>values.reduce((a,b)=>a+b,0),norm=path=>path.replace(/\[\d+\]/g,'[*]');
const add=(target,key,chars=0)=>{const r=target[key]??={count:0,characters:0};r.count++;r.characters+=chars;return r;};
function logicalPath(path,tables){
 for(const table of [...tables].sort((a,b)=>b.path.length-a.path.length)){
  const prefix=table.path+'.'+table.rowKey+'[';if(!path.startsWith(prefix))continue;
  const rest=path.slice(prefix.length),match=/^(\d+)\]\[(\d+)\](.*)$/.exec(rest);
  if(match)return norm(table.path)+'.'+table.rowKey+'[*].'+(table.columns[Number(match[2])]??match[2])+norm(match[3]);
 }
 return norm(path);
}
function rosterInline(material){
 const roster=material.global.roster;if(!roster?.columns||!roster.rows)return null;
 const players=roster.rows.map(row=>Object.fromEntries(roster.columns.map((key,i)=>[key,row[i]])));
 const game=new Map(players.map(p=>[p.gamePlayer,p.name])),chat=new Map(players.map(p=>[p.chatPlayer,p.name]));
 const fields=new Set(['player','owner','peer','enemy','self','selfChat','gamePlayer','chatPlayer','from','to','rivalPlayer']);
 function convert(value,key=''){
  if(typeof value==='number'&&fields.has(key)){const map=['from','to','selfChat','chatPlayer'].includes(key)?chat:game;return map.get(value)??value;}
  if(Array.isArray(value))return value.map(v=>convert(v,['players','peers','chatPlayers','forbiddenPlayers'].includes(key)?key==='chatPlayers'?'chatPlayer':'player':''));
  if(!value||typeof value!=='object')return value;
  if(value.columns&&value.rows){const table=structuredClone(value);table.rows=table.rows.map(row=>row.map((v,i)=>convert(v,table.columns[i])));return table;}
  return Object.fromEntries(Object.entries(value).filter(([k])=>!(key==='global'&&k==='roster')).map(([k,v])=>[k,convert(v,k)]));
 }
 const result=convert(material);
 // identities is an implicit [name, owner, visibility] table in current source.
 if(Array.isArray(result.global.identities))result.global.identities=result.global.identities.map(row=>[row[0],game.get(row[1])??row[1],row[2]]);
 return result;
}
function queryableInline(material){
 const {global:g,facts:f}=material,identities=g.identities,requestable=f.requestableInformation;
 if(!Array.isArray(identities)||!Array.isArray(requestable)||!requestable.length||!requestable.every(name=>identities.some(r=>r[0]===name)))return null;
 const clone=structuredClone(material),set=new Set(requestable);
 clone.global.identities={columns:['name','owner','visibility','canRequestMore'],rows:identities.map(row=>[...row,set.has(row[0])])};
 delete clone.facts.requestableInformation;return clone;
}
const encodedSize=material=>sum(targets.map(k=>JSON.stringify({[k]:material[k]}).length));
for(const sample of capture.samples){
 const prompt=await readFile(join(out,sample.file),'utf8');assert.equal(createHash('sha256').update(prompt).digest('hex'),sample.sha256);
 const sections=readPromptSections(prompt);assert.ok(sections);assert.equal(sum(sections.map(s=>s.end-s.start)),prompt.length);
 if(sections.some(s=>s.format==='compact'))throw Error('This lexical audit measures JSON source only. For !model-data/1 use scripts/verify-model-context-compression.mjs; never count decoded JSON as encoded source.');
 const material=readPromptMaterial(prompt),result={key:sample.key,seat:sample.seat,kind:sample.kind,tick:sample.tick,callRef:sample.callRef,fullCharacters:prompt.length,sections:{},scenarios:{},indexTables:[],topRepeatedStrings:[]};
 const perCallStrings=new Map(),allIds=[];let bodyTotal=0,selectedTotal=0;
 for(const name of targets){
  const section=sections.find(s=>s.id==='brief.'+name);assert.ok(section);const audit=inspectJson(section.text);
  const {categories,blanks,ids,tables,fields,blankRows,floatRows}=audit;
  const bodyChars=section.text.length,framedChars=section.end-section.start;bodyTotal+=bodyChars;selectedTotal+=framedChars;
  allIds.push(...ids.map(id=>({...id,logicalPath:logicalPath(id.path,tables)})));
  const target=audit.root.members.find(m=>m.key.value===name).value;
  const children=fields.filter(f=>f.path.startsWith('$.'+name+'.')&&f.path.slice(name.length+3).split('.').length===1&&!f.path.includes('['));
  const topFieldTotal=sum(children.map(f=>f.memberCharacters));
  const wrapperCharacters=bodyChars-topFieldTotal;assert.ok(wrapperCharacters>=0);
  result.sections[name]={bodyChars,framedChars,markerChars:framedChars-bodyChars,categories,blanks,longIds:{occurrences:ids.length,unique:new Set(ids.map(i=>i.id)).size,characters:sum(ids.map(i=>i.characters))},tables,fields,blankRows,floatRows,wrapperCharacters,topFields:children};
  const key=sample.kind+':'+name,agg=sectionTotals[key]??={calls:0,bodyChars:0,framedChars:0,markerChars:0,categories:{},blanks:{},longIdCharacters:0,longIdOccurrences:0};
  agg.calls++;agg.bodyChars+=bodyChars;agg.framedChars+=framedChars;agg.markerChars+=framedChars-bodyChars;
  for(const [k,n] of Object.entries(categories))agg.categories[k]=(agg.categories[k]??0)+n;
  for(const [k,n] of Object.entries(blanks))agg.blanks[k]=(agg.blanks[k]??0)+n;
  agg.longIdCharacters+=sum(ids.map(i=>i.characters));agg.longIdOccurrences+=ids.length;
  for(const field of children){const r=add(fieldTotals,key+':'+field.path,field.memberCharacters);r.valueCharacters=(r.valueCharacters??0)+field.valueCharacters;}
  for(const id of ids){const r=add(idTotals,key+':'+id.kind+':'+logicalPath(id.path,tables),id.characters);r.kind=id.kind;}
  for(const b of blankRows){const r=add(blankTotals,key+':'+b.kind+':'+logicalPath(b.path,tables),b.characters);r.memberCharacters=(r.memberCharacters??0)+b.memberCharacters;}
  for(const f of floatRows)add(floatTotals,key+':'+logicalPath(f.path,tables),f.characters);
  for(const table of tables){const r=add(tableTotals,key+':'+norm(table.path),table.characters);r.rows=(r.rows??0)+table.rows;r.cells=(r.cells??0)+table.cells;r.nullCells=(r.nullCells??0)+table.nullCells;r.emptyTables=(r.emptyTables??0)+(table.rows===0?1:0);r.emptySchemaSaving=(r.emptySchemaSaving??0)+table.emptySchemaSaving;r.headerCharacters=(r.headerCharacters??0)+table.headerCharacters;r.recordDelta=(r.recordDelta??0)+table.tupleToRecordsDelta;r.allNullColumns??={};for(const c of table.allNullColumns)r.allNullColumns[c]=(r.allNullColumns[c]??0)+1;}
  const header={sample:sample.key,section:name};
  await emit({...header,kind:'sectionMarker',path:'$marker.open',start:section.start,end:section.bodyStart});
  for(const t of audit.tokens)await emit({...header,...t,start:t.start+section.bodyStart,end:t.end+section.bodyStart});
  await emit({...header,kind:'sectionMarker',path:'$marker.close',start:section.bodyEnd,end:section.end});
  for(const node of audit.nodes)if(node.kind==='string'&&node.value.length>=40){const raw=section.text.slice(node.start,node.end);const entry=perCallStrings.get(raw)??{text:node.value,characters:raw.length,paths:[]};entry.paths.push(name+':'+logicalPath(node.path,tables));perCallStrings.set(raw,entry);}
 }
 result.bodyChars=bodyTotal;result.framedChars=selectedTotal;result.selectedShare=selectedTotal/prompt.length;
 assert.equal(encodedSize(material),bodyTotal,'source is the actual canonical JSON, not a reformatted estimate');
 const map=new Map();let index=0;for(const id of allIds)if(!map.has(id.id))map.set(id.id,'@'+(/agreement|scopeContracts|serverAgreements|contracts\[|eligibleAgreementIds/i.test(id.logicalPath)?'A':id.id.startsWith('diplomacy-')?'M':id.kind==='scopedHash'?'F':'I')+(++index));
 let replaced=targets.map(k=>sections.find(s=>s.id==='brief.'+k).text).join('');
 for(const [id,alias] of [...map].sort((a,b)=>b[0].length-a[0].length))replaced=replaced.split(id).join(alias);
 result.scenarios.shortIds={before:bodyTotal,after:replaced.length,saving:bodyTotal-replaced.length,uniqueAliases:map.size};
 const transform=(label,fn)=>{const after=encodedSize(fn(material));result.scenarios[label]={before:bodyTotal,after,saving:bodyTotal-after};};
 transform('removeEmptyObjectMembers',pruneEmptyMembers);
 transform('emptyTablesToLists',m=>transformTables(m,'emptyTables'));
 transform('factorAllNullColumns',m=>transformTables(m,'nullColumns'));
 const inlineRoster=rosterInline(material),inlineQueries=queryableInline(material);
 if(inlineRoster)result.scenarios.inlineRosterNames={before:bodyTotal,after:encodedSize(inlineRoster),saving:bodyTotal-encodedSize(inlineRoster)};
 if(inlineQueries)result.scenarios.inlineQueryableCatalog={before:bodyTotal,after:encodedSize(inlineQueries),saving:bodyTotal-encodedSize(inlineQueries)};
 if(Array.isArray(material.global.identities)){const count=material.global.identities.length,size=JSON.stringify(material.global.identities).length;result.indexTables.push({path:'global.identities',rows:count,characters:size,namedObjectCharacters:JSON.stringify(material.global.identities.map(([name,owner,visibility])=>({name,owner,visibility}))).length,withColumnNamesCharacters:JSON.stringify({columns:['name','owner','visibility'],rows:material.global.identities}).length});}
 for(const path of ['global.roster','facts.requestableInformation','guidance.reusableTaskIds','guidance.fixedConversation.identities']){let v=material;for(const k of path.split('.'))v=v?.[k];if(v!==undefined)result.indexTables.push({path,characters:JSON.stringify(v).length,rows:Array.isArray(v)?v.length:v?.rows?.length??null});}
 result.topRepeatedStrings=[...perCallStrings.values()].filter(s=>s.paths.length>1).map(s=>({...s,occurrences:s.paths.length,redundantCharacters:(s.paths.length-1)*s.characters})).sort((a,b)=>b.redundantCharacters-a.redundantCharacters);
 result.duplicateLongStringCharacters=sum(result.topRepeatedStrings.map(s=>s.redundantCharacters));
 duplicates.push(...result.topRepeatedStrings.map(s=>({sample:sample.key,kind:sample.kind,...s})));
 calls.push(result);
}
zip.end();await once(spanFile,'close');
const scenarios={};for(const call of calls)for(const [key,s] of Object.entries(call.scenarios)){const r=scenarios[call.kind+':'+key]??={calls:0,before:0,after:0,saving:0,positive:0,negative:0};r.calls++;r.before+=s.before;r.after+=s.after;r.saving+=s.saving;if(s.saving>0)r.positive++;if(s.saving<0)r.negative++;}
const summary={capture:{startedAt:capture.startedAt,finishedAt:capture.finishedAt,samples:calls.length,distinctPrompts:new Set(capture.samples.map(s=>s.sha256)).size,skipped:capture.skipped.length,kinds:Object.fromEntries([...new Set(calls.map(c=>c.kind))].map(k=>[k,calls.filter(c=>c.kind===k).length])),tickRange:[Math.min(...calls.map(c=>c.tick)),Math.max(...calls.map(c=>c.tick))]},totals:{fullPromptCharacters:sum(calls.map(c=>c.fullCharacters)),selectedCharacters:sum(calls.map(c=>c.framedChars)),selectedBodyCharacters:sum(calls.map(c=>c.bodyChars))},sectionTotals,fieldTotals,idTotals,blankTotals,tableTotals,floatTotals,scenarios};
await writeFile(join(out,'analysis.json'),JSON.stringify(summary,null,2));
await writeFile(join(out,'per-call.json'),JSON.stringify(calls,null,2));
await writeFile(join(out,'repeated-strings.json'),JSON.stringify(duplicates,null,2));
const csv=s=>'"'+String(s??'').replaceAll('"','""')+'"';
await writeFile(join(out,'field-ledger.csv'),'sample,kind,tick,section,path,memberCharacters,valueCharacters,sourceStart,sourceEnd\n'+calls.flatMap(c=>targets.flatMap(name=>c.sections[name].fields.map(f=>[c.key,c.kind,c.tick,name,f.path,f.memberCharacters,f.valueCharacters,f.start+capture.samples.find(s=>s.key===c.key).sections.find(s=>s.id==='brief.'+name).bodyStart,f.end+capture.samples.find(s=>s.key===c.key).sections.find(s=>s.id==='brief.'+name).bodyStart].map(csv).join(',')))).join('\n'));
console.log(JSON.stringify({capture:summary.capture,totals:summary.totals,sections:Object.fromEntries(Object.entries(sectionTotals).map(([k,v])=>[k,{calls:v.calls,meanBody:Math.round(v.bodyChars/v.calls),nulls:v.blanks.null,longIdCharacters:v.longIdCharacters,longIdOccurrences:v.longIdOccurrences}]))}));
