import {readFile,writeFile,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Script,createContext} from 'node:vm';
import assert from 'node:assert/strict';
const out=resolve(process.argv[2]??'outputs/ai-context-audit-20261030');
const html=await readFile(join(out,'report.html'),'utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
assert.equal(new Set(ids).size,ids.length);
let links=0,files=0;
for(const [,href] of html.matchAll(/\bhref="([^"]+)"/g)){
 links++;
 if(href.startsWith('#')){assert.ok(ids.includes(href.slice(1)),href);continue;}
 assert.ok(!/^https?:|^javascript:/i.test(href),'Report must remain self contained');
 assert.ok((await stat(resolve(out,href))).isFile(),href);files++;
}
const rows=[...html.matchAll(/<tr data-search="([^"]+)"/g)].map(m=>({dataset:{search:m[1]},hidden:false}));
assert.equal(rows.length,159);
let handler;
const document={getElementById(id){assert.equal(id,'search');return{addEventListener(event,callback){assert.equal(event,'input');handler=callback;}};},querySelectorAll(selector){assert.equal(selector,'#sample-table > tbody > tr','Do not select nested detail table rows');return rows;}};
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];assert.equal(scripts.length,1);
new Script(scripts[0][1]).runInContext(createContext({document}));assert.ok(handler);
for(const [value,expected] of [['strategy',91],['diplomacy',68],['__missing__',0],['',159],['AI-04',rows.filter(r=>r.dataset.search.includes('ai-04')).length]]){
 handler.call({value});assert.equal(rows.filter(r=>!r.hidden).length,expected);
}
const findings=JSON.parse(await readFile(join(out,'findings.json'),'utf8'));
assert.equal(findings.requirements.length,8);assert.equal(findings.verification.passed,true);
for(const r of findings.requirements)assert.ok(r.requirement&&r.evidence.length);
const result={passed:true,verifiedAt:new Date().toISOString(),checks:['unique anchors','all local files and anchors exist','no external dependencies','159 sample rows','filter matches both roles, absent query, empty query and case-insensitive seat','eight explicit objective evidence mappings'],anchors:ids.length,links,localFileLinks:files,sampleRows:rows.length,limitations:'Static structure and filter execution only; no browser rendering or model-quality claim'};
await writeFile(join(out,'report-verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
