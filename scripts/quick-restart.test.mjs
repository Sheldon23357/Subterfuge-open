import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {prepareBuild,verifyBuild} from './dev-build-cache.mjs';
import {restart,parseOptions,request,waitFor,modelTurnEvidence,windowsPlatform,cleanupLocks} from './quick-restart.mjs';

const quiet=()=>{};
async function removeFixture(root) {
  assert.equal(dirname(resolve(root)),resolve(tmpdir()));
  assert.ok(basename(root).startsWith('subterfuge-restart-'));
  await rm(root,{recursive:true,force:true});
}
async function fixture(t,cleanup=true) {
  const root=await mkdtemp(join(tmpdir(),'subterfuge-restart-'));
  if(cleanup)t.after(()=>removeFixture(root));
  return root;
}
async function put(root,name,value) {
  await mkdir(resolve(root,name,'..'),{recursive:true});await writeFile(join(root,name),value);
}
test('build receipt reuses identical output and rejects changed/deleted artifacts or source',async t=>{
  const root=await fixture(t),receipt=join(root,'runtime','receipt.json');
  for(const dir of ['scripts','tests','protocol','packages/example/src'])await mkdir(join(root,dir),{recursive:true});
  for(const file of ['dev-build-cache.mjs','build-web.mjs','build-agent-console.mjs','check-boundaries.mjs','generate-diplomacy-wire.mjs'])await put(root,'scripts/'+file,'// fixture');
  for(const file of ['package.json','package-lock.json','tsconfig.json','packages/example/package.json',
    'node_modules/typescript/package.json','node_modules/esbuild/package.json'])await put(root,file,'{}');
  await put(root,'packages/example/src/main.ts','export const value=1;');
  let builds=0;
  const build=async()=>{
    builds++;
    for(const file of ['dist/packages/server/src/main.js','dist/packages/ai/src/application/agent-cli.js',
      'packages/client/public/app.js','packages/client/agent-console-public/agent-console.js'])await put(root,file,'built '+builds);
  };
  assert.equal((await prepareBuild(root,receipt,build)).cached,false);
  assert.equal((await prepareBuild(root,receipt,build)).cached,true);assert.equal(builds,1);
  await put(root,'scripts/quick-restart.mjs','// orchestration change');
  assert.equal((await prepareBuild(root,receipt,build)).cached,true);assert.equal(builds,1);
  await put(root,'packages/example/src/main.ts','export const value=2;');
  await assert.rejects(verifyBuild(root,receipt),/stale/);
  await prepareBuild(root,receipt,build);assert.equal(builds,2);
  await put(root,'dist/packages/server/src/main.js','tampered');
  await assert.rejects(verifyBuild(root,receipt),/stale/);
  await prepareBuild(root,receipt,build);assert.equal(builds,3);
  await rm(join(root,'packages/client/public/app.js'));
  await assert.rejects(verifyBuild(root,receipt));
  await assert.rejects(prepareBuild(root,receipt,async()=>{
    await build();await put(root,'packages/example/src/main.ts','changed while compiling');
  }),/Source changed/);
});
test('options preserve a room unless new-game is explicit',()=>{
  assert.equal(parseOptions([]).newGame,false);
  assert.equal(parseOptions(['--new-game','--bots','6','--provider','minimax']).bots,6);
  assert.equal(parseOptions(['--new-game','--provider','existing']).provider,'existing');
  assert.throws(()=>parseOptions(['--bots','6']),/require --new-game/);
  assert.throws(()=>parseOptions(['--game-port','4400']),/duplicate ports/);
  assert.throws(()=>parseOptions(['--dry-run','--dry-run']),/Duplicate/);
});

