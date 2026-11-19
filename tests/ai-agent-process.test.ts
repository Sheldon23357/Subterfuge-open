import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawn as spawnProcess,type ChildProcess} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

function message(child:ChildProcess,kind:string){return new Promise<any>((resolve,reject)=>{
 const timer=setTimeout(()=>{cleanup();reject(Error(`Timed out waiting for ${kind}`));},20000);
 const receive=(value:any)=>{if(value?.kind===kind){cleanup();resolve(value);}else if(value?.kind==='error'){cleanup();reject(Error(value.message));}};
 const exit=(code:number|null)=>{cleanup();reject(Error(`Child exited ${code} waiting for ${kind}`));};
 const cleanup=()=>{clearTimeout(timer);child.off('message',receive);child.off('exit',exit);};
 child.on('message',receive);child.once('exit',exit);
});}
function spawn(name:string){return fork(new URL(`./fixtures/${name}.js`,import.meta.url),[],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'}});}
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGTERM');await done;}

test('independent OS processes: default runtime uses player control, restart does not replay orders', {timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agent-process-test-')),server=spawn('agent-game-process');
 const children:ChildProcess[]=[server];
 try{
  const ready=await message(server,'ready');assert.notEqual(ready.pid,process.pid);
  const config={storeDirectory:directory,seats:[{id:'self',serverUrl:ready.url,roomId:ready.roomId,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'TEST_PLAYER',settings:{model:'fake',personality:'schemer'}}]};
  async function run(live:boolean,attemptOrder:boolean){
   const agent=spawn('agent-runtime-process');children.push(agent);
   const alive=await message(agent,'ready');assert.notEqual(alive.pid,ready.pid);
   let stdout='',stderr='';agent.stdout?.on('data',b=>stdout+=String(b));agent.stderr?.on('data',b=>stderr+=String(b));
   const result=message(agent,'result'),exited=new Promise<void>(resolve=>agent.once('exit',()=>resolve()));
   agent.send({config,live,attemptOrder,seatId:'self',env:{TEST_PLAYER:ready.tokens[0]}});
   const value=await result;await exited;assert.equal(agent.exitCode,0);
   assert.equal(JSON.stringify(value).includes(ready.tokens[0]),false);
   assert.equal((stdout+stderr).includes(ready.tokens[0]),false);
   return value;
  }
  async function inspect(){const result=message(server,'state');server.send({kind:'inspect'});return result;}
  const live=await run(true,true);assert.ok(live.calls>=2);assert.equal((await inspect()).commands,1,JSON.stringify(live));
  const restarted=await run(true,false);assert.ok(restarted.calls>=1);assert.equal((await inspect()).commands,1);
  assert.equal(restarted.status[0].enabled,false);
 }finally{await Promise.all(children.map(stop));await rm(directory,{recursive:true,force:true});}
});


test('CLI default offline configuration completes autonomous local execution without model credentials', {timeout:30000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agent-cli-test-')),server=spawn('agent-game-process');
 try{
  const ready=await message(server,'ready'),configPath=join(directory,'config.json');
  await writeFile(configPath,JSON.stringify({storeDirectory:join(directory,'private'),seats:[{id:'self',serverUrl:ready.url,roomId:ready.roomId,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'TEST_PLAYER',settings:{model:'fake',personality:'schemer'}}]}));
  const child=spawnProcess(process.execPath,[fileURLToPath(new URL('../packages/ai/src/application/agent-cli.js',import.meta.url)),'--config',configPath,'--run-one','self'],{env:{PATH:process.env.PATH,TEST_PLAYER:ready.tokens[0],NO_PROXY:'127.0.0.1,localhost'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=String(b));child.stderr.on('data',b=>stderr+=String(b));
  const code=await new Promise<number|null>(resolve=>child.once('exit',resolve));
  assert.equal(code,0,stderr);assert.equal((stdout+stderr).includes(ready.tokens[0]),false);
  const result=JSON.parse(stdout.trim());assert.equal(result.type,'status');assert.equal(result.seats[0].mode,'live');assert.equal(result.seats[0].tokens,0);assert.equal(result.seats[0].calls,0);assert.ok(result.seats[0].telemetry.round>0);
  const inspected=message(server,'state');server.send({kind:'inspect'});assert.ok(Number.isInteger((await inspected).commands));
 }finally{await stop(server);await rm(directory,{recursive:true,force:true});}
});
