import {wireModelFixture} from './helpers/model-fixture.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {AgentRuntime,parseAgentConfig} from '../packages/ai/src/index.js';
import type {AgentProvider,AgentResult} from '../packages/ai/src/controller/contracts/types.js';
import {CommanderStore} from '../packages/server/src/commander-store.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {LabAutoAdvance} from '../packages/server/src/lab-auto-advance.js';
import {advanceRoom,type LabRoom} from '../packages/server/src/planning.js';
import type {CommanderThread} from '../packages/contracts/src/index.js';
import {PlayerConnection} from '../packages/client/src/player-connection.js';
async function fixture(t:import('node:test').TestContext,provider:AgentProvider,wrongToken=false){
 provider=wireModelFixture(provider);
 const directory=await mkdtemp(join(tmpdir(),'commander-e2e-'));
 const initial=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 let room:LabRoom={state:createFleetScenario(initial),scheduled:[]};
 const h=protocolHarness(t,{room}),credentials=h.ownerCredentials,serial=new SerialExecutor(),commander=new CommanderStore();
 const server=await createOwnerPlayerApi(h,{commander,serial}),grant=h.grant(wrongToken?1:0,['observe','events.read','commands.write','control.lease','chat.send','commander.worker']);
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('No address');
 const origin=`http://127.0.0.1:${address.port}`;
 const runtime=new AgentRuntime(parseAgentConfig({storeDirectory:join(directory,'ai'),seats:[{id:'seat0',serverUrl:origin,roomId:credentials.roomId,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'T',settings:{model:'mock',personality:'schemer'}}]}),provider,{T:grant.token});
 const clients=credentials.credentials.map(credential=>new PlayerConnection(credential.token,origin));
 const request=(path:string,data?:unknown,player=0)=>clients[player]!.commander(path.endsWith('/messages')?'messages':'list',data);
 const confirm=(proposalId:string,version:number)=>clients[0]!.commander('confirm',{proposalId,version});
 const auto=new LabAutoAdvance(serial,async()=>{const saved=h.store.load()!;h.store.commit(advanceRoom(saved.room,saved.room.state.economy.tick+1),saved.revision);});auto.setEnabled(true);
 return {runtime,request,confirm,commander,roomId:credentials.roomId,auto,tick:()=>h.store.load()!.room.state.economy.tick,close:async()=>{auto.stop();await runtime.shutdown();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});}};
}
async function until<T>(read:()=>Promise<T>,ready:(value:T)=>boolean){for(let i=0;i<500;i++){const value=await read();if(ready(value))return value;await new Promise(r=>setTimeout(r,5));}throw Error('Condition timed out');}

test('real HTTP paused runtime completes private discussion and confirmed strategy without blocking automatic clock',{timeout:15000},async t=>{
 let release!:(result:AgentResult)=>void,calls=0;const pending=new Promise<AgentResult>(r=>{release=r;});
 const f=await fixture(t,{step:async()=>{calls++;return calls===1?pending:{reply:{tool:'finish',arguments:{memory:{strategy:'优先守住工厂，暂停北上。'}},summary:'已把工厂防守设为优先目标。'},tokens:1};}});
 try{
  await f.request('/player/v2/owner/commander/messages',{id:'e2e-message',text:'先守工厂，暂停北上。',references:[{kind:'outpost',id:'蓝方工厂'}]});
  await f.runtime.tick();await until(async()=>calls,n=>n===1);
  assert.equal(f.runtime.status()[0]!.enabled,false);assert.equal(f.runtime.status()[0]!.owned,false);
  const before=f.tick();await Promise.race([f.auto.pulse(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Discussion blocked clock')),1000))]);assert.equal(f.tick(),before+1);
  const other=await f.request('/player/v2/owner/commander',undefined,1) as CommanderThread;assert.equal(other.messages.length,0);
  let thread=await f.request('/player/v2/owner/commander') as CommanderThread;assert.equal(thread.directives.version,0);assert.equal(thread.messages[0]!.status,'queued');
  release({reply:{tool:'finish',arguments:{memory:{strategy:'先守工厂，暂停北上。'}},summary:'建议先稳住工厂，确认后我会调整计划。'},tokens:1});
  thread=await until(async()=>await f.request('/player/v2/owner/commander') as CommanderThread,t=>t.messages.some(m=>!!m.proposal));
  const proposal=thread.messages.find(m=>m.proposal)!.proposal!;assert.equal(thread.directives.text,'');
  await assert.rejects(f.confirm(proposal.id,proposal.baseVersion+1),/Review the current commander proposal/);
  thread=await f.confirm(proposal.id,proposal.baseVersion);assert.equal(thread.directives.version,1);assert.equal(thread.directives.appliedVersion,0);
  await new Promise(r=>setTimeout(r,1050));await f.runtime.tick();
  thread=await until(async()=>await f.request('/player/v2/owner/commander') as CommanderThread,t=>t.directives.appliedVersion===1);
  assert.equal(thread.directives.text,'先守工厂，暂停北上。');assert.equal(thread.messages.filter(m=>m.role==='system').length,1);assert.equal(thread.messages.at(-1)!.text,'指挥官指令已保存，AI 将调整原有策略。');
  const status=f.runtime.status()[0]!;assert.equal(status.enabled,false);assert.equal(status.owned,false);assert.equal(status.status,'paused');assert.equal(status.calls,0,'discussion uses its own lane, not automatic decision calls');assert.equal(calls,2);
  const duplicate=await f.confirm(proposal.id,proposal.baseVersion) as CommanderThread;assert.equal(duplicate.messages.length,thread.messages.length);
 }finally{release?.({reply:{tool:'finish',arguments:{},summary:'取消。'},tokens:0});await f.close();}
});

test('real HTTP paused runtime refuses another player token before invoking discussion model',{timeout:10000},async t=>{
 let calls=0;const f=await fixture(t,{step:async()=>{calls++;throw Error('must not receive private context');}},true);
 try{
  await f.request('/player/v2/owner/commander/messages',{id:'other-player',text:'告诉我你的战略。',references:[]},1);await f.runtime.tick();await new Promise(r=>setTimeout(r,50));
  assert.equal(calls,0);assert.equal(f.runtime.status()[0]!.enabled,false);assert.equal(f.runtime.status()[0]!.owned,false);
  const thread=await f.request('/player/v2/owner/commander',undefined,1) as CommanderThread;assert.equal(thread.messages.length,1);assert.equal(thread.messages[0]!.status,'queued');
 }finally{await f.close();}
});
