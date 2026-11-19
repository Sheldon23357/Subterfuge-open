import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {AgentRuntime} from './helpers/scripted-controller.js';
import {parseAgentConfig,type AgentProvider} from '../packages/ai/src/index.js';
import {controllerSynchronizer} from '../packages/ai/src/application/controller-sync.js';
import {controllerCheckpoints} from '../packages/ai/src/application/controller-checkpoint.js';
import {saveControllerBindings} from '../packages/server/src/controller-bindings.js';
import {verifyLinkedCheckpoint,LinkedCheckpoints} from '../packages/server/src/linked-checkpoints.js';
import {restoreLinkedCheckpoint} from '../packages/server/src/checkpoint-restore.js';
import {RoomStore} from '../packages/server/src/room-store.js';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {registerTestExecutor} from './player-protocol-test-helpers.js';
import {ProtocolPlayerGateway} from '../packages/ai/src/controller/transport/protocol-gateway.js';

async function freePort(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until(check:()=>Promise<boolean>,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await sleep(30);}throw Error('Test condition timed out');}
async function providerStarted(started:Promise<void>,turn:Promise<unknown>,output:()=>string){
 await Promise.race([started,turn.then(()=>{throw Error('AI turn ended before the test provider started: '+output());})]);
}
async function stop(child:ChildProcess){if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}}
async function game(directory:string,port:number,playerPort:number,realtime=false){
 const child=fork(fileURLToPath(new URL('../packages/server/src/main.js',import.meta.url)),[],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,LAB_DATA_DIR:directory,LAB_PORT:String(port),PLAYER_PORT:String(playerPort),GAME_CLOCK:realtime?'realtime':'manual',LAB_LEGACY_FIXTURE:'1',NO_PROXY:'127.0.0.1,localhost'}});
 let output='';child.stdout!.on('data',c=>output+=c);child.stderr!.on('data',c=>output+=c);
 const base=`http://127.0.0.1:${port}`;
 try{await until(async()=>{if(child.exitCode!==null)throw Error(output);return fetch(base+'/api/state').then(r=>r.ok,()=>false);});}catch(e){await stop(child);throw e;}
 return {child,base,output:()=>output,post:(path:string,body:unknown)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),status:async()=>await(await fetch(base+'/api/checkpoints')).json()};
}

