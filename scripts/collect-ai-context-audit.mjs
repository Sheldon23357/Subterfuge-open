import http from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {readPromptSections,readPromptMaterial} from '../dist/packages/contracts/src/index.js';

const out=resolve(process.argv[2]??'outputs/ai-context-audit-20261030');
const limit=Number(process.argv[3]??30),port=4400;
if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid sample limit');
try{await readFile(join(out,'capture.json'));throw Error('Capture exists; use another output directory');}catch(e){if(e.code!=='ENOENT')throw e;}
const agent=new http.Agent({proxyEnv:{},keepAlive:true});
function get(path,headers={}){return new Promise((resolveGet,reject)=>{
 const request=http.get({hostname:'127.0.0.1',port,path,agent,headers:{Origin:`http://127.0.0.1:${port}`,...headers},timeout:20000},response=>{
  let text='';response.on('data',chunk=>{text+=chunk;if(text.length>8_388_608)response.destroy(Error('Response limit'));});
  response.on('error',reject);response.on('end',()=>{if(response.statusCode!==200)return reject(Error(`HTTP ${response.statusCode}`));resolveGet({text,headers:response.headers});});
 });request.on('error',reject);request.on('timeout',()=>request.destroy(Error('Read timeout')));
});}
const home=await get('/'),cookie=home.headers['set-cookie']?.map(v=>v.split(';')[0]).join('; ');
if(!cookie)throw Error('Missing session');
const bootstrap=JSON.parse((await get('/api/agent/bootstrap',{Cookie:cookie,'X-Agent-Console':'1'})).text);
const headers={Cookie:cookie,'X-Agent-CSRF':bootstrap.csrf};
const api=async path=>JSON.parse((await get('/api/agent/'+path,headers)).text);
const status=await api('status'),seats=status.seats.filter(s=>s.bound);
await mkdir(join(out,'captures'),{recursive:true});
const startedAt=new Date().toISOString(),samples=[],skipped=[];
await Promise.all(seats.map(async seat=>{
 const page=await api(`debug/calls?seat=${encodeURIComponent(seat.id)}&limit=${limit}`);
 for(const call of page.entries){
  const key=`${seat.id}-${call.callRef}`;
  if(call.lane!=='hybrid'||call.outcome!=='completed'){skipped.push({key,reason:'not-completed-hybrid',lane:call.lane,outcome:call.outcome});continue;}
  let offset=0,text='',truncated=false;
  do{
   const content=await api(`debug/content?seat=${encodeURIComponent(seat.id)}&generation=${encodeURIComponent(page.generation)}&ref=${call.callRef}&kind=prompt&offset=${offset}&limit=32768`);
   if(content.generation!==page.generation)throw Error('Capture generation changed');
   if(!content.available)throw Error('Content unavailable for '+key);
   text+=content.text??'';truncated ||= content.truncated;offset=content.nextOffset;
  }while(offset!==null);
  const sections=readPromptSections(text);
  if(truncated||!sections||!['brief.global','brief.guidance','brief.facts'].every(id=>sections.some(s=>s.id===id))){skipped.push({key,reason:truncated?'truncated':'unmarked-or-other-layout',characters:text.length});continue;}
  const material=readPromptMaterial(text),file=`captures/${key}.txt`;
  await writeFile(join(out,file),text,'utf8');
  samples.push({key,seat:seat.id,callRef:call.callRef,generation:page.generation,roomId:seat.roomId,kind:material.kind,scope:material.scope,tick:material.basis?.tick,task:call.task,model:call.model,processingStatus:call.processingStatus,queuedAt:call.startedAt,sentAt:call.sentAt,finishedAt:call.finishedAt,usage:call.usage,characters:text.length,sha256:createHash('sha256').update(text).digest('hex'),file,sections:sections.map(({id,label,start,bodyStart,bodyEnd,end})=>({id,label,start,bodyStart,bodyEnd,end}))});
 }
}));
samples.sort((a,b)=>a.seat.localeCompare(b.seat)||b.callRef-a.callRef);
const report={startedAt,finishedAt:new Date().toISOString(),limitPerSeat:limit,seats:seats.map(({id,roomId,lobbySeat,gamePlayer,chatPlayer})=>({id,roomId,lobbySeat,gamePlayer,chatPlayer})),samples,skipped};
await writeFile(join(out,'capture.json'),JSON.stringify(report,null,2));
agent.destroy();
console.log(JSON.stringify({out,samples:samples.length,skipped:skipped.length,kinds:Object.fromEntries([...new Set(samples.map(s=>s.kind))].map(kind=>[kind,samples.filter(s=>s.kind===kind).length])),tickRange:[Math.min(...samples.map(s=>s.tick)),Math.max(...samples.map(s=>s.tick))]}));
