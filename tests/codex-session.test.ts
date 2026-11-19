import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** Real stdio subprocesses with a synthetic app-server. The saved file stands
 * in for durable native threads across process restarts, never for game state. */
function fixture(body:string){
 const dir=mkdtempSync(join(tmpdir(),'codex-session-test-'));
 try{
  const main=join(dir,'main.cjs'),preload=join(dir,'preload.cjs'),state=join(dir,'state.json');
  writeFileSync(main,'// Synthetic RPC main; all handlers are installed by the preload.');
  writeFileSync(state,JSON.stringify({serial:0,threads:{},requests:[],mode:'normal'}));
  writeFileSync(preload,`
const fs=require('node:fs'),readline=require('node:readline');
process.argv[1]=${JSON.stringify(main)};
const path=${JSON.stringify(state)};
const read=()=>JSON.parse(fs.readFileSync(path,'utf8'));
const save=s=>fs.writeFileSync(path,JSON.stringify(s));
const send=m=>fs.writeSync(1,JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 const s=read(),p=m.params??{};s.requests.push({method:m.method,threadId:p.threadId,developerInstructions:p.developerInstructions,outputSchema:p.outputSchema});
 const answer=result=>{save(s);send({id:m.id,result});};
 if(m.method==='initialize')return answer({});
 if(m.method==='thread/start'){const id='synthetic-'+(++s.serial);s.threads[id]={turns:[],calls:0};return answer({thread:{id,ephemeral:false}});}
 const thread=s.threads[p.threadId];
 if(m.method==='thread/resume')return answer({thread:{id:p.threadId,ephemeral:false}});
 if(m.method==='thread/archive'){if(thread)thread.archived=true;return answer({});}
 if(m.method==='thread/turns/list')return answer({data:thread.turns.map(id=>({id})),nextCursor:null});
 if(m.method==='thread/revert'){
  if(s.mode==='reset-fails'){s.mode='normal';save(s);return send({id:m.id,error:{code:-32600,message:'synthetic reset failure'}});}
  thread.turns=s.mode==='bad-reset'?['stale-turn']:[];return answer({thread:{id:p.threadId,turns:[]}});
 }
 if(m.method==='turn/start'){
  if(thread.turns.length){save(s);return send({id:m.id,error:{code:-32600,message:'unexpected accumulated history'}});}
  const turnId='turn-'+(++thread.calls);thread.turns.push(turnId);save(s);
  const notify=(method,data)=>send({method,params:{threadId:p.threadId,turnId,...data}});
  if(s.mode==='block'){send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}});return;}
  if(s.mode==='native-tool'){notify('item/started',{item:{type:'commandExecution'}});return;}
  if(s.mode==='rate-limit'){notify('error',{error:{message:'HTTP 429 rate limit'},willRetry:true});return;}
  notify('item/completed',{item:{type:'agentMessage',text:JSON.stringify({summary:'',tasks:[],cancel:[],reviewOn:[],betrayAgreements:null})}});
  if(s.mode!=='missing-usage')notify('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:1234,outputTokens:7,cachedInputTokens:1000},total:{inputTokens:1234*thread.calls,outputTokens:7*thread.calls,cachedInputTokens:1000*thread.calls}}});
  notify('turn/completed',{turn:{id:turnId,status:'completed'}});
  // Complete notifications deliberately precede the RPC response.
  send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}});return;
 }
 send({id:m.id,error:{code:-32601,message:'unknown synthetic method'}});
});
`);
  writeFileSync(main,readFileSync(preload));
  const moduleUrl=new URL('../packages/ai/src/application/providers/codex.js',import.meta.url).href;
  const script=`import {CodexProvider} from ${JSON.stringify(moduleUrl)};import {readFileSync,writeFileSync} from 'node:fs';import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const originalSpawn=childProcess.spawn;childProcess.spawn=(command,args,options)=>originalSpawn(command,command===process.execPath&&args[0]==='app-server'?[${JSON.stringify(main)},...args.slice(1)]:args,options);syncBuiltinESMExports();
const file=${JSON.stringify(state)};
const mode=value=>{const s=JSON.parse(readFileSync(file,'utf8'));s.mode=value;writeFileSync(file,JSON.stringify(s));};
const provider=new CodexProvider(process.execPath,4000);
const request=(key='bot-A',signal=new AbortController().signal)=>({providerSessionKey:key,model:'synthetic-model',effort:'low',serviceTier:'default',prompt:'[instructions.output Rules]\\nReturn JSON.\\n[/instructions.output]\\n[brief.global Facts]\\n{}\\n[/brief.global]\\n',responseSchema:{type:'object',properties:{summary:{type:'string'},tasks:{type:'array',items:{type:'null'}},cancel:{type:'array',items:{type:'string'}},reviewOn:{type:'array',items:{type:'string'}},betrayAgreements:{type:'array',items:{type:'string'}}},required:['summary','tasks','cancel','reviewOn'],additionalProperties:false},signal});
const capture=async fn=>{try{return {result:await fn()};}catch(e){return {error:{code:e.code,source:e.timeoutSource,diagnostic:e.diagnostic}};}};
${body}`;
  const output=execFileSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8',windowsHide:true,timeout:20000});
  return {result:JSON.parse(output),state:JSON.parse(readFileSync(state,'utf8'))};
 }finally{rmSync(dir,{recursive:true,force:true});}
}