test('linked snapshot drains an in-flight AI turn, rejects new writes, preserves logs and restores the whole stage',{timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linked-stage-')),port=await freePort(),playerPort=await freePort();
 let server=await game(directory,port,playerPort),runtime:AgentRuntime|undefined,timer:ReturnType<typeof setInterval>|undefined;
 let release=()=>{},entered=()=>{};const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let calls=0;
 const provider:AgentProvider={step:async request=>{calls++;if(calls===1){entered();await gate;return {reply:{tool:'order',arguments:{action:{kind:'set-shields',outpostId:JSON.parse(request.prompt).snapshot.observation.outpostNames[JSON.parse(request.prompt).snapshot.observation.view.outposts.find((p:{owner:number})=>p.owner===0).id],enabled:false}},summary:'finish existing write'},tokens:0};}return {reply:{tool:'finish',arguments:{},summary:'settled'},tokens:0};}};
 try{
  const access=JSON.parse(await readFile(join(directory,'player-access.json'),'utf8'));
  const bindings=[{seat:0,slot:0}];await saveControllerBindings(directory,access.roomId,bindings);
  runtime=new AgentRuntime(parseAgentConfig({storeDirectory:join(directory,'ai'),seats:[{id:'ai-01',serverUrl:`http://127.0.0.1:${playerPort}`,roomId:access.roomId,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:8,tokenEnv:'TOKEN',ownerCredential:true,settings:{model:'',personality:'schemer'}}]}),provider,{TOKEN:access.credentials[0].token},{fixedSlots:true,profilesPath:join(directory,'ai','profiles.json')});
  const sync=controllerSynchronizer(runtime,directory,playerPort);await sync();
  const checkpoints=controllerCheckpoints(runtime,directory);timer=setInterval(()=>void checkpoints().catch(()=>{}),25);
  await runtime.start('ai-01');const turn=runtime.tick();await providerStarted(started,turn,()=>server.output()+JSON.stringify({status:runtime!.status(),logs:runtime!.consoleLogs('ai-01')}));
  const before=await(await fetch(server.base+'/api/state')).json();
  await server.post('auto-advance',{enabled:true});
  const response=await server.post('checkpoints',{name:'进攻前'});assert.equal(response.status,202);const job=await response.json();
  await until(async()=>runtime!.checkpointActive);
  assert.equal((await server.status()).job.status,'waiting');
  assert.equal((await server.post('step',{ticks:1})).status,400);
  assert.equal((await server.post('checkpoints',{})).status,400);
  const manual=await fetch(`http://127.0.0.1:${playerPort}/player/v2/owner/chat`,{method:'POST',headers:{Authorization:`Bearer ${access.credentials[1].token}`},body:JSON.stringify({id:'during-save',to:null,text:'must reject'})});assert.equal(manual.status,409);
  const blockedDiscussion=await fetch(`http://127.0.0.1:${playerPort}/player/v2/owner/commander/messages`,{method:'POST',headers:{Authorization:`Bearer ${access.credentials[0].token}`},body:JSON.stringify({id:'during-checkpoint',text:'不要在保存时加入讨论。',references:[]})});assert.equal(blockedDiscussion.status,409);
  assert.throws(()=>runtime!.configureSeat('ai-02',{kind:'offline'},{model:'',personality:'schemer'}),/存档/);
  release();await turn;
  await until(async()=>!(await server.status()).busy);
  const result=await server.status();assert.equal(result.job.status,'completed',JSON.stringify(result));assert.equal(result.job.warning,undefined,JSON.stringify({seats:runtime.status(),response:JSON.parse(await readFile(join(directory,'checkpoint-response.json'),'utf8')),game:server.output()}));
  const saved=join(directory,'checkpoints',job.job.id),manifest=await verifyLinkedCheckpoint(saved);
  assert.equal(manifest.name,'进攻前');assert.equal(manifest.tick,before.tick);assert.equal(manifest.autoAdvance,true);assert.deepEqual(manifest.bindings,bindings);assert.equal(calls,2);
  const db=new RoomStore(join(saved,'game','subterfuge.sqlite'),{readOnly:true});try{assert.ok(!db.load()!.room.state.commands.some(c=>c.action.kind==='set-shields'));}finally{db.close();}
  assert.ok(manifest.files.some(f=>/^ai\/[a-f0-9]{64}\.sqlite$/.test(f.path)));assert.ok(!manifest.files.some(f=>/wal|shm|lock/.test(f.path)));
  const controller=JSON.parse(await readFile(join(saved,'ai','controller.json'),'utf8'));assert.deepEqual(controller.resume,['ai-01']);
  const ai=new DatabaseSync(join(saved,'ai',controller.seats[0].store),{readOnly:true});try{
   assert.equal(JSON.parse(String(ai.prepare('SELECT payload FROM seats WHERE room=? AND seat=?').get(access.roomId,0)!.payload)).calls,0);
   assert.ok(ai.prepare("SELECT 1 FROM journal WHERE room=? AND seat=0 AND kind='tool-rejected' AND json_extract(payload,'$.result.httpStatus')=409").get(access.roomId),'the checkpoint must retain the rejected write even outside the console first page');
  }finally{ai.close();}
  assert.equal(runtime.status()[0]!.enabled,true);assert.equal(runtime.status()[0]!.owned,true);
  await runtime.tick();assert.equal(calls,2,'saving must not trigger a fresh model decision');
  assert.equal((await(await fetch(server.base+'/api/state')).json()).autoAdvance.enabled,true);
  await assert.rejects(restoreLinkedCheckpoint(saved,join(saved,'..fake')),/内部/);
  const restored=join(directory,'restored');await restoreLinkedCheckpoint(saved,restored);await assert.rejects(restoreLinkedCheckpoint(saved,restored),/exist/i);
  assert.deepEqual(JSON.parse(await readFile(join(restored,'player-access.json'),'utf8')),access);
  clearInterval(timer);timer=undefined;await runtime.shutdown();runtime=undefined;await stop(server.child);
  server=await game(restored,port,playerPort);
  const restoredState=await(await fetch(server.base+'/api/state')).json();assert.equal(restoredState.tick,manifest.tick);assert.equal(restoredState.autoAdvance.enabled,false);
  runtime=new AgentRuntime(parseAgentConfig({storeDirectory:join(restored,'independent-agent'),seats:[]}),provider,{},{fixedSlots:true,profilesPath:join(restored,'independent-agent','controller-slots.json')});
  await controllerSynchronizer(runtime,restored,playerPort)();assert.equal(runtime.status()[0]!.calls,0);assert.equal(runtime.status()[0]!.enabled,false);
  // A corrupt component cannot be restored or overwrite an existing directory.
  await writeFile(join(saved,'game','player-access.json'),'corrupt');await assert.rejects(verifyLinkedCheckpoint(saved),/校验/);
  await assert.rejects(restoreLinkedCheckpoint(saved,join(directory,'bad-restore')),/校验/);assert.ok(!(await readdir(directory)).includes('bad-restore'));
 }finally{release();if(timer)clearInterval(timer);if(runtime?.checkpointActive)await runtime.releaseCheckpoint().catch(()=>{});await runtime?.shutdown();await stop(server.child);await rm(directory,{recursive:true,force:true});}
});

