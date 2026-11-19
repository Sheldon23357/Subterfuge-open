import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import type {AddressInfo} from 'node:net';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {createRoomHub} from '../packages/server/src/room-hub.js';
import {hallLinkTarget,savedHallToken,hallTransportOrigin} from '../packages/client/src/hall-link-protocol.js';

test('browser handoff is restricted to an exact loopback console origin and strong nonce',()=>{
 const nonce='a'.repeat(48);
 assert.deepEqual(hallLinkTarget(`#console=${encodeURIComponent('http://127.0.0.1:4400')}&nonce=${nonce}`),{origin:'http://127.0.0.1:4400',nonce});
 for(const origin of ['https://evil.example','http://127.0.0.1.evil:4400','http://127.0.0.1:4400/path','http://user@localhost:4400','http://localhost'])assert.equal(hallLinkTarget(`#console=${encodeURIComponent(origin)}&nonce=${nonce}`),null);
 assert.equal(hallLinkTarget('#console=http://127.0.0.1:4400&nonce=x'),null);
 assert.equal(hallTransportOrigin('http://203.0.113.10'),'https://203.0.113.10');
 assert.equal(hallTransportOrigin('http://127.0.0.1:4312'),'http://127.0.0.1:4312');
});
test('handoff only offers credentials saved for the selected room',()=>{
 const persistent=new Map([['subterfuge-hall-identity-ABC123',JSON.stringify({code:'ABC123',playerToken:'a'.repeat(64)})]]);
 const empty={getItem:()=>null};
 assert.equal(savedHallToken('ABC123',{getItem:key=>persistent.get(key)??null},empty),'a'.repeat(64));
 assert.equal(savedHallToken('DEF456',{getItem:key=>persistent.get(key)??null},empty),null);
});
test('connection leases persist, expire, and reject a competing bot until released',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bot-links-'));let store=new LobbyStore(join(dir,'room.sqlite'));
 try{
  store.linkHubBot(0,'a'.repeat(48),'AI 01',1000,'test-model');
  assert.equal(store.hubBotLinks(1001)[0]?.name,'AI 01');
  assert.equal(store.hubBotLinks(1001)[0]?.model,'test-model');
  assert.throws(()=>store.linkHubBot(0,'b'.repeat(48),'AI 02',1002),/已连接/);
  store.unlinkHubBot(0,'b'.repeat(48));assert.equal(store.hubBotLinks(1002).length,1);
  store.close();store=new LobbyStore(join(dir,'room.sqlite'));
  assert.equal(store.hubBotLinks(1003).length,1);
  assert.equal(store.hubBotLinks(31000).length,0);
  store.linkHubBot(0,'b'.repeat(48),'AI 02',31001);
  store.unlinkHubBot(0,'b'.repeat(48));assert.equal(store.hubBotLinks(31002).length,0);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('bot presence is authorized by the owner credential, not a requested seat',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hub-bot-api-'));
 const hub=await createRoomHub({directory:dir,webRoot:resolve('packages/client/public')});
 await new Promise<void>(r=>hub.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
 const post=async(path:string,body:unknown,token?:string,method='POST')=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
 try{
  const host=await (await post('/api/rooms',{key:'a'.repeat(64),name:'Synthetic bot test',capacity:2})).json();
  const peer=await (await post(`/api/rooms/${host.code}/join`,{key:'b'.repeat(64)})).json();
  const path=`/api/rooms/${host.code}/bots`,link={id:'a'.repeat(48),name:'AI 01',model:'test-model'};
  assert.equal((await post(path,link)).status,401);
  assert.equal((await post(path,{...link,seat:1},host.playerToken)).status,400);
  assert.equal((await post(path,link,host.playerToken)).status,200);
  assert.equal((await post(path,{id:'b'.repeat(48),name:'AI 02'},host.playerToken)).status,409);
  const visible=await (await fetch(base+path)).json();
  assert.equal(visible.connections[0].seat,0);assert.equal(visible.connections[0].name,'AI 01');
  assert.equal(visible.connections[0].model,'test-model');
  assert.equal((await post(path,{id:'b'.repeat(48),name:'AI 02',model:'second-model'},peer.playerToken)).status,200);
  assert.equal((await (await fetch(base+path)).json()).connections.length,2);
  assert.ok(!JSON.stringify(visible).includes(host.playerToken));assert.ok(!JSON.stringify(visible).includes(link.id));
  await post(path,{id:link.id},peer.playerToken,'DELETE');
  assert.equal((await (await fetch(base+path)).json()).connections.length,2);
  await post(path,{id:link.id},host.playerToken,'DELETE');
  assert.equal((await (await fetch(base+path)).json()).connections.length,1);
  const auth={Authorization:`Bearer ${host.playerToken}`};
  const lobby=await(await fetch(base+'/lobby/v2',{headers:auth})).json();
  assert.equal((await post('/lobby/v2/commands',{id:'start-existing-room',kind:'start',revision:lobby.revision},host.playerToken)).status,200);
  const returning=await fetch(base+`/api/rooms/${host.code}/identity`,{headers:auth});
  assert.equal(returning.status,200);assert.deepEqual(await returning.json(),{roomId:host.roomId,seat:0});
  assert.equal((await post(`/api/rooms/${host.code}/join`,{key:'d'.repeat(64)})).status,409);
  assert.equal((await(await fetch(base+'/api/rooms')).json()).rooms[0].players,2);
 }finally{await hub.close();await rm(dir,{recursive:true,force:true});}
});
