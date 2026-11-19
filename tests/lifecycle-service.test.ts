import {TICK_MILLISECONDS} from '../packages/server/src/realtime.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby} from '../packages/server/src/waiting-lobby.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {createLifecycleService} from '../packages/server/src/lifecycle-service.js';

test('one listener joins, authorizes host start, persists waiting map and advances in background without browser requests',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-service-')),file=join(dir,'lifecycle.sqlite'),access=PlayerAccess.generate(2),epoch=1800000000000;
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;cfg.economy.initialTick=0;
 let store=new LobbyStore(file);store.commit(createWaitingLobby(access),0,{state:createFleetScenario(cfg),scheduled:[],playerRoomId:access.roomId});
 // Reopen before listening: the waiting world must not come from process memory.
 store.close();store=new LobbyStore(file);
 let now=epoch;const errors:unknown[]=[],service=createLifecycleService(store,{now:()=>now,onClockError:e=>errors.push(e)});
 service.server.listen(0,'127.0.0.1');await once(service.server,'listening');const address=service.server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const headers=(p:number)=>({Authorization:'Bearer '+access.credentials[p]!.token,'Content-Type':'application/json'});
 const post=(p:number,body:unknown)=>fetch(url+'/lobby/v2/commands',{method:'POST',headers:headers(p),body:JSON.stringify(body)});
 try{
  assert.equal((await post(0,{id:'start',kind:'start',revision:1})).status,403);
  assert.equal((await post(0,{id:'join',kind:'join',revision:1})).status,200);
  assert.equal((await post(1,{id:'join',kind:'join',revision:2})).status,200);
  assert.equal((await post(1,{id:'start',kind:'start',revision:3})).status,403);
  assert.equal((await post(0,{id:'start',kind:'start',revision:3,seed:99})).status,400);
  assert.equal((await fetch(url+'/lobby/v2',{headers:{...headers(0),Origin:'https://untrusted.invalid'}})).status,403);
  const started=await post(0,{id:'start',kind:'start',revision:3});assert.equal(started.status,200);
  const state=await started.json();assert.equal(state.status,'starting');assert.equal(state.secondsRemaining,300);
  assert.equal((await post(0,{id:'start',kind:'start',revision:3})).status,200);assert.equal(store.load()!.revision,4);
  assert.equal((await fetch(url+'/player/v2/owner/observation',{headers:headers(0)})).status,200);
  // TLS is terminated by the public proxy; same-host HTTPS POSTs still carry Origin.
  const browserHeaders={...headers(0),Origin:url.replace('http:','https:')};
  assert.equal((await fetch(url+'/player/v2/owner/commander',{headers:browserHeaders})).status,200);
  const discussion=await fetch(url+'/player/v2/owner/commander/messages',{method:'POST',headers:browserHeaders,body:JSON.stringify({id:'browser-discussion',text:'说明当前局势。',references:[]})});
  assert.equal(discussion.status,200);assert.equal((await discussion.json()).thread.messages[0].status,'queued');
  assert.equal((await fetch(url+'/player/v2/owner/commander/messages',{method:'POST',headers:{...headers(0),Origin:'https://untrusted.invalid'},body:JSON.stringify({id:'cross-origin-discussion',text:'不可发送。',references:[]})})).status,403);
  const control=(body:unknown)=>fetch(url+'/player/v2/owner/control',{method:'POST',headers:headers(1),body:JSON.stringify(body)});
  assert.equal((await control({action:'acquire',sessionId:'external-session-0001'})).status,200);
  assert.equal((await control({action:'release',sessionId:'external-session-0001'})).status,200);
  // A stopped external agent does not participate in the realtime clock barrier.
  service.startClock();service.startClock();now=epoch+300000+2*TICK_MILLISECONDS;
  // Observe the database, not an HTTP read that itself would drive catch-up.
  const deadline=Date.now()+5000;
  while(store.load()!.runtime!.room.state.economy.tick<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(store.load()!.runtime!.room.state.economy.tick,2);assert.deepEqual(errors,[]);
  const observation=await fetch(url+'/player/v2/owner/observation',{headers:headers(1)});assert.equal(observation.status,200);assert.equal((await observation.json()).view.player,1);
  assert.equal((await post(1,{id:'late-leave',kind:'leave',revision:store.load()!.revision})).status,409);
 }finally{
  service.stopClock();service.server.closeAllConnections();await new Promise<void>(resolve=>service.server.close(()=>resolve()));await service.drain();store.close();rmSync(dir,{recursive:true,force:true});
 }
});
