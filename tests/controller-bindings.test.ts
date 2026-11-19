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

async function freePort(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
test('fixed console rejects unbound starts and seat deletion while allowing profile configuration',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'controller-console-'));
 const runtime=new AgentRuntime(parseAgentConfig({storeDirectory:directory,seats:[]}),{step:async()=>{throw Error('No model expected');}},{},{fixedSlots:true,profilesPath:join(directory,'profiles.json')});
 const server=await startAgentConsole(runtime,{port:0,webRoot:'packages/client/agent-console-public',provider:'offline'});
 try{
  const page=await fetch(server.url),cookie=page.headers.get('set-cookie')!.split(';')[0]!;
  const boot=await(await fetch(server.url+'api/agent/bootstrap',{headers:{cookie,'x-agent-console':'1'}})).json();
  const headers={cookie,'x-agent-csrf':boot.csrf,'Content-Type':'application/json'};
  const post=(path:string,body:unknown)=>fetch(server.url+'api/agent/'+path,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await post('action',{id:'ai-01',action:'start'})).status,409);
  assert.equal((await post('remove',{id:'ai-01'})).status,400);
  assert.equal((await post('instances',{})).status,400);
  assert.equal((await post('configuration',{id:'ai-01',provider:{kind:'codex',model:'saved-model'},settings:{model:'',personality:'merchant'}})).status,200);
  assert.equal(runtime.consoleConfig().seats[0]!.settings.model,'saved-model');assert.equal(runtime.status().length,8);assert.ok(runtime.status().every(s=>!s.bound&&!s.enabled&&s.calls===0));
 }finally{await server.close();await runtime.shutdown();await rm(directory,{recursive:true,force:true});}
});
test('game creation persists explicit controller bindings and rejects duplicates before replacing the room',{timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'controller-game-')),port=await freePort();
 // Closing an ephemeral listener allows the next allocation to reuse its port.
 let playerPort=await freePort();while(playerPort===port)playerPort=await freePort();
 const runtime=new AgentRuntime(parseAgentConfig({storeDirectory:join(directory,'ai'),seats:[]}),{step:async()=>{throw Error('No model invocation expected');}},{},{fixedSlots:true,profilesPath:join(directory,'ai','profiles.json')});
 const synchronize=controllerSynchronizer(runtime,directory,playerPort);await synchronize();
 const child=fork(resolve('dist/packages/server/src/main.js'),[],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,LAB_DATA_DIR:directory,LAB_PORT:String(port),PLAYER_PORT:String(playerPort),GAME_CLOCK:'manual',NO_PROXY:'127.0.0.1,localhost'}});let output='';child.stdout!.on('data',c=>output+=c);child.stderr!.on('data',c=>output+=c);
 try{
  const base=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(output);if(await fetch(base+'/api/ai-controller').then(r=>r.ok,()=>false)){ready=true;break;}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,output);
  const post=(body:unknown)=>fetch(base+'/api/new',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const bindings=[{seat:0,slot:3},{seat:1,slot:1}];const response=await post({players:2,seed:4300,controllerBindings:bindings});assert.equal(response.status,200,await response.text());
  const access=JSON.parse(await readFile(join(directory,'player-access.json'),'utf8'));
  const saved=JSON.parse(await readFile(join(directory,'controller-bindings.json'),'utf8'));assert.equal(saved.roomId,access.roomId);assert.deepEqual(saved.bindings,bindings);
  await synchronize();const bound=runtime.status().filter(s=>s.bound);assert.equal(bound.length,2);assert.equal(bound.find(s=>s.id==='ai-04')!.lobbySeat,0);assert.equal(bound.find(s=>s.id==='ai-02')!.lobbySeat,1);assert.ok(bound.every(s=>!s.enabled&&s.calls===0));
  const invalid=await post({players:2,seed:4301,controllerBindings:[{seat:0,slot:1},{seat:1,slot:1}]});assert.equal(invalid.status,400);assert.equal(JSON.parse(await readFile(join(directory,'player-access.json'),'utf8')).roomId,access.roomId);
 }finally{await runtime.shutdown();if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}await rm(directory,{recursive:true,force:true});}
});
