import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {AgentRuntime} from '../packages/ai/src/reference.js';
import {parseAgentConfig} from '../packages/ai/src/controller/contracts/agent-config.js';
import {controllerSynchronizer} from '../packages/ai/src/application/controller-sync.js';
import {startAgentConsole} from '../packages/ai/src/application/agent-console.js';

async function freePort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port;}

test('disconnect releases an active slot, preserves its profile and other slots, and survives sync and restart',{timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agent-disconnect-')),port=await freePort(),playerPort=await freePort();
 const makeRuntime=()=>new AgentRuntime(parseAgentConfig({storeDirectory:join(directory,'ai'),seats:[]}),{step:async()=>{throw Error('No model invocation expected');}},{},{fixedSlots:true,profilesPath:join(directory,'ai','profiles.json')});
 const runtime=makeRuntime(),synchronize=controllerSynchronizer(runtime,directory,playerPort);await synchronize();
 const child=fork(resolve('dist/packages/server/src/main.js'),[],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,LAB_DATA_DIR:directory,LAB_PORT:String(port),PLAYER_PORT:String(playerPort),GAME_CLOCK:'manual',NO_PROXY:'127.0.0.1,localhost'}});
 let output='';child.stdout!.on('data',c=>output+=c);child.stderr!.on('data',c=>output+=c);
 let consoleServer:Awaited<ReturnType<typeof startAgentConsole>>|undefined;
 try{
  const base=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(output);if(await fetch(base+'/api/ai-controller').then(r=>r.ok,()=>false)){ready=true;break;}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,output);
  const created=await fetch(base+'/api/new',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({players:2,seed:4300,controllerBindings:[{seat:0,slot:3},{seat:1,slot:1}]})});assert.equal(created.status,200,await created.text());
  const access=JSON.parse(await readFile(join(directory,'player-access.json'),'utf8'));
  await synchronize();
  runtime.configureSeat('ai-04',{kind:'offline',model:'saved-model'},{model:'',personality:'merchant'});
  await runtime.start('ai-04');assert.equal(runtime.status().find(s=>s.id==='ai-04')!.owned,true);
  consoleServer=await startAgentConsole(runtime,{webRoot:'packages/client/agent-console-public',provider:'offline',synchronize,disconnect:synchronize.disconnect});
  const page=await fetch(consoleServer.url),cookie=page.headers.get('set-cookie')!.split(';')[0]!;
  const {csrf}=await(await fetch(consoleServer.url+'api/agent/bootstrap',{headers:{cookie,'x-agent-console':'1'}})).json();
  const disconnect=(body:unknown)=>fetch(consoleServer!.url+'api/agent/disconnect',{method:'POST',headers:{cookie,'x-agent-csrf':csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await disconnect({id:'ai-04',slot:1})).status,400);
  const result=await disconnect({id:'ai-04'});assert.equal(result.status,200,await result.text());
  assert.equal(runtime.status().length,8);assert.equal(runtime.status().find(s=>s.id==='ai-04')!.bound,false);assert.equal(runtime.status().find(s=>s.id==='ai-02')!.bound,true);
  const profile=runtime.consoleConfig().seats.find(s=>s.id==='ai-04')!;assert.equal(profile.settings.model,'');assert.equal(profile.settings.personality,'merchant');
  const control=await(await fetch(`http://127.0.0.1:${playerPort}/player/v2/owner/control`,{headers:{Authorization:`Bearer ${access.credentials[0].token}`}})).json();assert.equal(control.mode,'manual');
  assert.deepEqual(JSON.parse(await readFile(join(directory,'controller-bindings.json'),'utf8')).bindings,[{seat:1,slot:1}]);
  await synchronize();await synchronize();assert.equal(runtime.status().find(s=>s.id==='ai-04')!.bound,false);assert.equal((await disconnect({id:'ai-04'})).status,400);
  await runtime.shutdown();
  const restored=makeRuntime();
  try{await controllerSynchronizer(restored,directory,playerPort)();assert.equal(restored.status().find(s=>s.id==='ai-04')!.bound,false);assert.equal(restored.status().find(s=>s.id==='ai-02')!.bound,true);assert.equal(restored.consoleConfig().seats.find(s=>s.id==='ai-04')!.settings.model,'');}
  finally{await restored.shutdown();}
 }finally{await consoleServer?.close();await runtime.shutdown();if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}await rm(directory,{recursive:true,force:true});}
});
