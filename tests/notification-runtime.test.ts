import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {createFleetScenario,submitFleetOrder,projectPlayerNotifications,type FleetSetup} from '../packages/engine/src/index.js';
import {simulatePlayerFuture} from '../packages/server/src/player-forecast.js';
import {NotificationRuntime} from '../packages/server/src/notification-runtime.js';
import {NotificationScheduleStore} from '../packages/server/src/notification-schedule-store.js';
import {startRealtime,catchUpRealtime} from '../packages/server/src/realtime.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
test('runtime confirms a predicted sonar reentry across multi-tick catch-up',async()=>{
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:80,height:80};
 cfg.positions[cfg.economy.outposts[1]!.id]={x:7.8,y:0};cfg.positions[cfg.economy.outposts[2]!.id]={x:20,y:0};
 cfg.economy.outposts.push({...cfg.economy.outposts[0]!,id:'second-sonar',drillers:0});cfg.positions['second-sonar']={x:16.2,y:0};
 const state=submitFleetOrder(createFleetScenario(cfg),{id:'cross-gap',player:1,action:{kind:'launch',source:cfg.economy.outposts[1]!.id,destination:cfg.economy.outposts[2]!.id,drillers:10}}).state;
 let room=startRealtime({state,scheduled:[]},0);
 const forecast=simulatePlayerFuture(room,0,172);assert.equal(forecast.status,'conditional');if(forecast.status!=='conditional')return;
 assert.equal(forecast.notifications.length,1);
 const store=new NotificationScheduleStore(':memory:');
 try{
  new NotificationRuntime(store).refresh('sonar-room',room,0);
  room=await catchUpRealtime(room,72*10000);
  // New runtime object simulates loss of the in-memory revision cache.
  new NotificationRuntime(store).refresh('sonar-room',room,72*10000);
  const contacts=store.inbox('sonar-room',0).filter(n=>n.entry.source==='sonar');
  assert.equal(contacts.length,1);assert.equal(contacts[0]!.entry.notification.tick,forecast.notifications[0]!.tick);
  assert.equal(store.inbox('sonar-room',1).filter(n=>n.entry.source==='sonar').length,0);
  new NotificationRuntime(store).refresh('sonar-room',room,72*10000);
  assert.deepEqual(store.inbox('sonar-room',0).filter(n=>n.entry.source==='sonar'),contacts);
 }finally{store.close();}
});
test('runtime confirms caught-up rule events and v2 notifications filter before pagination',async t=>{
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const state=submitFleetOrder(createFleetScenario(cfg),{id:'attack',player:0,action:{kind:'launch',source:cfg.economy.outposts[0]!.id,destination:cfg.economy.outposts[1]!.id,drillers:27}}).state;
 let room=startRealtime({state,scheduled:[]},0),now=0;
 const h=protocolHarness(t,{room}),credentials=h.ownerCredentials,access=h.ownerAccess,store=new NotificationScheduleStore(':memory:'),runtime=new NotificationRuntime(store);
 const sync=async()=>{const saved=h.store.load()!;room=await catchUpRealtime(saved.room,now);if(JSON.stringify(room)!==JSON.stringify(saved.room))h.store.commit(room,saved.revision);runtime.refresh(access.roomId,room,now);};
 await sync();const generation=store.generation(access.roomId,0);
 now=1000;await sync();assert.equal(store.generation(access.roomId,0),generation,'mere elapsed seconds do not rebuild');
 const server=await createOwnerPlayerApi(h,{sync});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const url=`http://127.0.0.1:${address.port}`;
 const get=(player:number,path='/player/v2/owner/notifications')=>fetch(url+path,{headers:{Authorization:`Bearer ${credentials.credentials[player]!.token}`}});
 try{
  assert.equal((await fetch(url+'/player/v2/owner/notifications')).status,401);
  assert.deepEqual((await(await get(0)).json()).notifications,[]);
  now=6000000;
  const response=await get(0);assert.equal(response.status,200);const inbox=await response.json();
  assert.ok(inbox.notifications.some((n:any)=>n.kind==='battle'));
  assert.deepEqual((await(await get(0)).json()).notifications,inbox.notifications,'repeated sync does not duplicate inbox');
  assert.ok(store.inbox(access.roomId,0).some(n=>n.entry.notification.kind==='battle'));
  assert.deepEqual((await(await get(1)).json()).notifications,projectPlayerNotifications(room.state,1).map((entry,id)=>({id,...entry})));
  for(const query of ['?player=1','?room=other','?after=0&after=1','?limit=201','?after=-1'])assert.equal((await get(0,'/player/v2/owner/notifications'+query)).status,400);
  const page=await(await get(0,'/player/v2/owner/notifications?limit=1')).json();assert.equal(page.notifications.length,1);assert.equal(page.nextCursor,1);
  assert.equal(room.state.commands.length,1,'notification refresh never submits game commands');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});
