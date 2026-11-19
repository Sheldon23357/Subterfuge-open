import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {controllerRequest,waitForController}=await import(pathToFileURL(resolve('scripts/dev-agent-ipc.mjs')).href);

function message(child:ChildProcess,kind:string):Promise<any>{return new Promise((done,reject)=>{
 const timer=setTimeout(()=>{cleanup();reject(Error('Fixture readiness timed out'));},20000);
 const receive=(p:any)=>{if(p?.kind===kind){cleanup();done(p);}};
 const cleanup=()=>{clearTimeout(timer);child.off('message',receive);};child.on('message',receive);
});}
async function closeController(child:ChildProcess){
 if(child.exitCode!==null||child.signalCode!==null)return;
 const exited=new Promise<void>(done=>child.once('exit',()=>done()));
 await controllerRequest(child,'dev-reload-stop');await exited;
 assert.equal(child.exitCode,0);
}
test('real controller processes release locks and restore the same running seat without starting paused peers',{timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agent-dev-reload-'));
 const server=fork(new URL('./fixtures/agent-game-process.js',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc']});
 const children:ChildProcess[]=[];
 try{
  const game=await message(server,'ready'),configPath=join(directory,'config.json');
  await writeFile(configPath,JSON.stringify({storeDirectory:join(directory,'private'),pollMs:1000,seats:[0,1].map(i=>({id:String(i),serverUrl:game.url,roomId:game.roomId,lobbySeat:i,gamePlayer:i,chatPlayer:i,chatCount:2,tokenEnv:'RELOAD_PLAYER_'+i,settings:{model:'',personality:'schemer'}}))}));
  const launch=async()=>{
   const child=fork(new URL('../packages/ai/src/application/agent-cli.js',import.meta.url),['--config',configPath,'--console','0','--console-mode','configured'],{stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,AI_CONSOLE_DEV_RELOAD:'1',RELOAD_PLAYER_0:game.tokens[0],RELOAD_PLAYER_1:game.tokens[1]}});
   children.push(child);await waitForController(child);return child;
  };
  const first=await launch();
  const before=[{id:'0',serverUrl:game.url,roomId:game.roomId,lobbySeat:0,gamePlayer:0}];
  assert.equal((await controllerRequest(first,'dev-reload-resume',before))[0].status,'resumed');
  const handoff=await controllerRequest(first,'dev-reload-prepare');assert.deepEqual(handoff,before);
  await closeController(first);
  const second=await launch();
  assert.deepEqual(await controllerRequest(second,'dev-reload-prepare'),[],'a new process remains paused without a handoff');
  assert.equal((await controllerRequest(second,'dev-reload-resume',handoff))[0].status,'resumed');
  assert.deepEqual(await controllerRequest(second,'dev-reload-prepare'),before,'only the originally running seat is resumed');
  await closeController(second);
 }finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)await closeController(child);
  const exited=new Promise<void>(done=>server.once('exit',()=>done()));server.kill('SIGTERM');await exited;
  await rm(directory,{recursive:true,force:true});
 }
});
