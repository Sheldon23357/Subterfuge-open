import {request as httpRequest} from 'node:http';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {access,readFile,mkdtemp,mkdir,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';

type Ready={kind:string;demoURL:string;playerURL:string;consoleURL:string;directory:string;pids:number[];instances:number;provider:string;mode:string};
async function start(){
 const child=fork(resolve('scripts/start-agent-demo.mjs'),[],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH??'',OPENAI_API_KEY:'must-not-be-inherited'}});let output='';child.stdout!.on('data',c=>output+=c);child.stderr!.on('data',c=>output+=c);
 const ready=await new Promise<Ready>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Demo ready timeout')),20000);child.once('message',value=>{clearTimeout(timer);resolve(value as Ready);});child.once('exit',()=>{clearTimeout(timer);reject(Error('Launcher exited: '+output));});});return{child,ready,output:()=>output};
}
async function absent(ready:Ready){const deadline=Date.now()+8000;while(Date.now()<deadline){const ports=await Promise.all([ready.playerURL,ready.consoleURL].map(url=>fetch(url).then(()=>true,()=>false)));const exists=await access(ready.directory).then(()=>true,()=>false);if(!ports.some(Boolean)&&!exists)return;await new Promise(r=>setTimeout(r,50));}throw Error('Demo processes or files survived shutdown');}
async function stop(child:ChildProcess){if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');if(child.connected)child.send({kind:'stop'});else child.kill('SIGTERM');await exit;}}

test('disposable launcher is empty/offline, protects synthetic identity landing and cleans normal exit',async()=>{
 const {child,ready,output}=await start();
 try{
  assert.equal(ready.kind,'ready');assert.equal(ready.instances,8);assert.equal(ready.mode,'live');assert.equal(ready.provider,'offline');assert.equal(ready.pids.length,2);
  const page=await fetch(ready.demoURL),html=await page.text();assert.equal(page.status,200);assert.equal(page.headers.get('cache-control'),'no-store');assert.ok(html.includes('合成测试'));
  const tokens=[...html.matchAll(/>([a-f0-9]{64})<\/textarea>/g)].map(m=>m[1]!);assert.equal(tokens.length,2);for(const token of tokens)assert.equal(output().includes(token),false);
  assert.equal(await new Promise<number|undefined>((resolve,reject)=>{const request=httpRequest(ready.demoURL,{headers:{Host:'evil.invalid'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();}),403);assert.equal((await fetch(ready.demoURL,{headers:{Origin:'https://evil.invalid'}})).status,403);
  assert.equal((await fetch(ready.playerURL+'/player/v2/owner/control',{headers:{authorization:`Bearer ${tokens[0]}`}})).status,200);
  const config=JSON.parse(await readFile(join(ready.directory,'config.json'),'utf8'));assert.deepEqual(config.seats,[]);assert.ok(config.storeDirectory.startsWith(ready.directory));
  const consolePage=await fetch(ready.consoleURL),cookie=consolePage.headers.get('set-cookie')!.split(';')[0]!;
  const bootstrap=await(await fetch(ready.consoleURL+'api/agent/bootstrap',{headers:{cookie,'x-agent-console':'1'}})).json();
  const status=await(await fetch(ready.consoleURL+'api/agent/status',{headers:{cookie,'x-agent-csrf':bootstrap.csrf}})).json();assert.equal(status.provider,'offline');assert.equal(status.seats.length,8);assert.ok(status.seats.every((s:{bound:boolean})=>!s.bound));
 }finally{await stop(child);}await absent(ready);
});

test('demo supervisor cleans sibling failure and children exit when parent disappears',async()=>{
 for(const mode of ['child','parent']){
  const {child,ready}=await start();
  try{const exited=once(child,'exit');if(mode==='child')process.kill(ready.pids[0]!,'SIGKILL');else child.kill('SIGKILL');await exited;await absent(ready);}
  finally{await stop(child);for(const pid of ready.pids)try{process.kill(pid,'SIGKILL');}catch{}}
 }
});


test('launcher startup failure removes its newly created temporary data',async()=>{
 const sandbox=await mkdtemp(join(tmpdir(),'agent-demo-startup-test-'));
 try{
  for(const directory of ['scripts','dist/packages/server/src','dist/packages/ai/src/application','packages/client/public','packages/client/agent-console-public'])await mkdir(join(sandbox,directory),{recursive:true});
  await copyFile('scripts/start-agent-demo.mjs',join(sandbox,'scripts/start-agent-demo.mjs'));
  await writeFile(join(sandbox,'dist/packages/server/src/dev-agent-game.js'),"require('node:fs').writeFileSync('created-directory',process.env.SUBTERFUGE_DEMO_DIRECTORY);process.exit(23);");
  for(const path of ['dist/packages/ai/src/application/agent-cli.js','packages/client/public/player.js','packages/client/agent-console-public/agent-console.js'])await writeFile(join(sandbox,path),'');
  const child=fork(join(sandbox,'scripts/start-agent-demo.mjs'),[],{stdio:['ignore','ignore','ignore','ipc']});
  const [code]=await once(child,'exit');assert.equal(code,1);
  const directory=await readFile(join(sandbox,'created-directory'),'utf8');await assert.rejects(access(directory));
 }finally{await rm(sandbox,{recursive:true,force:true});}
});
