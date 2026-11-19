import { spawn } from "node:child_process";
import {watchContent,logReloadTrigger} from './dev-content-watch.mjs';
import { resolve } from "node:path";
import {verifyBuild} from './dev-build-cache.mjs';

const root = process.cwd();
const port = Number(process.env.LAB_PORT ?? 4310);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && command === "npm.cmd", ...options });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited with ${code}`)));
  });
}

let server,stopped=false;
async function rebuild(batch) {
  if(stopped)return;
  try {
    logReloadTrigger('game-web-refresh',batch);
    await run(process.execPath, ["scripts/build-web.mjs"]);
    if(stopped)return;
    const response = await fetch(`http://127.0.0.1:${port}/__dev/reload`, { method: "POST" });
    if (!response.ok) throw new Error(`Reload notification failed: ${response.status}`);
    console.log("前端已更新，浏览器正在刷新。");
  } catch (error) {
    console.error("前端构建失败，浏览器保持当前版本。", error);
  }
}
let resolveReady;
const ready=new Promise(resolve=>{resolveReady=resolve;});
const watcher=await watchContent({root,folders:[{path:'packages/client/src',kind:'client',extensions:/\.(?:tsx?|css)$/}],delayMs:250,
 onChange:async batch=>{await ready;await rebuild(batch);},onError:error=>console.error('前端源码内容检查失败，保留当前页面：',error)});

function stop() {
  stopped=true;
  watcher.close();
  server?.kill();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try{
 if(process.env.SUBTERFUGE_PREBUILT_RECEIPT)await verifyBuild(root,process.env.SUBTERFUGE_PREBUILT_RECEIPT);
 else await run(npm, ["run", "web:build"]);
 if(!stopped){
  server=spawn(process.execPath,[resolve('dist/packages/server/src/main.js')],{cwd:root,stdio:'inherit',env:{...process.env,LAB_DEV_RELOAD:'1'}});
  server.once('error',error=>{console.error(error);process.exitCode=1;watcher.close();});
  server.once('exit',code=>{watcher.close();process.exitCode=code??0;});
 }
 resolveReady();await watcher.flush();
}catch(error){stop();resolveReady();throw error;}
console.log(`前端热更新已启用（仅内容变化触发）：http://127.0.0.1:${port}（按 Ctrl+C 停止）`);
