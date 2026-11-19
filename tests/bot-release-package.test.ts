import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,cpSync,existsSync,chmodSync,statSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {protocolHarness} from './player-protocol-test-helpers.js';
import {createPlayerProtocolApi} from '../packages/server/src/player-protocol-api.js';
import {PlayerProtocolCoordinator} from '../packages/server/src/player-protocol-coordinator.js';
import {SerialExecutor} from '../packages/server/src/player-access.js';
import {ChatStore} from '../packages/server/src/chat.js';
import {CommanderStore} from '../packages/server/src/commander-store.js';

const run=(args:string[],cwd=process.cwd())=>{const r=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:120000});assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
async function start(args:string[],cwd:string,env:NodeJS.ProcessEnv){
 const child=spawn(process.execPath,args,{cwd,env,stdio:['ignore','pipe','pipe']});let output='';
 const url=await new Promise<string>((done,reject)=>{const timeout=setTimeout(()=>{child.kill();reject(Error('Host startup timeout: '+output));},20000);child.stdout!.on('data',data=>{output+=data;const found=output.match(/http:\/\/127\.0\.0\.1:\d+\//);if(found){clearTimeout(timeout);done(found[0]);}});child.stderr!.on('data',data=>output+=data);child.once('exit',code=>{clearTimeout(timeout);reject(Error('Host exited '+code+': '+output));});});
 return {child,url};
}
async function stop(child:ChildProcess,storeDirectory?:string){
 if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
 // Windows forcefully terminates Node instead of invoking its SIGTERM hook.
 // launch.mjs starts a host child: the lock records the host PID, not the launcher.
 if(process.platform==='win32'&&storeDirectory&&existsSync(storeDirectory)){
  assert.ok(resolve(storeDirectory).startsWith(resolve(tmpdir())+'\\'));
  if(child.pid){assert.throws(()=>process.kill(child.pid!,0),(e:unknown)=>(e as NodeJS.ErrnoException).code==='ESRCH');}
  for(const name of readdirSync(storeDirectory).filter(n=>/^[a-f0-9]{64}\.lock$/.test(n))){
   const file=join(storeDirectory,name),lock=JSON.parse(readFileSync(file,'utf8'));
   assert.ok(Number.isSafeInteger(lock.pid)&&lock.pid>0);
   const deadline=Date.now()+2000;
   let gone=false;
   while(Date.now()<deadline){
    try{process.kill(lock.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH'){gone=true;break;}throw error;}
    await new Promise(done=>setTimeout(done,25));
   }
   assert.ok(gone,'Temporary fixture host must exit before its lock can be removed');
   rmSync(file);
  }
 }
}
async function api(url:string){const home=await fetch(url),cookie=home.headers.get('set-cookie')!.split(';')[0]!,boot=await fetch(new URL('api/agent/bootstrap',url),{headers:{cookie,'x-agent-console':'1'}}).then(r=>r.json()) as {csrf:string};return async(path:string,body?:unknown)=>{const r=await fetch(new URL('api/agent/'+path,url),{method:body===undefined?'GET':'POST',headers:{cookie,origin:new URL(url).origin,'x-agent-csrf':boot.csrf,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const d=await r.json();assert.ok(r.ok,JSON.stringify(d));return d;};}
async function until(check:()=>Promise<boolean>){const deadline=Date.now()+20000;while(Date.now()<deadline){if(await check())return;await new Promise(done=>setTimeout(done,100));}assert.fail('Host did not finish its first round');}

test('bot release runs outside the repo, supplies editable full hybrid and offline SDK/compiler without a strategy in the host', {timeout:180000},async t=>{
 const temporary=mkdtempSync(join(tmpdir(),'bot-release-')),output=join(temporary,'build'),foreign=join(temporary,'foreign');t.after(()=>rmSync(temporary,{recursive:true,force:true}));
 run(['scripts/build-bot-release.mjs','--out',output,'--no-archive']);cpSync(output,foreign,{recursive:true});
 assert.ok(!existsSync(join(foreign,'node_modules')));assert.ok(!existsSync(join(foreign,'packages')));
 const info=JSON.parse(readFileSync(join(foreign,'BUILD-INFO.json'),'utf8'));
 assert.ok(info.hostInputs.every((f:string)=>!f.startsWith('plugins/')&&!f.startsWith('packages/server/')&&!f.endsWith('/reference.ts')));
 const source=join(foreign,'plugins/hybrid/src');assert.equal(readdirSync(source).filter(f=>f.endsWith('.ts')).length,58);
 for(const f of ['background.ts','prompts.ts','publication.ts','planning.ts','execution-guard.ts'])assert.ok(existsSync(join(source,f)));
 assert.ok(info.sdk.declarations>100);assert.equal(info.sdk.entries,35);
 const developerGuide=readFileSync(join(foreign,'DEVELOPING.md'),'utf8');
 for(const term of ['BotModeDefinition','strategyConfig','services.model.step','onReceipt','AbortSignal','executionObservation','examples/minimal-bot/'])assert.ok(developerGuide.includes(term),term);
 const minimal=join(foreign,'examples/minimal-bot');
 assert.equal(JSON.parse(readFileSync(join(minimal,'bot-plugin.json'),'utf8')).id,'minimal-bot');
 assert.equal(JSON.parse(run([join(foreign,'tools/check-plugin.mjs'),minimal],temporary)).valid,true);
 assert.ok((statSync(join(foreign,'runtime/agent-cli.mjs')).mode&0o222)===0);
 const checked=run([join(foreign,'tools/check-plugin.mjs'),join(foreign,'plugins/hybrid')],temporary);assert.match(checked,/"valid":true/);
 const original=readFileSync(join(source,'plugin.ts'),'utf8');
 writeFileSync(join(source,'plugin.ts'),original+'\nconst invalid: number = "must fail";\n');
 const bad=spawnSync(process.execPath,[join(foreign,'tools/check-plugin.mjs'),join(foreign,'plugins/hybrid')],{cwd:temporary,encoding:'utf8',timeout:30000});assert.notEqual(bad.status,0);assert.match(bad.stdout+bad.stderr,/not assignable/);
 // An editable plugin changes the actual loaded instance without rebuilding or editing the host.
 writeFileSync(join(source,'plugin.ts'),"import {hybridDefinition} from './index.js';\nexport default {...hybridDefinition,create:(config:unknown)=>({...hybridDefinition.create(config),diagnostics:()=>({strategyDetails:{releaseTest:'edited-source'}})})};\n");
 assert.match(run([join(foreign,'tools/check-plugin.mjs'),join(foreign,'plugins/hybrid')],temporary),/"valid":true/);
 const cleanups:(()=>void)[]=[],h=protocolHarness({after:(f:()=>void)=>cleanups.push(f)} as unknown as TestContext);h.elapsed+=31000;
 const grant=h.grant(0,['observe','events.read','commands.write','control.lease','chat.send','commander.worker']);
 const chat=new ChatStore(join(h.dir,'chat.json'));await chat.load();const commander=new CommanderStore(join(h.dir,'commander.json'));await commander.load();
 const coordinator=new PlayerProtocolCoordinator(h.repository,{roomId:()=> 'fixture-room',load:()=>h.store.load()!.room});await coordinator.bindDomains(chat,commander);coordinator.refreshWorld();
 const server=createPlayerProtocolApi({repository:h.repository,roomId:'fixture-room',serial:new SerialExecutor(),load:()=>h.store.load()!,commit:(room,revision)=>{const next=h.store.commit(room,revision);coordinator.refreshWorld();return next;},chat:()=>chat,commander,capabilities:()=>coordinator.capabilities(),snapshot:p=>coordinator.snapshot(p),instructionsVersion:p=>coordinator.instructionsVersion(p)});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 let active:ChildProcess|undefined;t.after(async()=>{if(active)await stop(active,join(temporary,'state'));server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));for(const cleanup of cleanups)cleanup();});
 const config=join(temporary,'seats.json');writeFileSync(config,JSON.stringify({storeDirectory:join(temporary,'state'),pollMs:1000,seats:[{id:'sample',serverUrl:'http://127.0.0.1:'+address.port,roomId:'fixture-room',lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:h.store.load()!.room.state.economy.players.length,tokenEnv:'SYNTHETIC_TOKEN',settings:{mode:'hybrid',provider:'offline',model:'',personality:'schemer'}}]}));
 let started=await start([join(foreign,'launch.mjs'),'--config',config,'--console','0'],temporary,{PATH:process.env.PATH,NO_PROXY:'127.0.0.1',SYNTHETIC_TOKEN:grant.token});active=started.child;
 let request=await api(started.url);assert.equal((await request('plugins')).plugins.length,1);assert.equal((await request('config')).strategies[0].id,'hybrid');
 assert.equal((await request('debug/live?seat=sample')).strategyDetails.releaseTest,'edited-source');
 await request('action',{id:'sample',action:'start'});
 await until(async()=>{const status=await request('status');assert.equal(status.seats[0].error,null);return h.store.load()!.room.state.commands.length>0;});
 await request('action',{id:'sample',action:'pause'});await until(async()=>!(await request('status')).seats[0].enabled);
 const commands=h.store.load()!.room.state.commands.length;assert.ok(commands>0);assert.equal((await request('status')).seats[0].calls,0);
 await stop(active,join(temporary,'state'));active=undefined;
 // Restoring an installed snapshot does not execute a new source edit or replay a game order.
 writeFileSync(join(source,'plugin.ts'),'throw Error("source edit requires explicit reload");');
 started=await start([join(foreign,'launch.mjs'),'--config',config,'--console','0'],temporary,{PATH:process.env.PATH,NO_PROXY:'127.0.0.1',SYNTHETIC_TOKEN:grant.token});active=started.child;request=await api(started.url);
 assert.equal((await request('debug/live?seat=sample')).strategyDetails.releaseTest,'edited-source');assert.equal((await request('status')).seats[0].enabled,false);assert.equal(h.store.load()!.room.state.commands.length,commands);
 await stop(active,join(temporary,'state'));active=undefined;
 // A new store with broken default source cannot silently fall back to a compiled strategy.
 const brokenConfig=join(temporary,'broken-seats.json'),brokenSettings=JSON.parse(readFileSync(config,'utf8'));brokenSettings.storeDirectory=join(temporary,'broken-state');writeFileSync(brokenConfig,JSON.stringify(brokenSettings));
 started=await start([join(foreign,'launch.mjs'),'--config',brokenConfig,'--console','0'],temporary,{PATH:process.env.PATH,NO_PROXY:'127.0.0.1',SYNTHETIC_TOKEN:grant.token});active=started.child;request=await api(started.url);
 assert.ok((await request('plugins')).plugins.some((p:{id:string;error?:string})=>p.id==='hybrid'&&p.error));await request('action',{id:'sample',action:'start'});await until(async()=>(await request('status')).jobs.some((j:{status:string})=>j.status==='failed'));
 assert.equal((await request('status')).seats[0].enabled,false);assert.equal(h.store.load()!.room.state.commands.length,commands);await stop(active,join(temporary,'state'));active=undefined;
 const fixed=join(foreign,'runtime/agent-cli.mjs');chmodSync(fixed,0o644);writeFileSync(fixed,readFileSync(fixed,'utf8')+'\n// changed\n');
 const tampered=spawnSync(process.execPath,[join(foreign,'launch.mjs'),'--console','0'],{cwd:temporary,encoding:'utf8',timeout:10000});assert.notEqual(tampered.status,0);assert.match(tampered.stderr,/Host file changed/);
});
