import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {join} from 'node:path';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {ProtocolPlayerGateway} from '../packages/ai/src/controller/transport/protocol-gateway.js';
import {SqliteProtocolClientStore} from '../packages/ai/src/controller/transport/protocol-store.js';
import type {AgentSeatConfig} from '../packages/ai/src/controller/contracts/agent-config.js';

async function fixture(t:TestContext){
 const h=protocolHarness(t),server=await createOwnerPlayerApi(h);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const owner=h.ownerCredentials.credentials[0]!.token,path=join(h.dir,'executor.sqlite'),requests:{path:string;authorization:string;body:string}[]=[];
 const config:AgentSeatConfig={id:'delegated-seat',serverUrl:`http://127.0.0.1:${address.port}`,roomId:h.roomId,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'OWNER',ownerCredential:true,settings:{model:'test',personality:'schemer'}};
 const record:typeof fetch=async(input,init)=>{requests.push({path:new URL(String(input)).pathname,authorization:new Headers(init?.headers).get('authorization')??'',body:typeof init?.body==='string'?init.body:''});return fetch(input,init);};
 return{h,config,owner,path,requests,record};
}

test('owner setup delegates once, keeps owner credentials out of executor calls, and reuses the durable grant after restart',async t=>{
 const f=await fixture(t),initial=f.h.repository.ownerGrants(f.h.roomId,0).length;
 let store=new SqliteProtocolClientStore(f.path),gateway=new ProtocolPlayerGateway(f.config,f.owner,store,{fetch:f.record});
 try{
  await gateway.checkIdentity();const before=await gateway.snapshot(0,0);await gateway.acquire();
  await gateway.request('/tool/order',{revision:before.observation.revision,order:{id:'delegated-order',action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}});
  assert.equal(f.h.store.load()!.room.state.commands.length,1);await gateway.release();gateway.close();
  store=new SqliteProtocolClientStore(f.path);gateway=new ProtocolPlayerGateway(f.config,f.owner,store,{fetch:f.record});await gateway.checkIdentity();
  assert.equal(f.requests.filter(r=>r.path==='/player/v2/owner/grants').length,1);assert.equal(f.h.repository.ownerGrants(f.h.roomId,0).length,initial+1);
  assert.ok(f.requests.filter(r=>r.path.startsWith('/player/v2/owner/')).every(r=>r.authorization==='Bearer '+f.owner));
  assert.ok(f.requests.filter(r=>!r.path.startsWith('/player/v2/owner/')).every(r=>r.authorization!=='Bearer '+f.owner));
  assert.equal(f.h.store.load()!.room.state.commands.length,1);
 }finally{gateway.close();}
});

test('revoking a delegated grant stops the executor and restart never recreates the authorization',async t=>{
 const f=await fixture(t);let store=new SqliteProtocolClientStore(f.path),gateway=new ProtocolPlayerGateway(f.config,f.owner,store,{fetch:f.record});
 try{
  await gateway.checkIdentity();const grant=store.loadDelegation()!;f.h.repository.revokeGrant(grant.grantId);
  await assert.rejects(gateway.checkIdentity());gateway.close();
  store=new SqliteProtocolClientStore(f.path);gateway=new ProtocolPlayerGateway(f.config,f.owner,store,{fetch:f.record});await assert.rejects(gateway.checkIdentity());
  assert.equal(f.requests.filter(r=>r.path==='/player/v2/owner/grants').length,1);assert.equal(f.h.store.load()!.room.state.commands.length,0);
  assert.equal(f.h.repository.ownerGrants(f.h.roomId,0).find(g=>g.grantId===grant.grantId)!.revoked,true);
 }finally{gateway.close();}
});

test('a lost grant-registration response resumes the same prepared specification without another grant or game write',async t=>{
 const f=await fixture(t);let lost=false;
 const interrupted:typeof fetch=async(input,init)=>{const response=await f.record(input,init);if(new URL(String(input)).pathname==='/player/v2/owner/grants'&&!lost){lost=true;await response.arrayBuffer();throw new TypeError('Synthetic lost authorization response');}return response;};
 let store=new SqliteProtocolClientStore(f.path),gateway=new ProtocolPlayerGateway(f.config,f.owner,store,{fetch:interrupted});
 try{
  await assert.rejects(gateway.checkIdentity());const prepared=store.loadDelegation()!;assert.equal(prepared.state,'prepared');gateway.close();
  store=new SqliteProtocolClientStore(f.path);gateway=new ProtocolPlayerGateway(f.config,f.owner,store,{fetch:f.record});await gateway.checkIdentity();
  assert.equal(store.loadDelegation()!.grantId,prepared.grantId);assert.equal(store.loadDelegation()!.state,'registered');
  const posts=f.requests.filter(r=>r.path==='/player/v2/owner/grants');assert.equal(posts.length,2);assert.equal(posts[0]!.body,posts[1]!.body);
  assert.equal(f.h.repository.ownerGrants(f.h.roomId,0).filter(g=>g.grantId===prepared.grantId).length,1);assert.equal(f.h.store.load()!.room.state.commands.length,0);
 }finally{gateway.close();}
});