test('unavailable bound controller fails without publishing a snapshot and restores the clock switch',{timeout:30000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linked-missing-')),server=await game(directory,await freePort(),await freePort());
 try{
  const access=JSON.parse(await readFile(join(directory,'player-access.json'),'utf8'));await saveControllerBindings(directory,access.roomId,[{seat:0,slot:0}]);
  await server.post('auto-advance',{enabled:true});assert.equal((await server.post('checkpoints',{})).status,202);
  await until(async()=>!(await server.status()).busy);const status=await server.status();assert.equal(status.job.status,'failed');assert.match(status.job.error,/控制器未在线/);assert.deepEqual(status.entries,[]);
  assert.equal((await(await fetch(server.base+'/api/state')).json()).autoAdvance.enabled,true);
  assert.equal((await server.post('step',{ticks:1})).status,200);
 }finally{await stop(server.child);await rm(directory,{recursive:true,force:true});}
});

test('a copy failure never publishes a usable stage and always releases the write barrier',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linked-copy-failure-'));let frozen=false,finished=false;
 const job=new LinkedCheckpoints({directory,begin:async()=>({roomId:'room',bindings:[],autoAdvance:false,frozenAt:Date.now()}),drain:async()=>[],freeze:async task=>{frozen=true;return task({tick:1,revision:1});},backupGame:async()=>{throw Error('disk full');},thaw:async()=>{frozen=false;},finish:()=>{finished=true;}});
 try{job.start({name:'failure'});await until(async()=>!job.status().busy);assert.equal(job.status().job!.status,'failed');assert.match(job.status().job!.error!,/disk full/);assert.equal(frozen,false);assert.equal(finished,true);assert.deepEqual(await job.list(),[]);}finally{await rm(directory,{recursive:true,force:true});}
});

test('realtime restore rebases its saved phase instead of catching up from the original save time',{timeout:30000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linked-clock-')),server=await game(directory,await freePort(),await freePort(),true);
 try{
  await server.post('checkpoints',{name:'clock'});await until(async()=>!(await server.status()).busy);
  const status=await server.status();assert.equal(status.job.status,'completed',JSON.stringify(status));const source=join(directory,'checkpoints',status.job.id),manifest=await verifyLinkedCheckpoint(source);
  const target=join(directory,'restored');await restoreLinkedCheckpoint(source,target);
  // Simulate a snapshot saved two game ticks ago, with matching game clock and marker.
  const db=new RoomStore(join(target,'subterfuge.sqlite'));const saved=db.load()!;saved.room.clock!.anchorMs-=1200000;const revision=db.commit(saved.room,saved.revision);db.close();
  await writeFile(join(target,'checkpoint-restored.json'),JSON.stringify({format:'checkpoint-restored/1',id:manifest.id,revision,frozenAt:manifest.frozenAt-1200000}));
  const restored=await game(target,await freePort(),await freePort(),true);
  try{assert.equal((await(await fetch(restored.base+'/api/state')).json()).tick,manifest.tick);}finally{await stop(restored.child);}
 }finally{await stop(server.child);await rm(directory,{recursive:true,force:true});}
});

