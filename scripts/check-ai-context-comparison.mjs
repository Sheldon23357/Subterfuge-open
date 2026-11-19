import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {consoleApi} from '../outputs/context-projection-apply-20261030/manage.mjs';
const out=resolve(process.argv[2]??'outputs/context-projection-stats-20261030-1321'),capture=JSON.parse(await readFile(join(out,'captured.json'))),stats=JSON.parse(await readFile(join(out,'statistics.json'))),api=await consoleApi();
const requestChecks=[],pairChecks=[];
for(const c of capture.calls){const text=await readFile(join(out,c.file),'utf8');assert.equal(createHash('sha256').update(text).digest('hex'),c.sha256);assert.equal(text.length,c.capturedCharacters);assert.equal(text.length,c.promptCharacters);}
const selected=new Map();for(const pair of stats.pairs)for(const key of ['before','after'])for(const ref of pair[key])selected.set(pair.seat+':'+ref,{pair,period:key,ref});
await Promise.all(capture.status.filter(s=>s.bound).map(async seat=>{
 const generation=JSON.parse(await readFile(join(out,seat.id+'-call-metadata.json'))).generation;
 for(const item of selected.values()){
  if(item.pair.seat!==seat.id)continue;
  let text='',offset=0;
  do{const p=await api('/api/agent/debug/content?seat='+seat.id+'&generation='+encodeURIComponent(generation)+'&ref='+item.ref+'&kind=request&offset='+offset+'&limit=32768');assert.equal(p.available,true);assert.equal(p.truncated,false);text+=p.text??'';offset=p.nextOffset;}while(offset!==null);
  const r=JSON.parse(text),c=capture.calls.find(c=>c.seat===seat.id&&c.callRef===item.ref);assert.ok(c);assert.equal(r.prompt.length,c.promptCharacters);
  const schema=r.responseSchema?JSON.stringify(r.responseSchema):null;
  requestChecks.push({seat:seat.id,ref:item.ref,role:item.pair.role,period:item.period,model:r.model??null,effort:r.effort??null,timeoutMs:r.timeoutMs??null,schemaCharacters:schema?.length??null,schemaHash:schema?createHash('sha256').update(schema).digest('hex'):null});
 }
}));
const mean=xs=>xs.reduce((n,x)=>n+x,0)/xs.length,change=(a,b)=>a?b/a-1:null;
for(const [role,group]of Object.entries(stats.matched)){
 const before=group.before,after=group.after,b=requestChecks.filter(r=>r.role===role&&r.period==='before'),a=requestChecks.filter(r=>r.role===role&&r.period==='after');
 assert.equal(b.length,before.calls);assert.equal(a.length,after.calls);
 const distribution=(xs,key)=>xs.reduce((o,x)=>(o[String(x[key])]=(o[String(x[key])]??0)+1,o),{});
 const p={role,nBefore:before.calls,nAfter:after.calls,charactersChange:change(before.characters.mean,after.characters.mean),inputTokensChange:change(before.inputTokens.mean,after.inputTokens.mean),latencyChange:change(before.providerMs.mean,after.providerMs.mean),cacheRateBefore:before.cache.hitRatio,cacheRateAfter:after.cache.hitRatio,
  beforeSchemaCharacters:mean(b.map(r=>r.schemaCharacters??0)),afterSchemaCharacters:mean(a.map(r=>r.schemaCharacters??0)),effortBefore:distribution(b,'effort'),effortAfter:distribution(a,'effort'),publishedBefore:before.statuses.completed??0,publishedAfter:after.statuses.completed??0,validationFailuresBefore:before.statuses.failed??0,validationFailuresAfter:after.statuses.failed??0,
  inputPerPublishedBefore:before.inputTokens.mean*before.inputTokens.n/(before.statuses.completed??1),inputPerPublishedAfter:after.inputTokens.mean*after.inputTokens.n/(after.statuses.completed??1)};
 pairChecks.push(p);
}
const failures=capture.calls.filter(c=>c.cohort==='deployed'&&c.processingStatus==='failed').map(c=>({seat:c.seat,ref:c.callRef,kind:c.kind,tick:c.tick,reason:c.validationError??c.error??c.toolError}));
const report={verifiedAt:new Date().toISOString(),passed:true,promptHashesVerified:capture.calls.length,matchedRequestsVerified:requestChecks.length,periods:pairChecks,requestChecks,failures};
await writeFile(join(out,'verification-and-controls.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:true,prompts:capture.calls.length,matchedRequests:requestChecks.length,periods:pairChecks,failures}));
