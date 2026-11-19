import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {readPromptMaterial} from '../dist/packages/contracts/src/index.js';
const out=resolve(process.argv[2]??'outputs/context-projection-stats-20261030-1321');
const captured=JSON.parse(await readFile(join(out,'captured.json'))),stats=JSON.parse(await readFile(join(out,'statistics.json'))),controls=JSON.parse(await readFile(join(out,'verification-and-controls.json')));
const selected=new Set(stats.pairs.flatMap(p=>[...p.before,...p.after].map(ref=>p.seat+':'+ref))),calls=[];
for(const c of captured.calls)if(selected.has(c.seat+':'+c.callRef)){
 const m=readPromptMaterial(await readFile(join(out,c.file),'utf8'));
 calls.push({...c,militaryEdits:m.kind==='diplomacy'?m.guidance.editPolicy?.militaryEditsAllowed===true:null,executionFeedback:Object.hasOwn(m.guidance,'executionFeasibility'),messages:m.evidence.messages?.length??0});
}
const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
function aggregate(xs){return {n:xs.length,characters:mean(xs.map(x=>x.promptCharacters)),inputTokens:mean(xs.map(x=>x.usage.inputTokens)),providerSeconds:mean(xs.map(x=>x.providerDurationMs/1000)),published:xs.filter(x=>x.processingStatus==='completed').length,validationFailed:xs.filter(x=>x.processingStatus==='failed').length,receiptRows:mean(xs.map(x=>x.receiptRows)),executionFeedback:xs.filter(x=>x.executionFeedback).length,messages:mean(xs.map(x=>x.messages))};}
const diplomacyPermissions={},permissionMatched={};
for(const flag of [false,true]){
 const before=calls.filter(c=>c.kind==='diplomacy'&&c.cohort==='legacy'&&c.militaryEdits===flag),after=calls.filter(c=>c.kind==='diplomacy'&&c.cohort==='deployed'&&c.militaryEdits===flag);
 diplomacyPermissions[String(flag)]={before:aggregate(before),after:aggregate(after)};
 const b=[],a=[];
 for(const seat of new Set(calls.map(c=>c.seat))){const x=before.filter(c=>c.seat===seat),y=after.filter(c=>c.seat===seat),n=Math.min(x.length,y.length);if(n){b.push(...x.slice(-n));a.push(...y.slice(-n));}}
 if(b.length)permissionMatched[String(flag)]={before:aggregate(b),after:aggregate(a)};
}
const feedback={};for(const role of ['strategy','diplomacy'])for(const cohort of ['legacy','deployed'])feedback[role+':'+cohort]=aggregate(calls.filter(c=>c.kind===role&&c.cohort===cohort));
const result={at:new Date().toISOString(),diplomacyPermissions,permissionMatched,feedback};
await writeFile(join(out,'stratified-statistics.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
const csv=v=>'"'+String(v??'').replaceAll('"','""')+'"';
await writeFile(join(out,'comparison.csv'),'role,period,calls,meanPromptCharacters,meanInputTokens,meanOutputTokens,meanProviderSeconds,published,validationFailures,meanReceipts,cacheHitRatio\n'+Object.entries(stats.matched).flatMap(([role,x])=>['before','after'].map(period=>{const r=x[period];return [role,period,r.calls,r.characters.mean,r.inputTokens.mean,r.outputTokens.mean,r.providerMs.mean/1000,r.statuses.completed??0,r.statuses.failed??0,r.receiptRows.mean,r.cache.hitRatio].map(csv).join(',');})).join('\n'));