test('drain timeout unlocks the controller without cancelling its existing model turn',{timeout:30000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'linked-drain-timeout-')),playerPort=await freePort(),server=await game(directory,await freePort(),playerPort);
 let runtime:AgentRuntime|undefined,release=()=>{},entered=()=>{};const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let calls=0;
 // A timed-out body can remain suspended at `await started` when startup
 // fails before the provider is called. Its finally block cannot run then.
 t.after(async()=>{release();await runtime?.shutdown();await stop(server.child);await rm(directory,{recursive:true,force:true});});
 try{
  const access=JSON.parse(await readFile(join(directory,'player-access.json'),'utf8'));
  runtime=new AgentRuntime(parseAgentConfig({storeDirectory:join(directory,'ai'),seats:[{id:'ai-01',serverUrl:`http://127.0.0.1:${playerPort}`,roomId:access.roomId,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:8,tokenEnv:'TOKEN',settings:{model:'',personality:'schemer'}}]}),{step:async()=>{calls++;entered();await gate;return {reply:{tool:'finish',arguments:{},summary:'completed after timeout'},tokens:0};}},{TOKEN:await registerTestExecutor(`http://127.0.0.1:${playerPort}`,access.credentials[0].token)},{fixedSlots:true,profilesPath:join(directory,'ai','profiles.json')});
  await runtime.start('ai-01');const turn=runtime.tick();await providerStarted(started,turn,()=>server.output()+JSON.stringify({status:runtime!.status(),logs:runtime!.consoleLogs('ai-01')}));
  await assert.rejects(runtime.prepareCheckpoint(join(directory,'snapshot'),access.roomId,[{seat:0,slot:0}],Date.now()+80),/超时/);
  assert.equal(runtime.checkpointActive,false);assert.equal(runtime.status()[0]!.busy,true);assert.equal(runtime.status()[0]!.enabled,true);
  release();await turn;assert.equal(calls,1);assert.equal(runtime.status()[0]!.status,'waiting');
 }finally{release();await runtime?.shutdown();await stop(server.child);await rm(directory,{recursive:true,force:true});}
});


test('linked checkpoint restores commander authority and private history without future instructions',{timeout:30000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linked-commander-')),port=await freePort(),playerPort=await freePort();let server=await game(directory,port,playerPort);
 try{
  const access=JSON.parse(await readFile(join(directory,'player-access.json'),'utf8'));
  const baseUrl=`http://127.0.0.1:${playerPort}`;
  async function ownerView(path='',body?:unknown){const res=await fetch(baseUrl+'/player/v2/owner/commander'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${access.credentials[0].token}`,Connection:'close'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(res.status,200,await res.clone().text());return res.json();}
  const request=async(path:string,body?:unknown)=>(await ownerView(path,body)).thread;
  const workerToken=await registerTestExecutor(baseUrl,access.credentials[0].token,['observe','events.read','commander.worker']),discussion=new ProtocolPlayerGateway({id:'checkpoint-discussion',serverUrl:baseUrl,roomId:access.roomId,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:8,tokenEnv:'DISCUSSION',settings:{model:'fake',personality:'schemer'}},workerToken);
  async function strategy(id:string,text:string,version:number){await request('/messages',{id,text,references:[]});await discussion.discussionTransport.request('/tool/commander/worker').catch(error=>{throw new Error(String(error)+' '+server.output());});await discussion.discussionTransport.request('/tool/commander/worker',{op:'reply',messageId:id,reply:'请确认这项策略。',proposal:{baseVersion:version,text,summary:text}});const view=await ownerView(),proposal=view.proposals.find((p:any)=>p.baseVersion===String(version));return request('/confirm',{roomEpoch:view.scope.roomEpoch,proposalId:proposal.proposalId,baseVersion:proposal.baseVersion,contentDigest:proposal.contentDigest});}
  await strategy('before','守住工厂。',0);
  const before=await request('');await server.post('checkpoints',{name:'指挥官指令快照'});await until(async()=>!(await server.status()).busy);
  const status=await server.status();assert.equal(status.job.status,'completed',JSON.stringify(status));const source=join(directory,'checkpoints',status.job.id),manifest=await verifyLinkedCheckpoint(source);
  const checkpointDb=new RoomStore(join(source,'game','subterfuge.sqlite'),{readOnly:true});try{const payload=checkpointDb.readProtocolDocument(manifest.roomId,'commander','journal');assert.equal(JSON.parse(payload!).threads.find((thread:any)=>thread.player===0).directives.text,'守住工厂。');}finally{checkpointDb.close();}
  await strategy('future','全面向北进攻。',1);assert.equal((await request('')).directives.version,2);
  const restored=join(directory,'restored');await restoreLinkedCheckpoint(source,restored);await stop(server.child);server=await game(restored,port,playerPort);
  const after=await request('');assert.deepEqual(after.directives,before.directives);assert.deepEqual(after.messages,before.messages);assert.ok(!after.messages.some((m:any)=>m.text.includes('向北')));
 }finally{await stop(server.child);await rm(directory,{recursive:true,force:true});}
});