test('reused threads are empty before/after every call, including a new native process per call',()=>{
 const {result,state}=fixture(`const results=[];for(let i=0;i<4;i++)results.push(await provider.step(request()));process.stdout.write(JSON.stringify(results));`);
 assert.equal(new Set(result.map((r:any)=>r.providerContext.threadId)).size,1);
 assert.deepEqual(result.map((r:any)=>r.providerContext.reusedSession),[false,true,true,true]);
 for(const r of result){assert.equal(r.usage.inputTokens,1234);assert.equal(r.usage.outputTokens,7);assert.equal(r.usage.cachedInputTokens,1000);assert.equal(r.providerContext.sessionMode,'revert');assert.equal(r.providerContext.historyBefore,0);assert.equal(r.providerContext.historyAfter,1);assert.equal(r.providerContext.historyAfterReset,0);assert.equal(Object.hasOwn(r.reply,'betrayAgreements'),false);}
 assert.equal(state.requests.filter((r:any)=>r.method==='thread/start').length,1);
 assert.equal(state.requests.filter((r:any)=>r.method==='thread/resume').length,3);
 assert.equal(state.requests.filter((r:any)=>r.method==='thread/revert').length,4);
 assert.ok(Object.values(state.threads).every((t:any)=>t.turns.length===0));
});

test('server/room/player scopes and fixed-rule changes cannot reuse one another’s thread',()=>{
 const {result}=fixture(`const a=await provider.step(request('server-room-player-A'));const b=await provider.step(request('server-room-player-B'));const changed=request('server-room-player-A');changed.prompt=changed.prompt.replace('Return JSON.','Other role rules.');const c=await provider.step(changed);const again=await provider.step(request('server-room-player-A'));process.stdout.write(JSON.stringify([a,b,c,again]));`);
 assert.equal(new Set(result.slice(0,3).map((r:any)=>r.providerContext.threadId)).size,3);
 assert.equal(result[0].providerContext.threadId,result[3].providerContext.threadId);
});

test('one bot reuses separate empty threads for interleaved diplomatic conversations and strategy tasks',()=>{
 const {result,state}=fixture(`const results=[];const scopes=[['diplomacy','peer-A'],['diplomacy','peer-B'],['strategy','overview'],['strategy','border'],['diplomacy','peer-A'],['strategy','overview'],['strategy','border'],['diplomacy','peer-B']];for(let i=0;i<scopes.length;i++){const [kind,task]=scopes[i];const r=request();r.providerSessionScope={kind,task};r.audit={callId:'call-'+i,attempt:i,kind,task};r.prompt=r.prompt.replace('{}','{"tick":'+i+'}');if(i>=4)r.responseSchema.properties.summary.maxLength=1500;results.push(await provider.step(r));}process.stdout.write(JSON.stringify(results));`);
 assert.equal(new Set(result.slice(0,4).map((r:any)=>r.providerContext.threadId)).size,4);
 for(const [a,b]of [[0,4],[1,7],[2,5],[3,6]]){
  assert.equal(result[a!]!.providerContext.threadId,result[b!]!.providerContext.threadId);
  assert.equal(result[a!]!.providerContext.reusedSession,false);assert.equal(result[b!]!.providerContext.reusedSession,true);
  assert.deepEqual(result[a!]!.providerContext.sessionScope,result[b!]!.providerContext.sessionScope);
 }
 for(const r of result)assert.deepEqual([r.providerContext.historyBefore,r.providerContext.historyAfter,r.providerContext.historyAfterReset],[0,1,0]);
 assert.equal(state.requests.filter((r:any)=>r.method==='thread/start').length,4);
 assert.equal(state.requests.filter((r:any)=>r.method==='thread/revert').length,8);
 assert.ok(Object.values(state.threads).every((t:any)=>t.turns.length===0));
});

