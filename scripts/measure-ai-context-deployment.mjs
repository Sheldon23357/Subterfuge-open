import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {consoleApi,game} from '../outputs/context-projection-apply-20261030/manage.mjs';
import {readPromptMaterial,readPromptSections} from '../dist/packages/contracts/src/index.js';
const out=resolve(process.argv[2]??'outputs/context-projection-stats-20261030-1321');
await mkdir(out,{recursive:false});await mkdir(join(out,'prompts'));
const cutoff=JSON.parse(await readFile('outputs/context-projection-apply-20261030/restored.json','utf8')).at;
const api=await consoleApi(),status=await api('/api/agent/status'),bound=status.seats.filter(s=>s.bound),startedAt=new Date().toISOString(),calls=[],skipped=[];
const content=async(id,generation,ref,kind)=>{
 let text='',offset=0,truncated=false;
 do{const p=await api('/api/agent/debug/content?seat='+id+'&generation='+encodeURIComponent(generation)+'&ref='+ref+'&kind='+kind+'&offset='+offset+'&limit=32768');if(p.generation!==generation||!p.available)throw Error('Unavailable or changed content');text+=p.text??'';truncated||=p.truncated;offset=p.nextOffset;}while(offset!==null);
 return {text,truncated};
};
await Promise.all(bound.map(async seat=>{
 let before,generation,entries=[];
 for(let page=0;page<3;page++){
  const p=await api('/api/agent/debug/calls?seat='+seat.id+'&limit=50'+(before?'&before='+before:''));
  if(generation&&p.generation!==generation)throw Error('Diagnostic generation changed');generation=p.generation;
  entries.push(...p.entries);if(p.nextCursor===null)break;before=p.nextCursor;
 }
 await writeFile(join(out,seat.id+'-call-metadata.json'),JSON.stringify({generation,entries},null,2));
 for(const entry of entries){
  if(entry.lane!=='hybrid'||!entry.sentAt||!entry.finishedAt){skipped.push({seat:seat.id,ref:entry.callRef,reason:'not-finished-sent-hybrid',outcome:entry.outcome});continue;}
  const p=await content(seat.id,generation,entry.callRef,'prompt');
  if(p.truncated){skipped.push({seat:seat.id,ref:entry.callRef,reason:'truncated'});continue;}
  let m;try{m=readPromptMaterial(p.text);}catch{skipped.push({seat:seat.id,ref:entry.callRef,reason:'unparseable-layout'});continue;}
  if(!m?.global||!m?.guidance||!m?.facts){skipped.push({seat:seat.id,ref:entry.callRef,reason:'other-layout'});continue;}
  const current=!!m.guidance.serverAgreements?.current&&!!m.global.identities?.columns;
  const cohort=current?(entry.sentAt>=cutoff?'deployed':'early-projected'):'legacy';
  const sections=readPromptSections(p.text),selected=['global','guidance','facts'];
  const bodies=Object.fromEntries(selected.map(k=>[k,sections?.find(s=>s.id==='brief.'+k)?.text.length??JSON.stringify({[k]:m[k]}).length]));
  const receipts=m.guidance.contractResults,receiptRows=Array.isArray(receipts)?receipts.length:receipts?.rows?.length??0;
  const id=seat.id+'-'+entry.callRef,file='prompts/'+id+'.txt';await writeFile(join(out,file),p.text);
  calls.push({...entry,seat:seat.id,kind:m.kind,scope:m.scope,tick:m.basis?.tick,cohort,file,sha256:createHash('sha256').update(p.text).digest('hex'),capturedCharacters:p.text.length,bodies,selectedBody:Object.values(bodies).reduce((a,b)=>a+b,0),receiptRows,newReceipts:m.guidance.receiptCoverage?.new??null,receiptCoverage:m.guidance.receiptCoverage??null});
 }
}));
calls.sort((a,b)=>a.sentAt.localeCompare(b.sentAt));
const gameState=await game('/api/state');
await writeFile(join(out,'captured.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),cutoff,roomId:gameState.commanderRoomId,currentTick:gameState.tick,status:status.seats.map(({id,bound,enabled,error})=>({id,bound,enabled,error})),calls,skipped},null,2));
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const distribution=xs=>{const v=xs.filter(x=>typeof x==='number'&&Number.isFinite(x)).sort((a,b)=>a-b);return {n:v.length,mean:mean(v),median:v.length?(v[Math.floor((v.length-1)/2)]+v[Math.ceil((v.length-1)/2)])/2:null,p90:v.length?v[Math.ceil(v.length*.9)-1]:null,min:v[0]??null,max:v.at(-1)??null};};
function stats(list){
 const cache=list.filter(c=>c.usage?.inputTokens!==null&&c.usage?.cachedInputTokens!==null),sum=(rows,key)=>rows.reduce((n,r)=>n+(r.usage?.[key]??0),0);
 return {calls:list.length,ticks:[Math.min(...list.map(c=>c.tick)),Math.max(...list.map(c=>c.tick))],sent:[list[0]?.sentAt,list.at(-1)?.sentAt],models:[...new Set(list.map(c=>c.model))],characters:distribution(list.map(c=>c.promptCharacters)),selectedBody:distribution(list.map(c=>c.selectedBody)),sections:Object.fromEntries(['global','guidance','facts'].map(k=>[k,distribution(list.map(c=>c.bodies[k]))])),inputTokens:distribution(list.map(c=>c.usage?.inputTokens)),outputTokens:distribution(list.map(c=>c.usage?.outputTokens)),providerMs:distribution(list.map(c=>c.providerDurationMs)),queueMs:distribution(list.map(c=>c.queueWaitMs)),receiptRows:distribution(list.map(c=>c.receiptRows)),cache:{reportedCalls:cache.length,inputTokens:sum(cache,'inputTokens'),cachedTokens:sum(cache,'cachedInputTokens'),hitRatio:sum(cache,'inputTokens')?sum(cache,'cachedInputTokens')/sum(cache,'inputTokens'):null,uncachedInput:distribution(cache.map(c=>c.usage.inputTokens-c.usage.cachedInputTokens))},statuses:list.reduce((o,c)=>(o[c.processingStatus]=(o[c.processingStatus]??0)+1,o),{}),outcomes:list.reduce((o,c)=>(o[c.outcome]=(o[c.outcome]??0)+1,o),{})};
}
const groups={};for(const cohort of ['legacy','early-projected','deployed'])for(const role of ['strategy','diplomacy']){const xs=calls.filter(c=>c.cohort===cohort&&c.kind===role&&c.outcome==='completed');if(xs.length)groups[cohort+':'+role]=stats(xs);}
const matched={},pairs=[];
for(const role of ['strategy','diplomacy']){
 const legacy=[],deployed=[];
 for(const seat of bound){
  const after=calls.filter(c=>c.seat===seat.id&&c.kind===role&&c.cohort==='deployed'&&c.outcome==='completed');
  for(const model of new Set(after.map(c=>c.model))){
   const b=calls.filter(c=>c.seat===seat.id&&c.kind===role&&c.model===model&&c.cohort==='legacy'&&c.outcome==='completed'),a=after.filter(c=>c.model===model),n=Math.min(15,a.length,b.length);
   if(!n)continue;const before=b.slice(-n),post=a.slice(-n);legacy.push(...before);deployed.push(...post);pairs.push({seat:seat.id,role,model,n,before:before.map(c=>c.callRef),after:post.map(c=>c.callRef)});
  }
 }
 if(legacy.length){legacy.sort((a,b)=>a.sentAt.localeCompare(b.sentAt));deployed.sort((a,b)=>a.sentAt.localeCompare(b.sentAt));matched[role]={before:stats(legacy),after:stats(deployed)};}
}
await writeFile(join(out,'statistics.json'),JSON.stringify({startedAt,cutoff,currentTick:gameState.tick,sampleCount:calls.length,skipped:skipped.length,groups,matched,pairs,limitations:['Observational before/after; different game ticks and legitimate fact volumes.','Groups are classified by actual model-view structure, not deployment timestamp alone.','Official post-deployment group requires sentAt at or after the saved restored timestamp.','Matched cohorts balance counts within seat, role and exact model; reasoning effort and schema are checked separately below.','Provider-completed calls include superseded or validation-rejected results because they still consume input tokens.','Cached-input unknowns are excluded, never silently treated as zero.']},null,2));
console.log(JSON.stringify({out,sampleCount:calls.length,skipped:skipped.length,groups:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,{n:v.calls,ticks:v.ticks,chars:v.characters.mean,input:v.inputTokens.mean,ms:v.providerMs.mean,receipts:v.receiptRows.mean}])),matched:Object.fromEntries(Object.entries(matched).map(([k,v])=>[k,{before:{n:v.before.calls,chars:v.before.characters.mean,input:v.before.inputTokens.mean,ms:v.before.providerMs.mean,cache:v.before.cache.hitRatio},after:{n:v.after.calls,chars:v.after.characters.mean,input:v.after.inputTokens.mean,ms:v.after.providerMs.mean,cache:v.after.cache.hitRatio}}]))}));
