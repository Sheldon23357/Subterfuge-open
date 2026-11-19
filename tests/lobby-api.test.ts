import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLobbyApi} from '../packages/server/src/lobby-api.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby} from '../packages/server/src/waiting-lobby.js';

test('authenticated lobby HTTP persists membership, isolates IDs, rejects races and retries across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-lobby-api-')),file=join(dir,'lobby.sqlite'),access=PlayerAccess.generate(3);
 let store=new LobbyStore(file);store.commit(createWaitingLobby(access),0);
 let server=createLobbyApi(store),url='';
 const start=async()=>{server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');url=`http://127.0.0.1:${address.port}`;};
 const stop=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();};
 const headers=(p:number)=>({Authorization:'Bearer '+access.credentials[p]!.token,'Content-Type':'application/json'});
 const post=(p:number,body:unknown,path='/lobby/v2/commands')=>fetch(url+path,{method:'POST',headers:headers(p),body:JSON.stringify(body)});
 try{
  await start();assert.equal((await fetch(url+'/lobby/v2')).status,401);
  for(const path of ['/lobby','/lobby/commands','/lobby/v1','/lobby/v1/commands']){
   assert.equal((await fetch(url+path,{headers:headers(1)})).status,404,path);
   assert.equal((await post(1,{id:'retired',kind:'join',revision:1},path)).status,404,path);
  }
  assert.equal(store.load()!.revision,1,'retired lobby routes cannot change membership');
  const initial=await(await fetch(url+'/lobby/v2',{headers:headers(1)})).json();
  assert.equal(initial.player,1);assert.equal(initial.revision,1);assert.deepEqual(initial.occupied,[false,false,false]);
  for(const token of access.credentials)assert.equal(JSON.stringify(initial).includes(token.token),false);
  assert.equal('commands'in initial,false);
  assert.equal((await post(1,{id:'join',kind:'join',revision:1,player:0})).status,400);
  assert.equal((await post(1,{id:'join',kind:'join',revision:1},'/lobby/v2/commands?player=0')).status,400);
  assert.equal((await post(0,{id:'same',kind:'join',revision:1})).status,200);
  const concurrent=await Promise.all([post(1,{id:'same',kind:'join',revision:2}),post(2,{id:'same',kind:'join',revision:2})]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  const winner=concurrent[0]!.status===200?1:2;
  assert.equal(store.load()!.revision,3);assert.equal(store.load()!.lobby.seats[winner],1);
  assert.equal((await post(winner,{id:'cancel',kind:'cancel',revision:3})).status,409);
  assert.equal((await post(winner,{id:'leave',kind:'leave',revision:3})).status,200);
  await stop();store=new LobbyStore(file);server=createLobbyApi(store);await start();
  const retry=await post(winner,{id:'same',kind:'join',revision:2});assert.equal(retry.status,200);
  const result=await retry.json();assert.equal(result.duplicate,true);assert.equal(result.occupied[winner],false);assert.equal(result.revision,4);
  assert.equal((await post(winner,{id:'same',kind:'leave',revision:4})).status,409);
  assert.equal((await post(0,{id:'cancel',kind:'cancel',revision:4})).status,200);
  assert.equal((await post(winner,{id:'late',kind:'join',revision:5})).status,409);
  assert.equal(store.load()!.lobby.status,'cancelled');
 }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
