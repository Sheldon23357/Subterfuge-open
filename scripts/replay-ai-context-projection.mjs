import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {projectContextForModel} from '../dist/plugins/hybrid/src/model-context.js';
import {readPromptMaterial,readPromptSections} from '../dist/packages/contracts/src/index.js';
const out=resolve(process.argv[2]??'outputs/ai-context-audit-20261030');
const capture=JSON.parse(await readFile(join(out,'capture.json'),'utf8'));
const size=b=>['global','guidance','facts'].reduce((n,k)=>n+JSON.stringify({[k]:b[k]}).length,0),roles={},calls=[];
const rows=t=>Array.isArray(t)?t:t?.columns&&t.rows?t.rows.map(r=>Object.fromEntries(t.columns.map((k,i)=>[k,r[i]]))):[];
for(const sample of capture.samples){
 const prompt=await readFile(join(out,sample.file),'utf8');assert.equal(createHash('sha256').update(prompt).digest('hex'),sample.sha256);
 if(readPromptSections(prompt)?.some(s=>s.format==='compact'))throw Error('Projection replay expects a legacy JSON baseline; use verify-model-context-compression.mjs for encoded-material replay.');
 const original=readPromptMaterial(prompt);
 const text=JSON.stringify([original.evidence,original.guidance.commander,original.guidance.strategic,original.guidance.executionRules,original.guidance.diplomacyPurpose,original.guidance.intentTasks,original.guidance.readOnlyIntentTasks,original.global.criticalAssets]);
 const names=original.global.identities.map(r=>r[0]),focus=new Set(names.filter(name=>text.includes(name)));
 // Historical captures do not retain the producer's explicit task.posts. Use a
 // documented wider protected set; this does not claim an exact live replay.
 const model=projectContextForModel(original,focus),after=model.brief;
 const facts=after.facts;
 if(facts.remainingInformationPasses!==0)facts.requestableInformation=[...new Set([...(facts.requestableInformation??[]),...model.omittedFleetIds,...model.omittedOutpostNames])];
 assert.deepEqual(after.evidence,original.evidence);assert.deepEqual(after.changes,original.changes);
 assert.deepEqual(after.guidance.commander,original.guidance.commander);assert.deepEqual(after.guidance.executionRules,original.guidance.executionRules);
 assert.deepEqual(after.global.planning.estimates,original.global.planning.estimates);
 const beforeCandidates=rows(original.global.planning.candidates),afterCandidates=rows(after.global.planning.candidates);
 assert.equal(beforeCandidates.length,afterCandidates.length);
 for(let i=0;i<beforeCandidates.length;i++)for(const key of Object.keys(beforeCandidates[i]).filter(k=>k!=='reasons'))assert.deepEqual(afterCandidates[i][key],beforeCandidates[i][key]);
 const before=size(original),projected=size(after),saving=before-projected;
 const r=roles[sample.kind]??={calls:0,before:0,after:0,saving:0,positive:0,negative:0};r.calls++;r.before+=before;r.after+=projected;r.saving+=saving;if(saving>0)r.positive++;if(saving<0)r.negative++;
 calls.push({sample:sample.key,kind:sample.kind,before,after:projected,saving,omittedFleets:model.omittedFleetIds.length,omittedPosts:model.omittedOutpostNames.length});
}
const result={at:new Date().toISOString(),passed:true,samples:calls.length,roles,calls,limitations:['Replays the production model-only projector against frozen historical prompts.','The original task.posts and current-source execution-feasibility additions are not captured.','Includes supplementary-lookup catalogs for summarized entities.','Does not simulate the new receipt delivery fence or the authorized source window expanding from last twelve to all available new receipts.','Character changes do not establish token usage or model decision quality.']};
await writeFile(join(out,'implemented-projection-replay.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({passed:result.passed,samples:calls.length,roles,limitations:result.limitations}));