test('task scope uses the role and remains isolated by bot identity',()=>{
 const {result}=fixture(`const results=[];for(const [key,kind]of [['bot-A','strategy'],['bot-A','diplomacy'],['bot-B','strategy'],['bot-A','strategy']]){const r=request(key);r.providerSessionScope={kind,task:'same-name'};results.push(await provider.step(r));}process.stdout.write(JSON.stringify(results));`);
 assert.equal(new Set(result.slice(0,3).map((r:any)=>r.providerContext.threadId)).size,3);
 assert.equal(result[0].providerContext.threadId,result[3].providerContext.threadId);
});

test('a failed reset evicts only its task thread while other conversations remain reusable',()=>{
 const {result,state}=fixture(`const call=task=>{const r=request();r.providerSessionScope={kind:'diplomacy',task};return provider.step(r);};const a=await call('A'),b=await call('B');mode('reset-fails');const failed=await capture(()=>call('A'));mode('normal');const againB=await call('B'),againA=await call('A');process.stdout.write(JSON.stringify({a,b,failed,againB,againA}));`);
 assert.ok(result.failed.error);assert.equal(result.b.providerContext.threadId,result.againB.providerContext.threadId);
 assert.notEqual(result.a.providerContext.threadId,result.againA.providerContext.threadId);
 assert.equal(result.againB.providerContext.reusedSession,true);assert.equal(result.againA.providerContext.reusedSession,false);
 assert.ok(Object.values(state.threads).filter((t:any)=>!t.archived).every((t:any)=>t.turns.length===0));
});

test('failed reset and false empty-history claims evict the thread instead of appending next time',()=>{
 for(const value of ['reset-fails','bad-reset']){
  const {result}=fixture(`mode('${value}');const first=await capture(()=>provider.step(request()));mode('normal');const second=await provider.step(request());process.stdout.write(JSON.stringify({first,second}));`);
  assert.ok(result.first.error);assert.equal(result.second.providerContext.reusedSession,false);
  assert.equal(result.second.providerContext.threadId,'synthetic-2');
 }
});

test('pause, timeout and native tool attempts cannot leave a reusable dirty session',()=>{
 for(const scenario of ['cancel','timeout','native-tool']){
  const setup=scenario==='cancel'?`mode('block');const controller=new AbortController();setTimeout(()=>controller.abort(),350);const first=await capture(()=>provider.step(request('bot-A',controller.signal)));`:
   scenario==='timeout'?`mode('block');const timed=new CodexProvider(process.execPath,350);const first=await capture(()=>timed.step(request()));`:
   `mode('native-tool');const first=await capture(()=>provider.step(request()));`;
  const {result}=fixture(`${setup}mode('normal');const second=await provider.step(request());process.stdout.write(JSON.stringify({first,second}));`);
  assert.equal(result.first.error.code,scenario==='cancel'?'cancelled':scenario==='timeout'?'timeout':'native-tool');
  if(scenario==='timeout')assert.equal(result.first.error.source,'provider-call');
  assert.equal(result.second.providerContext.reusedSession,false);
 }
});

test('missing provider usage fails explicitly and does not invent zero or reuse the incomplete session',()=>{
 const {result}=fixture(`mode('missing-usage');const first=await capture(()=>provider.step(request()));mode('normal');const second=await provider.step(request());process.stdout.write(JSON.stringify({first,second}));`);
 assert.equal(result.first.error.code,'invalid-response');assert.equal(result.second.providerContext.reusedSession,false);
});

test('HTTP 429 interrupts native retries and reaches the shared backoff classification',()=>{
 const {result}=fixture(`mode('rate-limit');const first=await capture(()=>provider.step(request()));mode('normal');const second=await provider.step(request());process.stdout.write(JSON.stringify({first,second}));`);
 assert.equal(result.first.error.code,'transient');assert.equal(result.first.error.diagnostic.reason,'rate-limit');assert.equal(result.first.error.diagnostic.httpStatus,429);assert.equal(result.first.error.diagnostic.outcome,'rejected');
 assert.equal(result.second.providerContext.reusedSession,false);
});

test('same session cannot be used concurrently and rejection is known not sent',()=>{
 const {result}=fixture(`mode('block');const controller=new AbortController();const first=capture(()=>provider.step(request('bot-A',controller.signal)));await new Promise(r=>setTimeout(r,220));const second=await capture(()=>provider.step(request()));controller.abort();await first;process.stdout.write(JSON.stringify(second));`);
 assert.equal(result.error.diagnostic.reason,'session-busy');assert.equal(result.error.diagnostic.outcome,'not-sent');
});
