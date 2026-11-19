import {fork} from 'node:child_process';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const children=[];let directory,closing;
async function stop(){
 return closing??=(async()=>{
  await Promise.all(children.map(async child=>{if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit').catch(()=>{});if(child.connected)child.send({kind:'stop'},()=>{});else child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);timer.unref();await exited;clearTimeout(timer);}));
  if(directory)await rm(directory,{recursive:true,force:true});
  if(process.connected)process.disconnect();
 })();
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void stop());
process.once('disconnect',()=>void stop());
process.on('message',message=>{if(message?.kind==='stop')void stop();});
function child(path,args=[]){
 if(closing)throw Error('Demo startup cancelled');
 const processChild=fork(path,args,{cwd:root,detached:process.platform==='win32',windowsHide:true,env:{PATH:process.env.PATH??'',NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost',SUBTERFUGE_DEMO_DIRECTORY:directory},stdio:['ignore','pipe','pipe','ipc']});
 children.push(processChild);
 // Errors deliberately omit arbitrary child output, which may contain input data.
 processChild.stderr.on('data',()=>{});
 processChild.on('exit',()=>{if(!closing){process.exitCode=1;void stop();}});
 processChild.on('error',()=>{process.exitCode=1;void stop();});return processChild;
}
async function ready(processChild,predicate,event='message'){
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(Error('Demo startup timed out')),15000);const source=event==='data'?processChild.stdout:processChild;const onData=value=>{try{const result=predicate(value);if(result)finish(null,result);}catch(error){finish(error);}};const onExit=()=>finish(Error('Demo child stopped before ready'));function finish(error,value){clearTimeout(timer);source.off(event,onData);processChild.off('exit',onExit);processChild.off('error',onExit);error?reject(error):resolve(value);}source.on(event,onData);processChild.once('exit',onExit);processChild.once('error',onExit);});
}
try{
 for(const file of ['dist/packages/server/src/dev-agent-game.js','dist/packages/ai/src/application/agent-cli.js','packages/client/public/player.js','packages/client/agent-console-public/agent-console.js'])await access(join(root,file));
 directory=await mkdtemp(join(tmpdir(),'subterfuge-agent-demo-'));
 if(closing){await rm(directory,{recursive:true,force:true});throw Error('Demo startup cancelled');}
 await writeFile(join(directory,'demo.marker'),'synthetic-agent-demo/1',{mode:0o600});
 const config=join(directory,'config.json');await writeFile(config,JSON.stringify({storeDirectory:join(directory,'agent-state'),seats:[]}),{mode:0o600});
 const game=child(join(root,'dist/packages/server/src/dev-agent-game.js'));
 const gameReady=await ready(game,value=>value?.kind==='ready'?value:null);
 if(closing)throw Error('Demo startup cancelled');
 const consoleChild=child(join(root,'scripts/demo-console-process.mjs'),['--config',config,'--local-game-directory',directory,'--provider','offline','--console','0','--console-web-root',join(root,'packages/client/agent-console-public')]);
 let output='';const consoleURL=await ready(consoleChild,chunk=>{output+=String(chunk);if(output.length>4096)throw Error('Invalid startup output');return output.match(/^http:\/\/127\.0\.0\.1:\d+\/?$/m)?.[0]??null;},'data');
 const configured=ready(game,value=>value?.kind==='configured'?value:null);game.send({kind:'console',url:new URL(consoleURL).href});await configured;
 const result={kind:'ready',synthetic:true,mode:'live',provider:'offline',instances:8,playerURL:gameReady.url,consoleURL:new URL(consoleURL).href,demoURL:gameReady.url+'/demo',directory,pids:children.map(c=>c.pid)};
 process.stdout.write(`Synthetic test only. No production data or model calls.\nOpen ${result.demoURL}\nConsole ${result.consoleURL}\nPress Ctrl-C to stop and remove temporary data.\n`);
 process.send?.(result);
 await Promise.all(children.map(c=>c.exitCode!==null||c.signalCode!==null?Promise.resolve():once(c,'exit')));
 await stop();
}catch{process.stderr.write('Could not start isolated demo. Run npm run web:build, then retry.\n');process.exitCode=1;await stop();}
