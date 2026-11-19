import {wireModelFixture} from './helpers/model-fixture.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm,mkdir,readdir,copyFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {AgentRuntime,parseAgentConfig,agentStoreKey} from '../packages/ai/src/index.js';
import type {AgentProvider,AgentResult} from '../packages/ai/src/controller/contracts/types.js';
import {emptyProtocolClientState} from '../packages/player-sdk/src/index.js';
import {SqliteProtocolClientStore} from '../packages/ai/src/controller/transport/protocol-store.js';
import {CommanderStore} from '../packages/server/src/commander-store.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import type {CommanderThread} from '../packages/contracts/src/index.js';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>Promise<boolean>|boolean){const deadline=Date.now()+8000;while(Date.now()<deadline){if(await check())return;await sleep(10);}throw Error('Timed out');}
const reply=(text='先防守'):AgentResult=>({reply:{tool:'finish',arguments:{memory:{strategy:text}},summary:'建议先防守，等你确认。'},tokens:1});
async function fixture(t:import('node:test').TestContext,provider:AgentProvider){
 provider=wireModelFixture(provider);
 const dir=await mkdtemp(join(tmpdir(),'commander-checkpoint-')),room={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]};
 const h=protocolHarness(t,{room}),credentials=h.ownerCredentials;let commander=new CommanderStore(),grant=h.grant(0,['observe','events.read','commands.write','control.lease','chat.send','commander.worker']);
 let server=await createOwnerPlayerApi(h,{commander});
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
 const create=(storeDirectory=join(dir,'ai'))=>new AgentRuntime(parseAgentConfig({storeDirectory,seats:[{id:'ai-01',serverUrl:`http://127.0.0.1:${port}`,roomId:credentials.roomId,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'TOKEN',settings:{model:'fake',personality:'schemer'}}]}),provider,{TOKEN:grant.token},{fixedSlots:true,profilesPath:join(storeDirectory,'profiles.json')});
 let runtime=create();
 const rawRequest=async(path:string,data?:unknown)=>{const r=await fetch(`http://127.0.0.1:${port}`+path,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credentials.credentials[0]!.token}`,'Content-Type':'application/json',Connection:'close'},...(data===undefined?{}:{body:JSON.stringify(data)})}).catch(error=>{throw new Error('Commander owner request failed: '+path,{cause:error});});assert.equal(r.status,200,await r.clone().text());return await r.json();};
 const request=async(path:string,data?:unknown)=>(await rawRequest(path,data)).thread as CommanderThread;
 const confirm=async(proposalId:string,version:number)=>{const view=await rawRequest('/player/v2/owner/commander'),proposal=view.proposals.find((p:any)=>p.proposalId===proposalId&&p.baseVersion===String(version));return request('/player/v2/owner/commander/confirm',{roomEpoch:view.scope.roomEpoch,proposalId,baseVersion:proposal.baseVersion,contentDigest:proposal.contentDigest});};
 const send=(id:string)=>request('/player/v2/owner/commander/messages',{id,text:'讨论防守',references:[]});
 return {dir,roomId:credentials.roomId,get runtime(){return runtime;},send,request,confirm,snapshotGame:(path:string)=>h.store.backup(path),thread:()=>commander.read(credentials.roomId,0),restore:async(aiDirectory:string,journal:string)=>{const database=join(aiDirectory,agentStoreKey(runtime.config.seats[0]!)+'.sqlite');await runtime.shutdown();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));h.restore(journal);commander=new CommanderStore();server=await createOwnerPlayerApi(h,{commander});server.listen(port,'127.0.0.1');await once(server,'listening');await until(async()=>fetch(`http://127.0.0.1:${port}/player/v2/protocol`,{headers:{Connection:'close'}}).then(r=>r.ok,()=>false));grant=h.grant(0,['observe','events.read','commands.write','control.lease','chat.send','commander.worker']);
 // Explicit rebind after the canonical fork preserves settled receipts and refuses any unresolved operation.
 const transport=new SqliteProtocolClientStore(database);try{transport.transaction(state=>{assert.notEqual(state.scope?.roomEpoch,h.repository.currentEpoch(h.roomId));assert.ok(Object.values(state.outbox).every(entry=>entry.state==='settled'),'explicit rebind must preserve unresolved operations until reconciliation');assert.equal(Object.keys(state.checkpointOutbox??{}).length,0);const outbox=state.outbox;Object.assign(state,emptyProtocolClientState(),{outbox});});}finally{transport.close();}runtime=create(aiDirectory);},close:async()=>{if(runtime.checkpointActive)await runtime.releaseCheckpoint();await runtime.shutdown();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}};
}
test('checkpoint drains the independent discussion and freezes new model calls and private writes',{timeout:15000},async t=>{
 let calls=0,release!:(v:AgentResult)=>void;const pending=new Promise<AgentResult>(r=>release=r),f=await fixture(t,{step:async()=>++calls===1?pending:reply('继续防守')});
 try{
  await f.send('first');await f.runtime.tick();await until(()=>calls===1);await f.send('second');
  let prepared=false;const destination=join(f.dir,'saved');const saving=f.runtime.prepareCheckpoint(destination,f.roomId,[{seat:0,slot:0}],Date.now()+5000).then(x=>{prepared=true;return x;});
  await sleep(60);assert.equal(prepared,false);await f.runtime.tick();assert.equal(calls,1);
  release(reply());const metadata=await saving;assert.equal(prepared,true);assert.equal(f.thread().messages.find(m=>m.id==='first')!.status,'completed');assert.equal(f.thread().messages.find(m=>m.id==='second')!.status,'queued');
  const saved=new DatabaseSync(join(destination,metadata.seats[0]!.store),{readOnly:true});try{assert.equal(saved.prepare("SELECT count(*) AS n FROM journal WHERE kind='commander-call-completed'").get()!.n,1);}finally{saved.close();}
  const current=new DatabaseSync(join(f.dir,'ai',metadata.seats[0]!.store),{readOnly:true});const count=()=>current.prepare('SELECT count(*) AS n FROM journal').get()!.n;try{
   const before=count();
   await (f.runtime as any).entries.get('ai-01').gateway.discussionTransport.request('/tool/commander/worker');
   await sleep(1050);await f.runtime.tick();assert.equal(calls,1);assert.equal(count(),before);
  }finally{current.close();}
  await f.runtime.releaseCheckpoint();await f.runtime.tick();await until(()=>calls===2);await until(()=>f.thread().messages.find(m=>m.id==='second')?.status==='completed');assert.equal(f.runtime.status()[0]!.enabled,false);assert.equal(f.runtime.status()[0]!.owned,false);
 }finally{release?.(reply());await f.close();}
});
test('discussion drain timeout resumes the lane without cancelling the existing provider',{timeout:15000},async t=>{
 let calls=0,release!:(v:AgentResult)=>void,signal:AbortSignal|undefined;const pending=new Promise<AgentResult>(r=>release=r),f=await fixture(t,{step:async request=>{calls++;signal=request.signal;return calls===1?pending:reply();}});
 try{await f.send('first');await f.runtime.tick();await until(()=>calls===1);await assert.rejects(f.runtime.prepareCheckpoint(join(f.dir,'timeout'),f.roomId,[{seat:0,slot:0}],Date.now()+60),/超时/);assert.equal(f.runtime.checkpointActive,false);assert.equal(signal!.aborted,false);release(reply());await until(()=>f.thread().messages[0]?.status==='completed');await f.send('second');await sleep(1050);await f.runtime.tick();await until(()=>calls===2);assert.equal(f.runtime.status()[0]!.enabled,false);}finally{release?.(reply());await f.close();}
});
test('explicitly rebound restored runtime preserves settled receipts without future directives or failed-reconciliation cache',{timeout:30000},async t=>{
 let calls=0,fail=false;const f=await fixture(t,{step:async()=>{calls++;if(fail)throw Error('temporary model failure');return reply();}});
 try{
  await f.send('first');await f.runtime.tick();await until(()=>f.thread().messages.some(m=>m.proposal));
  const saved=join(f.dir,'saved');const metadata=await f.runtime.prepareCheckpoint(saved,f.roomId,[{seat:0,slot:0}],Date.now()+5000);await f.snapshotGame(join(saved,'game.sqlite'));await f.runtime.releaseCheckpoint();
  const proposal=f.thread().messages.find(m=>m.proposal)!.proposal!;await f.confirm(proposal.id,0);fail=true;await sleep(1050);await f.runtime.tick();await until(()=>f.thread().messages.some(m=>m.status==='failed'));
  const future=new DatabaseSync(join(f.dir,'ai',metadata.seats[0]!.store),{readOnly:true});try{assert.equal(JSON.parse(String(future.prepare('SELECT payload FROM seats').get()!.payload)).commanderDirectives.version,1);}finally{future.close();}
  const restored=join(f.dir,'restored-ai');await mkdir(restored);for(const name of await readdir(saved))if(name.endsWith('.sqlite'))await copyFile(join(saved,name),join(restored,name));
  fail=false;await f.restore(restored,join(saved,'game.sqlite'));assert.equal(f.thread().directives.version,0);await f.confirm(proposal.id,0);await f.runtime.tick();await until(async()=>{await f.runtime.tick();return f.thread().directives.appliedVersion===1;}).catch(error=>{t.diagnostic(JSON.stringify({calls,directives:f.thread().directives,seats:f.runtime.status().map(s=>({status:s.status,error:s.error,enabled:s.enabled}))}));throw error;});assert.equal(f.runtime.status()[0]!.enabled,false);assert.ok(calls>=3);
 }finally{await f.close();}
});
