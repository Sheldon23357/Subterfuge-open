// Read-only runtime accounting. Journal cursors, not wall-clock guesses, bound each period.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const labels={opening:'开局',recovery:'恢复与查账','mining-phase-change':'矿业阶段变化','reminder-due':'提醒到期','campaign-review':'后台指导或战略复查','attack-premise-change':'进攻前提变化','outpost-control-change':'据点归属变化','fleet-state-change':'舰队状态变化','investment-opportunity':'经济建设机会','construction-change':'设施建设变化','threat-change':'来袭与威胁变化','battle-notice':'战斗通知','activity-warning':'活跃警告','commander-instructions':'指挥官新要求',unknown:'未记录原因'};
const strategic={initial:'开局或恢复后的战略初审','critical-change':'关键局势变化','coalesced-change':'普通变化合并复查',periodic:'定期战略巡检'};
const pressure={'defense-pressure':'防守压力外交','attack-stalled':'进攻受阻外交','opening-contest':'开局争夺外交',stalemate:'僵局外交'};
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
const records=value=>Array.isArray(value)?value:(value?.rows??[]).map(row=>Object.fromEntries(value.columns.map((key,index)=>[key,row[index]])));

export function triggerTable(operations){
 const rows=new Map();
 for(const operation of operations){
  const reasons=[...new Set(operation.causes?.length?operation.causes:['未记录原因'])];
  for(const reason of reasons){const row=rows.get(reason)??{reason,operations:0,weightedOperations:0};row.operations++;row.weightedOperations+=1/reasons.length;rows.set(reason,row);}
 }
 return [...rows.values()].map(r=>({...r,coveragePercent:100*r.operations/operations.length,sharePercent:100*r.weightedOperations/operations.length})).sort((a,b)=>b.weightedOperations-a.weightedOperations||a.reason.localeCompare(b.reason));
}

function gameState(port){
 return new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port,path:'/api/state',agent:new http.Agent({proxyEnv:{}})},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>{try{if(res.statusCode!==200)throw Error('Game HTTP '+res.statusCode);resolve(JSON.parse(raw));}catch(e){reject(e);}});});req.setTimeout(10000,()=>req.destroy(Error('Game read timed out')));req.on('error',reject);});
}

