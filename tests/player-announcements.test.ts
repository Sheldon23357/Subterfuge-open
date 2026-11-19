import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,projectPlayerView,projectPlayerAnnouncements,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup} from '../packages/engine/src/index.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
function setup(){const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:80,height:80};cfg.positions={'蓝方工厂':{x:0,y:0},'红方矿场':{x:20,y:0},'红方后方':{x:25,y:0}};
 cfg.economy.players.push({active:false,neptunium:0,minesCreated:0});return cfg;}

test('hidden mine completion announces owner and location, never pending work or hidden statistics',()=>{
 const cfg=setup();cfg.economy.outposts[2]!.drillers=250;
 const order={id:'mine',player:1,action:{kind:'toggle-mine' as const,outpostId:'红方后方'}};
 const pending=submitFleetOrder(createFleetScenario(cfg),order,500).state;
 assert.deepEqual(projectPlayerAnnouncements(pending,0),[]);
 const at101=advanceFleetScenario(pending,101);assert.deepEqual(projectPlayerAnnouncements(at101,0),[]);
 const cancelled=submitFleetOrder(at101,{...order,id:'cancel'},499).state;
 assert.deepEqual(projectPlayerAnnouncements(advanceFleetScenario(cancelled,102),0),[]);
 const done=advanceFleetScenario(at101,102),messages=projectPlayerAnnouncements(done,0);
 assert.deepEqual(messages,[{kind:'mine-created',tick:102,seconds:0,player:1,outpostId:'红方后方'}]);
 assert.deepEqual(projectPlayerAnnouncements(done,1),[]);assert.deepEqual(projectPlayerAnnouncements(done,2),[]);
 assert.deepEqual(projectPlayerAnnouncements(restoreFleetSnapshot(saveFleetSnapshot(done)),0),messages);
 const changed=structuredClone(done);changed.economy.players[0]!.active=false;changed.economy.players[2]!.active=true;
 changed.economy.outposts[2]!.owner=0;
 assert.deepEqual(projectPlayerAnnouncements(changed,0),messages);assert.deepEqual(projectPlayerAnnouncements(changed,2),[]);
 for(const key of ['drillers','shield','neptunium','sequence','amount','audience'])assert.equal(JSON.stringify(messages).includes(key),false);
 // Development snapshots with obsolete notification fields require a reset.
 const legacy=JSON.parse(saveFleetSnapshot(done));for(const e of legacy.expected.events)if(e.kind==='mine-created'){delete e.audience;delete e.details.owner;}
 assert.throws(()=>restoreFleetSnapshot(JSON.stringify(legacy)),/disagree/);
});

test('starting a second allied mine broadcasts the first completion at command time',()=>{
 const cfg=setup();cfg.economy.teamSize=2;
 cfg.economy.outposts[0]!.drillers=300;cfg.economy.outposts[2]!.drillers=300;
 let s=submitFleetOrder(createFleetScenario(cfg),{id:'first',player:1,action:{kind:'toggle-mine',outpostId:'红方后方'}},100).state;
 s=submitFleetOrder(s,{id:'second',player:0,action:{kind:'toggle-mine',outpostId:'蓝方工厂'}},200).state;
 assert.deepEqual(projectPlayerAnnouncements(s,0),[{kind:'mine-created',tick:100,seconds:200,player:1,outpostId:'红方后方'}]);
 assert.deepEqual(projectPlayerAnnouncements(s,1),[]);
 assert.deepEqual(projectPlayerAnnouncements(restoreFleetSnapshot(saveFleetSnapshot(s)),0),projectPlayerAnnouncements(s,0));
});
test('announcement v2 owner endpoint uses seat identity, filters before pagination, and cannot expose other events',async t=>{
 const cfg=setup();cfg.economy.outposts[1]!.type='generator';cfg.economy.outposts[1]!.minePending=false;cfg.economy.outposts[1]!.drillers=500;cfg.economy.outposts[2]!.drillers=500;
 let state=advanceFleetScenario(submitFleetOrder(createFleetScenario(cfg),{id:'first-mine',player:1,action:{kind:'toggle-mine',outpostId:'红方矿场'}}).state,101);
 state=advanceFleetScenario(submitFleetOrder(state,{id:'mine',player:1,action:{kind:'toggle-mine',outpostId:'红方后方'}}).state,102);
 const room={state,scheduled:[]},h=protocolHarness(t,{room}),server=await createOwnerPlayerApi(h);
 server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a==='object');const url=`http://127.0.0.1:${a.port}/player/v2/owner/announcements`;
 const request=(seat=0,query='')=>fetch(url+query,{headers:{Authorization:`Bearer ${h.ownerCredentials.credentials[seat]!.token}`}});
 try{
  assert.equal((await fetch(url)).status,401);const first=await (await request()).json();assert.equal(first.announcements.length,2);assert.equal(first.nextCursor,2);
  assert.deepEqual(first.announcements[1],{kind:'mine-created',tick:102,seconds:0,player:1,outpostId:'红方后方'});
  const current=h.store.load()!;current.room.state=submitFleetOrder(current.room.state,{id:'private-shields',player:1,action:{kind:'set-shields',outpostId:'红方后方',enabled:false}}).state;h.store.commit(current.room,current.revision);
  assert.deepEqual(await (await request()).json(),first);assert.deepEqual((await (await request(2)).json()).announcements,[]);
  const page=await (await request(0,'?after=1&limit=1')).json();assert.deepEqual(page.announcements,[first.announcements[1]]);assert.equal(page.nextCursor,2);
  assert.deepEqual((await (await request(0,'?after=2')).json()).announcements,[]);
  for(const query of ['?player=1','?after=3','?after=-1','?limit=201','?limit=1&limit=2'])assert.equal((await request(0,query)).status,400);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

