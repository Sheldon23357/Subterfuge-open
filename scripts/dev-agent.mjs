import { spawn } from 'node:child_process';
import {watchContent,logReloadTrigger} from './dev-content-watch.mjs';
import {controllerRequest,waitForController} from './dev-agent-ipc.mjs';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import {verifyBuild} from './dev-build-cache.mjs';

const root=process.cwd();
const supplied=process.argv.slice(2).filter(arg=>arg!=='--backend-reload');
const backendReload=process.argv.includes('--backend-reload');
const args=supplied.includes('--console')?supplied:['--console','4400',...supplied];
const consoleIndex=args.indexOf('--console');
const consolePort=Number(args[consoleIndex+1]&&!args[consoleIndex+1].startsWith('--')?args[consoleIndex+1]:'4400');
if(!Number.isSafeInteger(consolePort)||consolePort<1||consolePort>65535)throw Error('ai:dev requires a fixed console port from 1 to 65535');
const npm=process.platform==='win32'?process.env.ComSpec??'cmd.exe':'npm';
function run(command,args){return new Promise((resolveRun,reject)=>{const child=spawn(command,args,{cwd:root,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolveRun():reject(new Error(`${args.join(' ')} exited with ${code}`)));});}
function runNpm(task){return run(npm,process.platform==='win32'?['/d','/s','/c',`npm run ${task}`]:['run',task]);}
async function buildConsole(){await run(process.execPath,[resolve('scripts/build-agent-console.mjs')]);}
let controller;
let controllerReady;
let stopped=false;
let rebuilding=false;
let contentWatcher;
function startController(){
 controller=spawn(process.execPath,[resolve('dist/packages/ai/src/application/agent-cli.js'),...args],{cwd:root,stdio:['inherit','inherit','inherit','ipc'],env:{...process.env,AI_CONSOLE_DEV_RELOAD:'1'}});
 controllerReady=waitForController(controller);
 // Initial startup/reload awaits this promise; suppress an early unhandled rejection.
 void controllerReady.catch(()=>{});
 controller.once('error',error=>{console.error('AI controller failed to start.',error);process.exitCode=1;});
 controller.once('exit',code=>{if(!stopped&&rebuilding)return;if(!stopped){console.error(`AI controller exited unexpectedly (${code}).`);process.exitCode=code??1;contentWatcher?.close();void cleanupLocks(controller.pid);}});
}

async function cleanupLocks(pid){
 if(!pid)return;
 try{process.kill(pid,0);return;}catch(error){if(error.code!=='ESRCH')return;}
 const index=args.indexOf('--store-directory'),directory=resolve(index>=0?args[index+1]:'runtime/independent-agent');
 let names;try{names=await readdir(directory);}catch{return;}
 for(const name of names){if(!/^[a-f0-9]{64}\.lock$/.test(name))continue;const file=resolve(directory,name);
  try{const record=JSON.parse(await readFile(file,'utf8'));if(record.pid===pid)await unlink(file);}catch{}
 }
}
async function stopController(child){
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 const exited=new Promise(resolveExit=>{child.once('exit',async()=>{await cleanupLocks(child.pid);resolveExit();});});
 await controllerRequest(child,'dev-reload-stop');
 await exited;
}

async function reload(batch){
 if(stopped)return;
 rebuilding=true;
 let resumeSeats,replaced=false;
 try{
  const backendChanges=batch.changes.filter(c=>c.kind==='backend'),clientChanges=batch.changes.filter(c=>c.kind==='client');
  const reloadBackend=backendChanges.length>0,reloadClient=clientChanges.length>0;
  if(reloadBackend)logReloadTrigger('ai-backend-restart',batch,backendChanges);
  if(reloadClient)logReloadTrigger('ai-console-refresh',batch,clientChanges);
  if(reloadBackend)await runNpm('build');
  if(reloadClient)await buildConsole();
  if(stopped)return;
  if(reloadBackend){
   // Capture after building so the handoff reflects the user's latest start/pause intent.
   resumeSeats=await controllerRequest(controller,'dev-reload-prepare');
   await stopController(controller);replaced=true;
   if(!stopped){
    startController();await controllerReady;
    const results=await controllerRequest(controller,'dev-reload-resume',resumeSeats);
    const failed=results.filter(s=>s.status==='failed'),skipped=results.filter(s=>s.status==='skipped');
    console.log(`AI 控制器后端已热重启；已自动恢复 ${results.filter(s=>s.status==='resumed').length} 个运行席位，原暂停席位保持暂停。`);
    if(skipped.length)console.warn('AI 热重启未恢复身份已变化或已结束的席位：',skipped);
    if(failed.length)throw Error('AI 席位自动恢复失败：'+failed.map(s=>s.id).join(', '));
   }
  }
  if(reloadClient){let response;for(let i=0;i<20;i++){try{response=await fetch(`http://127.0.0.1:${consolePort}/__dev/reload`,{method:'POST',headers:{origin:`http://127.0.0.1:${consolePort}`}});if(response.ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}if(!response?.ok)throw new Error('Console reload notification failed');console.log('AI 控制台前端已更新，打开的页面正在刷新。');}
 }catch(error){
  // A failed handoff must not leave the still-running old controller paused.
  if(resumeSeats&&!replaced&&!stopped)try{await controllerRequest(controller,'dev-reload-resume',resumeSeats);}catch{}
  console.error('AI 控制器热更新失败。',error);
 }
 finally{rebuilding=false;}
}
let resolveReady;
const ready=new Promise(resolve=>{resolveReady=resolve;});
contentWatcher=await watchContent({root,folders:[
 {path:'packages/client/src',kind:'client',extensions:/\.(?:tsx?|css|json)$/},
 ...(backendReload?[
 {path:'packages/ai/src',kind:'backend',extensions:/\.(?:tsx?|css|json)$/},
 {path:'packages/contracts/src',kind:'backend',extensions:/\.(?:tsx?|css|json)$/},
 ]:[]),
],onChange:async batch=>{await ready;await reload(batch);},onError:error=>console.error('AI 源码内容检查失败，保留当前进程：',error)});
function stop(){if(stopped)return;stopped=true;contentWatcher.close();void stopController(controller).catch(error=>console.error('AI 控制器关闭失败。',error));}
process.once('SIGINT',stop);
process.once('SIGTERM',stop);
try{
 if(process.env.SUBTERFUGE_PREBUILT_RECEIPT)await verifyBuild(root,process.env.SUBTERFUGE_PREBUILT_RECEIPT);
 else {await runNpm('build');await buildConsole();}
 if(!stopped){startController();await controllerReady;}resolveReady();await contentWatcher.flush();
}catch(error){stop();resolveReady();throw error;}
console.log(`AI 控制台前端热更新已启用；后端自动热重启${backendReload?'已启用':'已关闭'}：http://127.0.0.1:${consolePort}/`);