function readSeat(file,room,seat,before){
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  db.exec('BEGIN');
  const head=db.prepare('SELECT coalesce(max(id),0) id FROM journal WHERE room=? AND seat=?').get(room,seat).id;
  const first=before===undefined;
  if(first)before=db.prepare("SELECT coalesce(max(id),0) id FROM journal WHERE room=? AND seat=? AND kind='agent-started'").get(room,seat).id;
  if(before>head)throw Error('Journal rewound; establish a new report segment explicitly.');
  let initialBoundary;
  if(first){
   const marker=db.prepare("SELECT payload FROM journal WHERE room=? AND seat=? AND id>? AND id<=? AND kind IN ('started','mode-hybrid-model-call') AND coalesce(json_extract(payload,'$.tick'),json_extract(payload,'$.basis.tick')) IS NOT NULL ORDER BY id LIMIT 1").get(room,seat,before,head);
   const timestamp=db.prepare("SELECT json_extract(payload,'$.queuedAt') at FROM journal WHERE room=? AND seat=? AND id>? AND id<=? AND kind='mode-hybrid-model-call' ORDER BY id LIMIT 1").get(room,seat,before,head);
   if(!marker||!timestamp?.at)throw Error('No recorded first-period tick/time boundary; save an explicit baseline before reporting.');
   const payload=parse(marker.payload);initialBoundary={tick:payload.tick??payload.basis.tick,at:timestamp.at};
  }
  const rows=db.prepare('SELECT id,kind,payload FROM journal WHERE room=? AND seat=? AND id>? AND id<=? ORDER BY id').all(room,seat,before,head);
  // Large observation/state bodies are not needed for counting or exported to the report.
  const wanted=new Set(['started','bot-compute-started','bot-compute-completed','tactical-search-completed','mode-hybrid-search','mode-hybrid-validation','mode-hybrid-search-failed','mode-hybrid-validation-failed','mode-hybrid-task-dispatched','mode-hybrid-model-call','provider-request-sent']);
  const events=rows.filter(r=>wanted.has(r.kind)).map(r=>({...r,payload:parse(r.payload)}));
  const latest=(kind,id)=>{const r=db.prepare('SELECT payload FROM journal WHERE room=? AND seat=? AND kind=? AND id<=? ORDER BY id DESC LIMIT 1').get(room,seat,kind,id);return r?parse(r.payload):null;};
  const roundFor=sequence=>{const r=db.prepare("SELECT payload FROM journal WHERE room=? AND seat=? AND kind='started' AND id<=? AND json_extract(payload,'$.sequence')=? ORDER BY id DESC LIMIT 1").get(room,seat,head,sequence);return r?parse(r.payload):null;};
  const roundCauses=sequence=>[...new Set((roundFor(sequence)?.triggers??[]).map(t=>labels[t.kind]??t.kind))];
  const decisions=events.filter(e=>e.kind==='started').map(e=>({journalId:e.id,sequence:e.payload.sequence,causes:roundCauses(e.payload.sequence)}));
  const searches=[];
  for(const e of events){
   if(e.kind==='tactical-search-completed'){
    const r=db.prepare("SELECT payload FROM journal WHERE room=? AND seat=? AND kind IN ('mode-hybrid-search','mode-hybrid-decision') AND id<? AND json_extract(payload,'$.sequence')=? ORDER BY id DESC LIMIT 1").get(room,seat,e.id,e.payload.sequence);
    const decision=r?parse(r.payload).decision:null;
    searches.push({journalId:e.id,sequence:e.payload.sequence,type:'完整搜索',simulations:decision?.coverage?.simulations??null,causes:roundCauses(e.payload.sequence)});
   }else if(e.kind==='mode-hybrid-validation')searches.push({journalId:e.id,sequence:e.payload.sequence,type:'定向复核',simulations:e.payload.decision?.coverage?.simulations??null,causes:roundCauses(e.payload.sequence)});
  }
  const callEnds=new Map(events.filter(e=>e.kind==='mode-hybrid-model-call').map(e=>[e.payload.callId,e.payload]));
  const requests=[];
  for(const e of events.filter(e=>e.kind==='mode-hybrid-task-dispatched')){
   const d=e.payload;
   const r=db.prepare("SELECT id,payload FROM journal WHERE room=? AND seat=? AND kind='mode-hybrid-model-call' AND id<? AND json_extract(payload,'$.sequence')=? AND json_extract(payload,'$.task')=? AND json_extract(payload,'$.attempt')=? ORDER BY id DESC LIMIT 1").get(room,seat,e.id,d.sequence,d.id,d.attempt);
   if(!r){requests.push({journalId:e.id,role:'未关联',causes:['未记录原因'],outcome:'未关联'});continue;}
   const call=parse(r.payload),last=callEnds.get(call.callId)??call;
   let brief;try{brief=JSON.parse(call.prompt.split('\n简报：')[1]);}catch{}
   let causes=[];
   if(brief?.facts?.validationError)causes=['格式或业务校验重试'];
   else if(brief?.facts?.requestedInformation?.length)causes=['补充资料'];
   else if(call.attempt>0)causes=['供应商或其他重试'];
   else if(call.kind==='commander')causes=['指挥官新要求'];
   else if(call.kind==='strategy'){
    const trigger=latest('mode-hybrid-strategy-trigger',r.id);
    causes=[call.task==='coordination'?'战略约束冲突协调':strategic[trigger?.reason]??'未记录战略原因'];
   }else if(call.kind==='diplomacy'){
    const saved=latest('mode-hybrid-state',r.id),self=records(brief?.global?.roster).find(p=>p.gamePlayer===seat)?.chatPlayer;
    const messages=brief?.evidence?.messages??[],handled=new Set(saved?.handledMessages??[]),purpose=brief?.guidance?.diplomacyPurpose;
    if(self===undefined)causes=['未记录会话身份'];
    else if(messages.some(m=>m.from!==self&&!handled.has(m.id)))causes=['收到新来信'];
    else if(purpose?.role==='repair-fulfillment')causes=['外交履约受阻修复'];
    else if(purpose?.needs?.length)causes=purpose.needs.map(n=>pressure[n.kind]??n.kind);
    else causes=['定期主动联络'];
   }
   requests.push({journalId:e.id,callId:call.callId,role:call.kind,task:call.task,causes,outcome:last.finishedAt?last.status:'进行中',tokens:last.tokens??null});
  }
  for(const e of events.filter(e=>e.kind==='provider-request-sent'&&e.payload.lane==='commander'))requests.push({journalId:e.id,role:'commander-discussion',causes:['指挥官交互：'+(e.payload.mode??'未记录模式')],outcome:'按派发计数'});
  const counts={decisionRounds:decisions.length,localComputeStarted:events.filter(e=>e.kind==='bot-compute-started').length,localComputeCompleted:events.filter(e=>e.kind==='bot-compute-completed').length,searches:searches.length,fullSearches:searches.filter(s=>s.type==='完整搜索').length,validations:searches.filter(s=>s.type==='定向复核').length,searchFailures:events.filter(e=>['mode-hybrid-search-failed','mode-hybrid-validation-failed'].includes(e.kind)).length,simulations:searches.reduce((n,s)=>n+(s.simulations??0),0),searchesWithUnknownSimulationCount:searches.filter(s=>s.simulations===null).length,aiRequests:requests.length,aiNewQueued:new Set(events.filter(e=>e.kind==='mode-hybrid-model-call'&&!e.payload.finishedAt).map(e=>e.payload.callId)).size};
  db.exec('COMMIT');
  return {seat:seat+1,id:'ai-'+String(seat+1).padStart(2,'0'),cursor:{file:path.basename(file),before,head},counts,decisions,searches,requests,first,initialBoundary};
 }finally{db.close();}
}

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function html(report){
 const table=(heads,rows)=>`<table><thead><tr>${heads.map(h=>'<th>'+escape(h)+'</th>').join('')}</tr></thead><tbody>${rows.map(r=>'<tr>'+r.map(v=>'<td>'+escape(v)+'</td>').join('')+'</tr>').join('')}</tbody></table>`;
 const causes=(title,rows)=>`<h2>${title}</h2>`+table(['触发原因','涉及操作数','覆盖率','均摊占比'],rows.map(r=>[r.reason,r.operations,r.coveragePercent.toFixed(1)+'%',r.sharePercent.toFixed(1)+'%']));
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Bot 周期报表</title><style>body{font:15px system-ui;margin:36px auto;max-width:1080px;padding:0 24px;color:#18232d;background:#f6f8fa}h1{font-size:28px}h2{font-size:20px;margin-top:32px}table{border-collapse:collapse;width:100%;background:white}th,td{padding:10px 14px;border-bottom:1px solid #dce3e9;text-align:right}th:first-child,td:first-child{text-align:left}p{line-height:1.7;color:#52616d}.metrics{font-size:20px;padding:16px;background:#e3edf5}</style><h1>Bot 周期报表</h1><p>${escape(report.startAt)} → ${escape(report.endAt)}<br>房间 ${escape(report.roomId)} · ${escape(report.baseline)}</p><div class="metrics">tick ${report.startTick} → ${report.endTick}：推进 ${report.ticksAdvanced} tick · 搜索/复核完成 ${report.totals.searches} 次 · AI 实际派发 ${report.totals.aiRequests} 次</div><h2>各 Bot 运行量</h2>${table(['Bot','决策轮次','完整搜索','定向复核','条件仿真请求','AI 派发','新入队请求'],report.seats.map(s=>[s.id,s.counts.decisionRounds,s.counts.fullSearches,s.counts.validations,s.counts.simulations,s.counts.aiRequests,s.counts.aiNewQueued]))}${causes('前台决策触发原因',report.triggers.decisions)}${causes('搜索/复核触发原因（按所属决策轮）',report.triggers.searches)}${causes('AI 请求直接触发原因',report.triggers.aiRequests)}<h2>AI 职责</h2>${table(['职责','派发数','占比'],report.roles.map(r=>[r.reason,r.operations,r.sharePercent.toFixed(1)+'%']))}<p>${report.notes.map(escape).join('<br>')}</p></html>`;
}

export async function reportCycle(directory,port=4310){
 directory=path.resolve(directory);
 const output=path.join(directory,'cycle-reports');fs.mkdirSync(output,{recursive:true});
 const stateFile=path.join(output,'cursor.json'),previous=read(stateFile);
 const samplingStartedAt=new Date().toISOString(),game=await gameState(port),room=game.commanderRoomId;
 if(previous&&previous.roomId!==room)throw Error('Room changed; preserve this report segment and initialize a separate cursor.');
 const bindings=read(path.join(directory,'controller-bindings.json'));
 if(bindings?.roomId!==room)throw Error('Bindings do not match active room.');
 const files=fs.readdirSync(path.join(directory,'independent-agent')).filter(f=>/^[a-f0-9]{64}\.sqlite$/.test(f));
 const seats=[];
 for(const binding of bindings.bindings){
  let source;
  for(const file of files){const candidate=path.join(directory,'independent-agent',file),db=new DatabaseSync(candidate,{readOnly:true});try{if(db.prepare('SELECT 1 FROM seats WHERE room=? AND seat=?').get(room,binding.seat)){source=candidate;break;}}finally{db.close();}}
  if(!source)throw Error('Missing private store for seat '+binding.seat);
  const cursor=previous?.seats?.[String(binding.seat)];
  if(cursor&&cursor.file!==path.basename(source))throw Error('Seat store changed; cannot reuse its cursor.');
  seats.push({...readSeat(source,room,binding.seat,cursor?.head),id:'ai-'+String(binding.slot+1).padStart(2,'0')});
 }
 if(!previous&&new Set(seats.map(s=>s.initialBoundary.tick)).size!==1)throw Error('Seat startup ticks differ; establish a common report baseline explicitly.');
 const startTick=previous?.endTick??seats[0].initialBoundary.tick;
 if(game.tick<startTick)throw Error('Game timeline rewound; do not report a negative period.');
 const totals=Object.fromEntries(Object.keys(seats[0].counts).map(key=>[key,seats.reduce((n,s)=>n+s.counts[key],0)]));
 const decisions=seats.flatMap(s=>s.decisions),searches=seats.flatMap(s=>s.searches),requests=seats.flatMap(s=>s.requests);
 const report={format:'bot-cycle-report/1',roomId:room,startAt:previous?.endAt??seats.map(s=>s.initialBoundary.at).sort()[0],endAt:new Date().toISOString(),samplingStartedAt,startTick,endTick:game.tick,ticksAdvanced:game.tick-startTick,baseline:previous?'相邻报表的日志游标差分':'首次报表：最近启动日志的共同起始tick，时间取首个模型入队记录',totals,seats,triggers:{decisions:triggerTable(decisions),searches:triggerTable(searches),aiRequests:triggerTable(requests)},roles:triggerTable(requests.map(r=>({causes:[r.role]}))),notes:['一次操作有多种原因时，各原因记一次覆盖，均摊一次操作的权重；均摊占比合计100%，覆盖率可合计超过100%。','搜索按实际新搜索完成标记和定向复核完成记录计数；同轮缓存复用不重复算完整搜索。失败单列，轮询与仿真不当作搜索。','条件仿真请求可能命中缓存，不等同CPU计算次数；AI请求按真实派发事件计数，排队未发不算实际请求。','搜索触发关联其原始决策轮；AI补查/重试单列，不能与战略/外交职责比例混为一谈。','各库在独立只读事务中截取游标；采样不是暂停世界的一致检查点。跨周期进行中的操作按完成或派发事件归属，不按推测时间回填。']};
 const stamp=report.endAt.replace(/[^0-9]/g,''),jsonFile=path.join(output,stamp+'.json'),htmlFile=path.join(output,stamp+'.html');
 const raw=JSON.stringify(report,null,2);fs.writeFileSync(jsonFile,raw);fs.writeFileSync(htmlFile,html(report));fs.writeFileSync(path.join(output,'latest.json'),raw);fs.writeFileSync(path.join(output,'latest.html'),html(report));
 fs.writeFileSync(stateFile+'.tmp',JSON.stringify({roomId:room,endAt:report.endAt,endTick:report.endTick,seats:Object.fromEntries(seats.map(s=>[String(s.seat-1),s.cursor]))},null,2));fs.renameSync(stateFile+'.tmp',stateFile);
 return {jsonFile,htmlFile,report};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2),directory=args[args.indexOf('--directory')+1];
 if(!args.includes('--directory')||!directory)throw Error('Use --directory RUNTIME_PATH [--game-port PORT]');
 const port=args.includes('--game-port')?Number(args[args.indexOf('--game-port')+1]):4310;
 const {jsonFile,htmlFile,report}=await reportCycle(directory,port);
 console.log(JSON.stringify({jsonFile,htmlFile,startTick:report.startTick,endTick:report.endTick,ticksAdvanced:report.ticksAdvanced,totals:report.totals,triggers:report.triggers,roles:report.roles},null,2));
}