test('checkpoint reads tolerate temporary synchronous export timeouts without retrying writes or hiding failures',async()=>{
 let reads=0;
 assert.equal(await waitFor('checkpoint',async()=>{if(++reads===1)throw Error('Local API timeout');return 'completed';},{retryReadTimeout:true,intervalMs:1,log:quiet}),'completed');
 assert.equal(reads,2);
 await assert.rejects(waitFor('ordinary request',async()=>{throw Error('Local API timeout');},{intervalMs:1,log:quiet}),/Local API timeout/);
 await assert.rejects(waitFor('checkpoint',async()=>{throw Error('HTTP 500');},{retryReadTimeout:true,intervalMs:1,log:quiet}),/HTTP 500/);
 await assert.rejects(waitFor('checkpoint',async()=>{throw Error('Local API timeout');},{retryReadTimeout:true,timeoutMs:5,intervalMs:1,log:quiet}),/timed out/);
});
test('model verification distinguishes completed returns from publication and excludes rejected or unfinished calls',()=>{
 const since='2026-10-31T00:00:00Z',call={lane:'strategy',outcome:'completed',processingStatus:'completed',finishedAt:'2026-10-31T00:00:01Z',usage:{totalTokens:100},callPhase:'publication'};
 assert.deepEqual(modelTurnEvidence([call,{...call,processingStatus:'superseded'},{...call,processingStatus:'stale-dependency'},{...call,callPhase:'transport'}],since),{count:4,published:1,unpublished:3});
 const invalid=[{outcome:'running'},{outcome:'interrupted-unconfirmed'},{processingStatus:'running'},{processingStatus:'failed'},{validationError:'invalid task'},{error:'provider failed'},{usage:{totalTokens:null}},{finishedAt:'2026-10-30T00:00:00Z'},{finishedAt:'bad-date'},{lane:'commander'}];
 assert.deepEqual(modelTurnEvidence(invalid.map(overrides=>({...call,...overrides})),since),{count:0,published:0,unpublished:0});
 assert.deepEqual(modelTurnEvidence([{...call,processingStatus:undefined,finishedAt:undefined,startedAt:Date.parse(call.finishedAt)}],since),{count:1,published:1,unpublished:0});
});
test('store cleanup refuses a live owner and retains unrelated files',async t=>{
  const root=await fixture(t),name='a'.repeat(64)+'.lock';
  await put(root,name,JSON.stringify({pid:process.pid}));
  await put(root,'game.sqlite','preserve');
  await assert.rejects(cleanupLocks(root),/live owner/);
  assert.equal(await readFile(join(root,'game.sqlite'),'utf8'),'preserve');
  assert.equal(JSON.parse(await readFile(join(root,name),'utf8')).pid,process.pid);
});
async function freePort() {
  const server=net.createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const port=server.address().port;await new Promise(done=>server.close(done));return port;
}
// This is a synthetic local service, with no game database or provider access.
const service=String.raw`
import http from 'node:http';import {readFileSync,writeFileSync} from 'node:fs';
const role=process.env.FIXTURE_ROLE,ports=JSON.parse(process.env.FIXTURE_PORTS),file=process.env.FIXTURE_STATE;
const read=()=>JSON.parse(readFileSync(file,'utf8')),save=s=>writeFileSync(file,JSON.stringify(s));
if(role==='agent'){const s=read();s.seats.forEach(s=>{s.enabled=false;s.owned=false;});save(s);}
const server=http.createServer(async(req,res)=>{
  const buffers=[];for await(const b of req)buffers.push(b);const body=buffers.length?JSON.parse(Buffer.concat(buffers)):null;
  const url=new URL(req.url,'http://localhost'),s=read();let out={};res.setHeader('Content-Type','application/json');
  if(role==='game'){
    if(url.pathname==='/api/state'){if(s.auto)s.tick++;out={commanderRoomId:s.room,tick:s.tick,realtime:false,outposts:[{name:'A'}],fleets:[],match:{ended:false},autoAdvance:{enabled:s.auto,error:null}};save(s);}
    else if(url.pathname==='/api/auto-advance'){s.auto=body.enabled;save(s);}
    else if(url.pathname==='/api/checkpoints'){
      if(body){s.checkpoint={id:'fixture-checkpoint',status:s.failCheckpoint?'failed':'completed'};save(s);}
      out={busy:false,job:s.checkpoint};
    }else if(url.pathname==='/api/new'){
      s.generation=(s.generation??0)+1;s.room='new-fixture-room-'+s.generation;s.tick=0;s.auto=false;s.bindings=body.controllerBindings;
      s.seats.forEach(seat=>{seat.bound=body.controllerBindings.some(b=>b.slot===seat.controllerSlot);seat.roomId=seat.bound?s.room:'';seat.enabled=false;seat.owned=false;});save(s);
      writeFileSync(process.env.LAB_DATA_DIR+'/controller-bindings.json',JSON.stringify({roomId:s.room,bindings:s.bindings}));
      writeFileSync(process.env.LAB_DATA_DIR+'/player-access.json',JSON.stringify({format:'player-access/1',roomId:s.room,credentials:body.controllerBindings.map(b=>({player:b.seat,token:'fixture-'+b.seat}))}));
      out={commanderRoomId:s.room,tick:0};
    }else{res.statusCode=404;}
  }else if(role==='player')out={roomId:s.room,player:Number(req.headers.authorization.split('-').at(-1)),mode:'manual'};
  else{
    if(url.pathname==='/'){res.setHeader('Set-Cookie','fixture=session');out='fixture';}
    else if(url.pathname==='/api/agent/bootstrap')out={csrf:'fixture-csrf'};
    else if(url.pathname==='/api/agent/status')out={seats:s.seats,jobs:s.jobs,modelQueue:{active:0,waiting:0}};
    else if(url.pathname==='/api/agent/config')out={seats:s.seats.map(({enabled,owned,calls,tokens,...seat})=>({...seat,settings:{mode:'hybrid',model:'MiniMax-Fixture'},providerConfig:{kind:'openai-compatible',preset:'minimax',model:'MiniMax-Fixture',hasKey:true,keySource:'environment'}}))};
    else if(url.pathname==='/api/agent/action'){
      const seat=s.seats.find(s=>s.id===body.id);seat.enabled=body.action==='start';seat.owned=seat.enabled;seat.started=Date.now();seat.polls=0;
      const job={id:'job-'+s.jobs.length,seat:seat.id,action:body.action,status:'completed'};s.jobs.push(job);save(s);out={job};res.statusCode=202;
    }else if(url.pathname==='/api/agent/debug/calls'){
      const seat=s.seats.find(s=>s.id===url.searchParams.get('seat'));seat.polls++;save(s);
      const completed=seat.polls>1&&(s.auto||s.room.startsWith('new-fixture-room'));
      out={entries:[{lane:'strategy',callPhase:'publication',outcome:completed?'completed':'running',processingStatus:completed?(seat.controllerSlot%2?'superseded':'completed'):'running',finishedAt:completed?new Date(seat.started+1).toISOString():null,usage:{totalTokens:completed?7:null}}]};
    }else if(url.pathname!=='/api/agent/connections/local')res.statusCode=404;
  }
  res.end(JSON.stringify(out));
});
server.listen(ports[role==='game'?0:role==='player'?1:2],'127.0.0.1');
if(role==='game'){
  const {spawn}=await import('node:child_process');
  const player=spawn(process.execPath,[process.argv[1]],{env:{...process.env,FIXTURE_ROLE:'player'},stdio:'inherit'});
  process.once('SIGTERM',()=>{player.kill();server.close();});
}
`;

