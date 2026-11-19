import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdir,writeFile,rename,open,unlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {codexArguments} from '../dist/packages/ai/src/application/providers/codex.js';

// This process has no game transport, credentials, control lease, or writeable
// connection to a game/agent database. Its sole model output is a local proposal.
export const strategySchema={type:'object',additionalProperties:false,required:['summary','actions','reasons','risks','checks'],properties:{
 summary:{type:'string'},actions:{type:'array',items:{type:'object',additionalProperties:false,required:['actionJson','purpose'],properties:{actionJson:{type:'string'},purpose:{type:'string'}}}},
 reasons:{type:'array',items:{type:'string'}},risks:{type:'array',items:{type:'string'}},checks:{type:'array',items:{type:'string'}}}};
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function json(path){return JSON.parse(await readFile(path,'utf8'));}
async function atomic(path,value){await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(value,null,2));await rename(path+'.tmp',path);}
export function capture(db,room,seat,row){
 const payload=JSON.parse(row.payload),decision=payload.decision;
 // Require the exact observation version, never substitute today's live map.
 const wake=db.prepare("SELECT id,payload FROM journal WHERE room=? AND seat=? AND kind='wake-state' AND id<? AND json_extract(payload,'$.observed.revision')=? ORDER BY id DESC LIMIT 1").get(room,seat,row.id,decision.basisRevision);
 if(!wake)throw Error('Exact authorized observation version is unavailable');
 const w=JSON.parse(wake.payload),observation=w.observed;
 if(observation.roomId!==room||observation.view.player!==seat||observation.revision!==decision.basisRevision)throw Error('Input identity mismatch');
 const note=db.prepare("SELECT id,kind,payload FROM journal WHERE room=? AND seat=? AND kind IN ('notebook-set','notebook-removed') AND json_extract(payload,'$.id')='bot-plan' AND id<? ORDER BY id DESC LIMIT 1").get(room,seat,row.id);
 let previousBotPlan=null;
 if(note?.kind==='notebook-set'){
  const n=JSON.parse(note.payload);
  if(n.expiresAt===null||n.expiresAt===undefined||n.expiresAt>observation.view.tick*600)previousBotPlan=JSON.parse(n.text);
 }
 const round=db.prepare("SELECT payload FROM journal WHERE room=? AND seat=? AND kind='started' AND json_extract(payload,'$.sequence')=? AND id<? ORDER BY id DESC LIMIT 1").get(room,seat,payload.sequence,row.id);
 const input={format:'bot-sol-shadow-input/1',roomId:room,seat,sequence:payload.sequence,tick:decision.observedTick,basisRevision:decision.basisRevision,
  observation,previousBotPlan,triggers:round?JSON.parse(round.payload):null,botParameters:decision.parameters,
  provenance:{decisionJournalId:row.id,observationJournalId:wake.id,previousPlanJournalId:note?.id??null,exactObservation:true,
   scope:'Authorized observation, persisted previous bot plan, round triggers and planner parameters. Not a byte-for-byte capture of botStep snapshot, routes, local reminders, execution ledger, or same-round feedback; omitted inputs are not fabricated.'}};
 return {input,bot:{format:'bot-sol-shadow-bot/1',sequence:payload.sequence,decision}};
}
export function makePrompt(input){return `你是潜艇策略游戏的离线对照分析员。用中文为这一历史授权局面制定一轮执行策略。你没有游戏接口，绝不能尝试读取外部文件、调用工具、发送消息或执行操作。仅根据下方上下文输出规定JSON。对照模型看不到程序bot本轮选择。已知状态、既有舰队、已接受操作与上轮计划不等于预测；不能因舰队消失断言抵达或毁灭。谨慎评估兵量、航程、来源守备、矿点安全、开矿和已有行动；资料缺失就写入checks/risks，不编造预测胜率或战果。可以选择不行动。actions是建议，未经过游戏执行或推演校验；actionJson使用当前上下文中的据点ID/名字，内容是单个游戏action对象的JSON字符串，仅建议当前立即操作，未来行动在后续局势更新时重新判断。不要把程序bot推演候选、目标或本轮决定当作已知输入。下方保存的是原版本授权观察与可核实的前轮计划；provenance明确列出未完整记录的输入。一次性制定可审阅策略，不请求进一步工具查询。\n${JSON.stringify(input)}`;}
export function compareActions(bot,sol){
 const native=bot.decision.selected.drafts.map(d=>({action:d.action}));
 const proposed=sol.actions.map(x=>({action:JSON.parse(x.actionJson),purpose:x.purpose}));
 for(const x of proposed)if(!x.action||typeof x.action!=='object'||Array.isArray(x.action)||typeof x.action.kind!=='string')throw Error('Invalid proposed action object');
 const count=rows=>rows.reduce((out,x)=>(out[x.action.kind]=(out[x.action.kind]??0)+1,out),{});
 return {format:'bot-sol-strategy-comparison/1',bot:{objective:bot.decision.selected.objective,actions:native,actionTypes:count(native)},sol:{...sol,parsedActions:proposed,actionTypes:count(proposed)},
  validation:'Side-by-side proposals only. Sol has no tool loop or independent forecasts. No game commands executed; no claim of strategic superiority or simulated success.'};
}
async function runSol(directory,input,options){
 await writeFile(join(directory,'response-schema.json'),JSON.stringify(strategySchema));
 const prompt=makePrompt(input);await writeFile(join(directory,'sol-prompt.txt'),prompt);
 if(prompt.length>200000)throw Error('Shadow input exceeds 200000 characters; no model request sent');
 const startedAt=Date.now(),args=codexArguments(directory,options.model,options.effort,'fast');
 // Persist intent first. A daemon crash after this boundary is not auto-retried.
 await atomic(join(directory,'status.json'),{status:'calling',startedAt:new Date(startedAt).toISOString(),model:options.model,effort:options.effort,serviceTier:'fast'});
 const stdout=await new Promise((done,fail)=>{
  const child=spawn('codex',args,{cwd:directory,windowsHide:true,stdio:['pipe','pipe','ignore'],shell:false});
  child.stdout.setEncoding('utf8');
  let output='',bytes=0,stopped=false;
  const stop=reason=>{if(stopped)return;stopped=true;if(process.platform==='win32'&&child.pid){const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else child.kill('SIGKILL');fail(Error(reason));};
  const timeout=setTimeout(()=>stop('Shadow model timeout; outcome unknown; no automatic retry'),options.timeoutMs);
  child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>2097152)stop('Shadow output exceeds 2 MiB');else output+=chunk;});
  child.on('error',e=>{clearTimeout(timeout);fail(e);});child.on('close',code=>{clearTimeout(timeout);if(!stopped)code===0?done(output):fail(Error('Shadow Codex exited '+code));});
  child.stdin.on('error',()=>{});child.stdin.end(prompt);
 });
 await writeFile(join(directory,'sol-events.jsonl'),stdout);
 let text,usage;for(const line of stdout.split(/\r?\n/).filter(Boolean)){
  const e=JSON.parse(line);
  if(e.type==='error'||e.type==='turn.failed')throw Error('Shadow Codex turn failed; see saved events');
  if(e.type==='item.completed'){
   if(e.item?.type==='agent_message')text=e.item.text;
   else if(['command_execution','mcp_tool_call','web_search','file_change'].includes(e.item?.type))throw Error('Unexpected native model tool');
  }
  if(e.type==='turn.completed')usage=e.usage;
 }
 if(!text||!usage)throw Error('Missing completed shadow response');
 return {strategy:JSON.parse(text),usage,durationMs:Date.now()-startedAt};
}
async function discover(root){
 const slots=await json(join(root,'runtime/ai-controller-slots.json'));
 const targets=slots.slots.filter(s=>s.bound&&s.provider==='offline');
 const dir=join(root,'runtime/independent-agent'),result=[];
 for(const name of await readdir(dir)){
  if(!/^[a-f0-9]{64}\.lock$/.test(name))continue;
  const lock=await json(join(dir,name)),target=targets.find(s=>s.id===lock.seat);if(!target)continue;
  result.push({...target,path:join(dir,name.replace('.lock','.sqlite'))});
 }
 return result;
}
export async function main(options){
 const output=resolve(options.output);await mkdir(output,{recursive:true});
 const lockPath=join(output,'daemon.lock');
 try{const f=await open(lockPath,'wx');await f.writeFile(JSON.stringify({pid:process.pid}));await f.close();}catch(error){throw Error('Shadow worker lock exists; verify its PID before removing it');}
 const statePath=join(output,'cursor.json');let state;try{state=await json(statePath);}catch{state={sources:{}};}
 let stopping=false,active=null;const queue=[];
 const halt=()=>{stopping=true;};process.on('SIGINT',halt);process.on('SIGTERM',halt);
 async function scan(){
  for(const target of await discover(options.root)){
   const key=target.roomId+':'+target.id,db=new DatabaseSync(target.path,{readOnly:true});
   try{
    if(state.sources[key]===undefined){const last=db.prepare("SELECT max(id) as id FROM journal WHERE room=? AND seat=? AND kind='bot-decision'").get(target.roomId,target.seat).id??0;state.sources[key]=options.includeLatest?Math.max(0,last-1):last;await atomic(statePath,state);}
    const rows=db.prepare("SELECT id,payload FROM journal WHERE room=? AND seat=? AND kind='bot-decision' AND id>? ORDER BY id LIMIT 50").all(target.roomId,target.seat,state.sources[key]);
    for(const row of rows){
     const p=JSON.parse(row.payload),directory=join(output,target.roomId,target.id,'round-'+String(p.sequence).padStart(6,'0'));
     // First planner decision per round; later receipts/finish are not new rounds.
     let exists=false;try{await readFile(join(directory,'status.json'));exists=true;}catch{}
     if(!exists){
      try{const data=capture(db,target.roomId,target.seat,row);await atomic(join(directory,'input.json'),data.input);await atomic(join(directory,'bot.json'),data.bot);await atomic(join(directory,'status.json'),{status:'queued',capturedAt:new Date().toISOString(),inputHash:sha(data.input)});queue.push(directory);}
      catch(e){await atomic(join(directory,'status.json'),{status:'capture-failed',error:e.message});}
     }
     state.sources[key]=row.id;await atomic(statePath,state);
    }
   }finally{db.close();}
  }
 }
 async function execute(directory){
  try{const input=await json(join(directory,'input.json')),bot=await json(join(directory,'bot.json'));
   const result=await runSol(directory,input,options),comparison=compareActions(bot,result.strategy);
   await atomic(join(directory,'sol.json'),result);await atomic(join(directory,'comparison.json'),comparison);
   await writeFile(join(directory,'comparison.md'),`# ${input.roomId} / 玩家${input.seat+1} / 第${input.sequence}轮 / 第${input.tick}天\n\n程序bot：${comparison.bot.objective}\n\n${JSON.stringify(comparison.bot.actions,null,2)}\n\nSol：${result.strategy.summary}\n\n${JSON.stringify(comparison.sol.parsedActions,null,2)}\n\n理由：${result.strategy.reasons.join('；')}\n\n风险：${result.strategy.risks.join('；')}\n\n需核实：${result.strategy.checks.join('；')}\n\n未执行Sol提案，未证明战果；本输入不是bot全部内部资料的逐字快照。\n`);
   await atomic(join(directory,'status.json'),{status:'completed',completedAt:new Date().toISOString(),model:options.model,effort:options.effort,serviceTier:'fast',usage:result.usage,durationMs:result.durationMs});
  }catch(e){await atomic(join(directory,'status.json'),{status:'failed',at:new Date().toISOString(),error:e.message,noAutomaticRetry:true});}
 }
 try{
  // Recover only durable queued jobs. Calling jobs are uncertain and never resent.
  async function recover(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isDirectory())await recover(join(dir,entry.name));else if(entry.name==='status.json'){const p=join(dir,entry.name),s=await json(p);if(s.status==='queued')queue.push(dir);if(s.status==='calling')await atomic(p,{...s,status:'interrupted-unconfirmed',noAutomaticRetry:true});}}}
  await recover(output);
  do{await scan();if(!active&&queue.length){const next=queue.shift();active=execute(next).finally(()=>{active=null;});}
   await atomic(join(output,'worker.json'),{pid:process.pid,at:new Date().toISOString(),queued:queue.length,active:!!active,model:options.model,effort:options.effort,serviceTier:'fast'});
   if(options.once){if(active)await active;while(queue.length)await execute(queue.shift());break;}
   await new Promise(r=>setTimeout(r,5000));
  }while(!stopping);
  if(active)await active;
 }finally{await unlink(lockPath);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
 const root=resolve(value('--root',process.cwd()));
 await main({root,output:value('--output',join(root,'runtime/bot-sol-shadow')),model:value('--model','gpt-6.1-sol'),effort:value('--effort','low'),timeoutMs:300000,includeLatest:args.includes('--include-latest'),once:args.includes('--once')});
}
