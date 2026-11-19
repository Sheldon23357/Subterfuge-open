import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,projectPlayerView,projectPlayerHistory,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup} from '../packages/engine/src/index.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
function setup(){const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;cfg.size={width:80,height:80};
 cfg.positions={a:{x:0,y:0},b:{x:20,y:0},c:{x:25,y:0}};cfg.economy.outposts.forEach((o,i)=>o.id=['a','b','c'][i]!);return cfg;}
const launch={id:'launch',player:0,action:{kind:'launch' as const,delaySeconds:600,source:'a',destination:'b',drillers:20}};
test('history includes commands exactly at their second, retains same-second order, and is immutable',()=>{
 const initial=createFleetScenario(setup());let s=submitFleetOrder(initial,launch,100).state;
 s=submitFleetOrder(s,{id:'shield',player:0,action:{kind:'set-shields',outpostId:'a',enabled:false}},100).state;
 s=submitFleetOrder(s,{id:'cancel-shield',player:0,action:{kind:'set-shields',outpostId:'a',enabled:true}},101).state;
 const before=JSON.stringify(s),at99=projectPlayerHistory(s,0,100,99),at100=projectPlayerHistory(s,0,100,100),at101=projectPlayerHistory(s,0,100,101);
 assert.equal(at99.view.fleets.length,0);assert.equal(at100.view.fleets.length,1);assert.equal(at100.view.fleets[0]!.secondsUntilLaunch,700);
 const expected=submitFleetOrder(submitFleetOrder(initial,launch,100).state,{id:'shield',player:0,action:{kind:'set-shields',outpostId:'a',enabled:false}},100).state;
 assert.deepEqual(at100.view,projectPlayerView(expected,0));assert.deepEqual(at101.view,projectPlayerView(s,0));assert.equal(JSON.stringify(s),before);
 assert.deepEqual(projectPlayerHistory(restoreFleetSnapshot(saveFleetSnapshot(s)),0,100,100),at100);
 for(const [tick,seconds] of [[99,0],[101,0],[100,102],[100,-1],[100,600],[NaN,0],[100,1.5]])assert.throws(()=>projectPlayerHistory(s,0,tick!,seconds!));
});
test('current captures and later private actions cannot retroactively reveal historical hidden state',()=>{
 const cfg=setup();cfg.economy.outposts[0]!.drillers=1000;cfg.economy.outposts[1]!.drillers=0;cfg.economy.outposts[1]!.shield=0;
 const initial=createFleetScenario(cfg),past=projectPlayerHistory(initial,0,100);
 let s=submitFleetOrder(initial,{...launch,action:{...launch.action,drillers:500}}).state;s=advanceFleetScenario(s,700);
 assert.equal(s.economy.outposts[1]!.owner,0);assert.deepEqual(projectPlayerHistory(s,0,100).view.outposts[1],past.view.outposts[1]);
 assert.deepEqual(projectPlayerHistory(s,0,100).intel,past.intel); // Historical public totals use the historical world, not today's ownership.
 const old=projectPlayerHistory(s,0,100).view.outposts[1]!;assert.equal(old.visibility,0);assert.equal('drillers' in old,false);assert.equal('owner' in old,true);
 const another=setup();another.economy.outposts[1]!.drillers=123456;another.economy.players[1]!.neptunium=987;
 const hidden=createFleetScenario(another);assert.deepEqual(projectPlayerHistory(hidden,0,100).view.outposts[1],past.view.outposts[1]);
 for(const key of ['initial','events','commands','replay','scheduled'])assert.equal(key in projectPlayerHistory(s,0,100),false);
});
test('player history v2 query authenticates seat and bounds time without publishing replay or accepting writes',async t=>{
 let s=submitFleetOrder(createFleetScenario(setup()),launch,100).state;s=advanceFleetScenario(s,102);
 const room={state:s,scheduled:[]},h=protocolHarness(t,{room}),server=await createOwnerPlayerApi(h,{seconds:()=>50});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const headers={Authorization:`Bearer ${h.ownerCredentials.credentials[0]!.token}`,'Content-Type':'application/json'};
 const observe=async()=>await(await fetch(url+'/player/v2/owner/observation',{headers})).json() as {revision:string};
 const request=async(payload:Record<string,unknown>,expectedRevision?:string)=>fetch(url+'/player/v2/owner/queries/history',{method:'POST',headers,body:JSON.stringify({expectedRevision:expectedRevision??(await observe()).revision,payload})});
 const before=JSON.stringify(h.store.load()!.room);
 try{
   assert.equal((await fetch(url+'/player/v2/owner/queries/history',{headers})).status,404);
   const unauthorized=await fetch(url+'/player/v2/owner/queries/history',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauthorized.status,401);
   const result=await (await request({tick:100,seconds:99})).json();assert.equal(result.view.player,0);assert.equal(result.view.fleets.length,0);assert.equal(result.roomId,h.roomId);
   assert.equal((await (await request({tick:100,seconds:100})).json()).view.fleets.length,1);
   for(const payload of [{},{tick:100,player:1},{tick:103},{tick:102,seconds:51},{tick:100,seconds:600},{tick:-1}])assert.equal((await request(payload)).status,400);
   assert.equal((await request({tick:102,seconds:50})).status,200);
   assert.equal((await request({tick:100},'0'.repeat(64))).status,409);
   assert.equal(JSON.stringify(h.store.load()!.room),before);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
