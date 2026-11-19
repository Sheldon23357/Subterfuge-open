import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {AgentRuntime} from '../packages/ai/src/reference.js';
import {parseAgentConfig} from '../packages/ai/src/controller/contracts/agent-config.js';
import {controllerSynchronizer} from '../packages/ai/src/application/controller-sync.js';

async function freePort(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
test('automatic clock waits for every bound external AI, then stops again on pause',{timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'external-ai-clock-')),port=await freePort(),playerPort=await freePort();
 const runtime=new AgentRuntime(parseAgentConfig({storeDirectory:join(directory,'ai'),seats:[]}),{step:async()=>{throw Error('No external model expected');}},{},{fixedSlots:true,profilesPath:join(directory,'ai','profiles.json')});
 const synchronize=controllerSynchronizer(runtime,directory,playerPort);await synchronize();
 const child=fork(resolve('dist/packages/server/src/main.js'),[],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,LAB_DATA_DIR:directory,LAB_PORT:String(port),PLAYER_PORT:String(playerPort),GAME_CLOCK:'manual',NO_PROXY:'127.0.0.1,localhost'}});let output='';child.stdout!.on('data',c=>output+=c);child.stderr!.on('data',c=>output+=c);
 try{
  const base=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(output);if(await fetch(base+'/api/ai-controller').then(r=>r.ok,()=>false)){ready=true;break;}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,output);
  const post=(path:string,body:unknown)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const created=await post('new',{players:2,seed:4300,controllerBindings:[{seat:0,slot:3},{seat:1,slot:1}]});assert.equal(created.status,200,await created.text());await synchronize();
  const state=async()=>await(await fetch(base+'/api/state')).json();
  assert.equal((await post('auto-advance',{enabled:true})).status,200);
  await new Promise(r=>setTimeout(r,2200));assert.equal((await state()).tick,0,'bound but unstarted AI must block the clock');
  await runtime.start('ai-04');await runtime.tick();
  await new Promise(r=>setTimeout(r,1200));assert.equal((await state()).tick,0,'one ready AI cannot bypass another unstarted binding');
  await runtime.start('ai-02');runtime.serve();
  const deadline=Date.now()+18000;let current=await state();
  while(current.tick===0&&Date.now()<deadline){await new Promise(r=>setTimeout(r,100));current=await state();}
  assert.equal(current.tick,1,'both authenticated idle AIs must allow the first tick');
  await runtime.pause('ai-02');const pausedAt=(await state()).tick;
  await new Promise(r=>setTimeout(r,2200));assert.equal((await state()).tick,pausedAt,'pausing a bound AI must block further automatic ticks');
 }finally{await runtime.shutdown();if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}await rm(directory,{recursive:true,force:true});}
});
