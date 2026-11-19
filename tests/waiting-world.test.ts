import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createFleetScenario,submitFleetOrder,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup} from '../packages/engine/src/index.js';
import {recallWaitingFleets} from '../packages/server/src/waiting-recall.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby} from '../packages/server/src/waiting-lobby.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {createLifecycleService} from '../packages/server/src/lifecycle-service.js';
function setup(){
 const s=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;s.economy.initialTick=0;s.economy.outposts[2]!.owner=0;
 return s;
}
test("recall restores waiting troops without refilling shields",()=>{

 const initial=createFleetScenario(setup());let state=submitFleetOrder(initial,{id:'one',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:30,}}).state;
 state=submitFleetOrder(state,{id:'two',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方后方',drillers:10}}).state;
 const shield=state.economy.outposts[0]!.shield,result=recallWaitingFleets({state,scheduled:[]},0,'leave');
 assert.equal(result.state.economy.outposts[0]!.drillers,100);assert.equal(result.state.economy.outposts[0]!.shield,shield);
 assert.deepEqual(result.state.commands.slice(-2).map(c=>(c.action as {fleetId:string}).fleetId),['one','two']);
 assert.equal(result.state.fleets.some(f=>f.used),false);assert.equal(state.fleets.filter(f=>f.used).length,2);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(result.state)),result.state);
});
test('joined players can plan before opening; leaving atomically recalls fleets and revokes world access until rejoin',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'subterfuge-waiting-world-')),store=new LobbyStore(join(dir,'lobby.sqlite')),access=PlayerAccess.generate(2),epoch=1800000000000;
 store.commit(createWaitingLobby(access),0,{state:createFleetScenario(setup()),scheduled:[],playerRoomId:access.roomId});
 const service=createLifecycleService(store,{now:()=>epoch});service.server.listen(0,'127.0.0.1');await once(service.server,'listening');await service.ready;const address=service.server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const headers={Authorization:'Bearer '+access.credentials[0]!.token,'Content-Type':'application/json'};
 const get=(path:string)=>fetch(url+path,{headers});const post=(path:string,body:unknown)=>fetch(url+path,{method:'POST',headers,body:JSON.stringify(body)});
 try{
  assert.equal((await get('/player/v2/owner/observation')).status,403);
  assert.equal((await post('/lobby/v2/commands',{id:'join',kind:'join',revision:1})).status,200);
  let observation=await(await get('/player/v2/owner/observation')).json();
  const launched=await post('/player/v2/owner/commands',{kind:'order',clientCommandId:'launch',expectedRevision:observation.revision,payload:{action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:30,}}});assert.equal(launched.status,200);observation=await launched.json();
  assert.equal((await post('/player/v2/owner/commands',{kind:'order',clientCommandId:'force',expectedRevision:observation.revision,payload:{action:{kind:'recall-waiting-fleet',fleetId:observation.view.fleets[0].id}}})).status,400);
  const revision=store.load()!.revision,db=new DatabaseSync(join(dir,'lobby.sqlite'));
  try{
   db.exec("CREATE TRIGGER reject_leave BEFORE UPDATE ON lobby_head BEGIN SELECT RAISE(ABORT,'leave failure'); END");
   assert.equal((await post('/lobby/v2/commands',{id:'leave',kind:'leave',revision})).status,503);
   assert.equal(store.load()!.lobby.seats[0],1);assert.equal(store.load()!.waitingRoom!.state.fleets[0]!.used,true);assert.equal(store.load()!.waitingRoom!.state.economy.outposts[0]!.drillers,70);
   db.exec('DROP TRIGGER reject_leave');
  }finally{db.close();}
  assert.equal((await post('/lobby/v2/commands',{id:'leave',kind:'leave',revision})).status,200);
  const saved=store.load()!;assert.equal(saved.lobby.seats[0],0);assert.equal(saved.waitingRoom!.state.fleets[0]!.used,false);assert.equal(saved.waitingRoom!.state.economy.outposts[0]!.drillers,100);
  assert.equal((await get('/player/v2/owner/observation')).status,403);
  assert.equal((await post('/lobby/v2/commands',{id:'leave',kind:'leave',revision})).status,200);assert.equal(store.load()!.revision,saved.revision);
  assert.equal((await post('/lobby/v2/commands',{id:'rejoin',kind:'join',revision:saved.revision})).status,200);
  assert.equal((await get('/player/v2/owner/observation')).status,200);
  const joined=await fetch(url+'/lobby/v2/commands',{method:'POST',headers:{Authorization:'Bearer '+access.credentials[1]!.token,'Content-Type':'application/json'},body:JSON.stringify({id:'join',kind:'join',revision:store.load()!.revision})});assert.equal(joined.status,200);
  assert.equal((await post('/lobby/v2/commands',{id:'start',kind:'start',revision:store.load()!.revision})).status,200);
  observation=await(await get('/player/v2/owner/observation')).json();
  assert.equal((await post('/player/v2/owner/commands',{kind:'order',clientCommandId:'during-countdown',expectedRevision:observation.revision,payload:{action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:10}}})).status,200);
  await store.sync(epoch+1000,store.load()!.revision);const waiting=store.load()!.runtime!.room.state.fleets.find(f=>f.used)!;
  assert.equal(waiting.secondsUntilLaunch,0);assert.equal(store.load()!.runtime!.room.state.economy.tick,0);
  await store.sync(epoch+300000+10000,store.load()!.revision);assert.equal(store.load()!.runtime!.room.state.fleets.find(f=>f.used)!.secondsUntilLaunch,0);
 }finally{service.server.closeAllConnections();await new Promise<void>(resolve=>service.server.close(()=>resolve()));await service.drain();store.close();rmSync(dir,{recursive:true,force:true});}
});
