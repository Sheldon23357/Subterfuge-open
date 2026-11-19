import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=(name:string)=>JSON.parse(fs.readFileSync(name,'utf8'));
test('coverage includes every documented rule and specialist without duplicate ids',()=>{
  const coverage=read('docs/research/data/coverage.json') as {id:string;source_ids:string[];spec_examples:string[]}[];
  const ids=new Set(coverage.map(c=>c.id));assert.equal(ids.size,coverage.length);
  for(const rule of read('docs/rules/data/rules.json'))assert.ok(ids.has(rule.id),rule.id);
  for(const spec of read('docs/rules/data/specialists.json'))assert.ok(ids.has(`SPEC-${spec.id}`),spec.id);
  const sources=new Set(read('docs/rules/data/sources.json').map((s:{id:string})=>s.id));
  for(const entry of coverage){
    for(const id of entry.source_ids)assert.ok(sources.has(id),`${entry.id}:${id}`);
    assert.ok(Array.isArray(entry.spec_examples));
  }
});
test('audit source fingerprint and fixture counts match the locked baseline',()=>{
  const baseline=read('docs/rules/data/build-manifest.json'),audit=read('docs/research/data/audit-manifest.json');
  assert.equal(audit.source_sha256,baseline.formatted_js_sha256);
  assert.equal(audit.purpose,'reference-source-inventory');
  const numerical=read('docs/research/data/reference-samples.json');
  const recruitment=read('docs/research/data/recruitment-reference-samples.json');
  assert.equal(numerical.source_sha256,baseline.formatted_js_sha256);
  assert.equal(recruitment.source_sha256,baseline.formatted_js_sha256);
  assert.equal(numerical.samples.length,audit.original_method_samples);
  assert.equal(recruitment.samples.length,audit.recruitment_samples);
});
test('asset ids are unique and formal tutorials are separate from debug scenarios',()=>{
  const assets=read('docs/research/data/assets.json');
  assert.equal(new Set(assets.map((a:{id:string})=>a.id)).size,assets.length);
  for(const asset of assets){assert.match(asset.sha256,/^[a-f0-9]{64}$/);assert.ok(asset.bytes>0);}
  const tutorials=read('docs/research/data/tutorials.json');
  assert.equal(tutorials.filter((t:{debug:boolean})=>!t.debug).length,24);
  assert.equal(tutorials.filter((t:{debug:boolean})=>t.debug).length,6);
});
