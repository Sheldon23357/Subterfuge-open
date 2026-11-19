import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parseAgentConfig} from '../packages/ai/src/controller/contracts/agent-config.js';
import {AgentRuntime} from '../packages/ai/src/reference.js';
import {startAgentConsole} from '../packages/ai/src/application/agent-console.js';

test('configured owner browser entry retains room routing without an interactive hall binding',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'configured-entry-'));
 const raw={storeDirectory:directory,seats:[{id:'seat',serverUrl:'http://127.0.0.1:1',roomId:'configured-room',roomCode:'ABC123',lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'TEST_TOKEN',ownerCredential:true,settings:{model:'',personality:'schemer'}}]};
 assert.throws(()=>parseAgentConfig({...raw,seats:[{...raw.seats[0],roomCode:'bad/path'}]}),/Invalid room code/);
 const token='a'.repeat(64),runtime=new AgentRuntime(parseAgentConfig(raw),{step:async()=>{throw Error('Unexpected model call');}},{TEST_TOKEN:token});
 const consoleServer=await startAgentConsole(runtime,{webRoot:resolve('packages/client/agent-console-public'),provider:'offline',connectionMode:'configured'});
 try{
  const page=await fetch(consoleServer.url),cookie=page.headers.get('set-cookie')!.split(';')[0]!;
  const boot=await(await fetch(consoleServer.url+'api/agent/bootstrap',{headers:{cookie,'X-Agent-Console':'1'}})).json();
  const request={method:'POST',headers:{cookie,'X-Agent-CSRF':boot.csrf,'Content-Type':'application/json'},body:JSON.stringify({id:'seat'})};
  const entry=await fetch(consoleServer.url+'api/agent/browser-entry',request);
  assert.equal(entry.status,200);
  assert.deepEqual(await entry.json(),{serverUrl:raw.seats[0]!.serverUrl,roomId:'configured-room',playerToken:token,code:'ABC123'});
  assert.equal((await fetch(consoleServer.url+'api/agent/browser-entry',{...request,headers:{'Content-Type':'application/json'}})).status,401);
 }finally{await consoleServer.close();await runtime.shutdown();await rm(directory,{recursive:true,force:true});}
});