test('isolated Windows lifecycle preserves intent, creates explicit six-bot tests and stops on checkpoint failure',
  {skip:process.platform!=='win32',timeout:180000},async t=>{
  const root=await fixture(t,false),ports=await Promise.all([freePort(),freePort(),freePort()]);
  assert.equal(new Set(ports).size,3);
  const data=join(root,'runtime','fixture'),store=join(data,'independent-agent'),stateFile=join(data,'fixture-state.json');
  await mkdir(store,{recursive:true});await mkdir(join(root,'scripts'),{recursive:true});
  await copyFile(new URL('./quick-restart-windows.ps1',import.meta.url),join(root,'scripts/quick-restart-windows.ps1'));
  const seats=Array.from({length:6},(_,i)=>({id:'ai-0'+(i+1),controllerSlot:i,lobbySeat:i,bound:true,roomId:'old-fixture-room',enabled:false,owned:false,busy:false,starting:false,stopping:false,error:null,calls:0,tokens:0}));
  const bindings=seats.map(s=>({seat:s.lobbySeat,slot:s.controllerSlot}));
  await put(root,'runtime/fixture/fixture-state.json',JSON.stringify({room:'old-fixture-room',tick:12,auto:false,seats,bindings,jobs:[],checkpoint:null}));
  await put(root,'runtime/fixture/controller-bindings.json',JSON.stringify({roomId:'old-fixture-room',bindings}));
  await put(root,'runtime/fixture/player-access.json',JSON.stringify({format:'player-access/1',roomId:'old-fixture-room',credentials:seats.map(s=>({player:s.lobbySeat,token:'fixture-'+s.lobbySeat}))}));
  for(const role of ['game','agent']) {
    const entry=role==='game'?'dist/packages/server/src/main.js':'dist/packages/ai/src/application/agent-cli.js';
    await put(root,entry,service);
    await put(root,'scripts/dev-'+(role==='game'?'web':'agent')+'.mjs',`import {spawn} from 'node:child_process';import {resolve} from 'node:path';const child=spawn(process.execPath,[resolve(${JSON.stringify(entry)}),...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,FIXTURE_ROLE:${JSON.stringify(role)}}});process.on('SIGTERM',()=>child.kill());child.on('exit',()=>process.exit());`);
  }
  const env={...process.env,FIXTURE_PORTS:JSON.stringify(ports),FIXTURE_STATE:stateFile,LAB_DATA_DIR:data};
  const children=[];
  // Game and player are kept as sibling listeners in the real app. For this fixture,
  // put the player listener inside the game PID to exercise the same ownership check.
  await put(root,'dist/packages/server/src/main.js',service.replace("const {spawn}=await import('node:child_process');\n  const player=spawn(process.execPath,[process.argv[1]],{env:{...process.env,FIXTURE_ROLE:'player'},stdio:'inherit'});\n  process.once('SIGTERM',()=>{player.kill();server.close();});",
    `http.createServer((req,res)=>{const s=read();res.end(JSON.stringify({roomId:s.room,player:Number(req.headers.authorization.split('-').at(-1)),mode:'manual'}));}).listen(ports[1],'127.0.0.1');`));
  for(const role of ['game','agent']) {
    const args=['scripts/dev-'+(role==='game'?'web':'agent')+'.mjs',...(role==='game'?[]:['--console',String(ports[2]),'--store-directory',store,'--local-game-directory',data,'--local-player-port',String(ports[1])])];
    children.push(spawn(process.execPath,args,{cwd:root,env,stdio:'ignore',windowsHide:true}));
  }
  const tracked=[];
  // Only fixture process trees are candidates, even on assertion failure.
  t.after(async()=>{
    // Rediscover by fixture path, rather than killing saved PIDs which Windows
    // might already have reused after one of the earlier restart cycles.
    const cleanup=join(root,'scripts','fixture-cleanup.ps1');
    await writeFile(cleanup,String.raw`param([string]$FixtureRoot)
$ErrorActionPreference='Stop'
$all=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")
$owned=@($all | Where-Object {$_.CommandLine -like "*$FixtureRoot*"})
$parents=@($all | Where-Object {$_.ProcessId -in $owned.ParentProcessId -and $_.CommandLine -match 'scripts/dev-(web|agent)\.mjs'})
foreach($target in @($parents)+@($owned)) {
  $live=Get-CimInstance Win32_Process -Filter "ProcessId = $($target.ProcessId)"
  if($live -and $live.CommandLine -ceq $target.CommandLine -and $live.CreationDate -eq $target.CreationDate){Stop-Process -Id $target.ProcessId -Force}
}`);
    await new Promise((done,reject)=>{const c=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',cleanup,'-FixtureRoot',root],{stdio:'ignore',windowsHide:true});c.once('exit',code=>code===0?done():reject(Error('Fixture cleanup failed')));c.once('error',reject);});
    await removeFixture(root);
  });
  await waitFor('fixture ready',async()=>{await request(ports[0],'/api/state');await request(ports[2],'/');return true;},{retryConnection:true,timeoutMs:10000,intervalMs:50,log:quiet});
  const dependencies={build:async()=>({cached:true}),verify:async()=>{},skipEnvironmentCheck:true,log:quiet,waitOptions:{intervalMs:20,timeoutMs:5000},
    platform:async(action,config)=>{const result=await windowsPlatform(action,config);if(action==='start')tracked.push(result.pid);return result;}};
  // Launches inherit these synthetic endpoints across PowerShell Start-Process.
  const oldEnv={FIXTURE_PORTS:process.env.FIXTURE_PORTS,FIXTURE_STATE:process.env.FIXTURE_STATE};
  process.env.FIXTURE_PORTS=env.FIXTURE_PORTS;process.env.FIXTURE_STATE=stateFile;
  t.after(()=>{for(const [k,v] of Object.entries(oldEnv))if(v===undefined)delete process.env[k];else process.env[k]=v;});
  let state=JSON.parse(await readFile(stateFile,'utf8'));state.seats[0].enabled=true;state.seats[0].owned=true;state.seats[2].enabled=true;state.seats[2].owned=true;await writeFile(stateFile,JSON.stringify(state));
  const options={...parseOptions([]),root,ports};
  const dry=await restart({...options,dryRun:true},dependencies);assert.equal(dry.passed,true);
  assert.deepEqual(dry.plan.resume,['ai-01','ai-03']);
  const restored=await restart(options,dependencies);tracked.push(restored.gameProcess.pid,restored.agentProcess.pid);
  assert.equal(restored.passed,true);assert.equal(restored.game.room,'old-fixture-room');assert.equal(restored.game.tick,12);
  assert.equal(restored.completedCalls.modelWait,'not-required-while-game-paused');
  state=JSON.parse(await readFile(stateFile,'utf8'));assert.deepEqual(state.seats.filter(s=>s.enabled).map(s=>s.id),['ai-01','ai-03']);
  const fresh=await restart({...options,newGame:true},dependencies);tracked.push(fresh.gameProcess.pid,fresh.agentProcess.pid);
  assert.equal(fresh.passed,true);assert.equal(fresh.game.room,'new-fixture-room-1');assert.ok(fresh.game.tick>0);
  assert.equal(fresh.completedCalls.models.length,6);assert.ok(fresh.completedCalls.models.every(c=>c.count===1));
  assert.equal(fresh.completedCalls.models.filter(c=>c.published===0&&c.unpublished===1).length,3);
  state=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(state.seats.filter(s=>s.enabled).length,6);
  const advancing=await restart(options,dependencies);tracked.push(advancing.gameProcess.pid,advancing.agentProcess.pid);
  assert.equal(advancing.game.room,fresh.game.room);assert.equal(advancing.completedCalls.models.length,6);
  const existing=await restart({...options,newGame:true,provider:'existing'},dependencies);tracked.push(existing.gameProcess.pid,existing.agentProcess.pid);
  assert.equal(existing.passed,true);assert.equal(existing.game.room,'new-fixture-room-2');assert.equal(existing.completedCalls.models.length,6);
  state=JSON.parse(await readFile(stateFile,'utf8'));
  state.failCheckpoint=true;await writeFile(stateFile,JSON.stringify(state));
  await assert.rejects(restart(options,dependencies),/checkpoint failed/);
  assert.equal((await request(ports[2],'/api/agent/status')).data.seats.length,6,'checkpoint failure must leave services alive');
});
