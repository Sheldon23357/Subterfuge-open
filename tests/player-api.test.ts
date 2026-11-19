import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {createPlayerApi,observation} from '../packages/server/src/player-api.js';
import {PlayerAccess,SerialExecutor,savePlayerAccess,loadPlayerAccess} from '../packages/server/src/player-access.js';
import {RoomStore} from '../packages/server/src/room-store.js';
import type {LabRoom} from '../packages/server/src/planning.js';

function room():LabRoom{
  const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.size={width:80,height:80};cfg.positions={'蓝方工厂':{x:0,y:0},'红方矿场':{x:20,y:0},'红方后方':{x:25,y:0}};
  return {state:createFleetScenario(cfg),scheduled:[]};
}

function v2PlayerApi(getRoom:()=>LabRoom,setRoom:(next:LabRoom)=>void,data:ReturnType<typeof PlayerAccess.generate>,options:{seconds?:()=>number;onSave?:()=>void}={}){
  let access=new PlayerAccess(data);const roomId=data.roomId,storage=new RoomStore(':memory:');
  setRoom({...getRoom(),playerRoomId:roomId});
  let revision=storage.commit(getRoom(),0);
  const repository=storage.protocol!;repository.startAuthority(roomId,getRoom().state.economy.players.length);
  const server=createPlayerApi({protocol:{repository,roomId,serial:new SerialExecutor(),load:()=>({room:getRoom(),revision}),commit:(next,expectedRevision)=>{
    if(expectedRevision!==revision)throw Error('Unexpected stale room revision');
    revision=storage.commit(next,revision);setRoom(next);options.onSave?.();return revision;
  },ownerIdentity:authorization=>{const player=access.identity(authorization);return player===null?null:{roomId,player};},...(options.seconds?{seconds:options.seconds}:{})}});
  return {server,storage,replaceAccess:(next:ReturnType<typeof PlayerAccess.generate>)=>{access=new PlayerAccess(next);}};
}

const ownerCommand=(kind:'order'|'schedule'|'cancel-schedule',clientCommandId:string,expectedRevision:string,payload:Record<string,unknown>,issueTick?:number)=>({kind,clientCommandId,expectedRevision,payload,...(issueTick===undefined?{}:{issueTick})});

test('owner API returns its fleet immediately with a durable receipt and no gift endpoint',async()=>{
 let current=room();current.state=submitFleetOrder(current.state,{id:'to-destroy',player:0,action:{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方矿场',drillers:10}}).state;
 const data=PlayerAccess.generate(2),{server,storage}=v2PlayerApi(()=>current,next=>{current=next;},data);
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const headers={Authorization:`Bearer ${data.credentials[0]!.token}`,'Content-Type':'application/json'};
 try{
  const before=await(await fetch(url+'/player/v2/owner/observation',{headers})).json();
  const request=ownerCommand('order','destroy-now',before.revision,{action:{kind:'return-fleet',fleetId:'to-destroy'}});
  const first=await fetch(url+'/player/v2/owner/commands',{method:'POST',headers,body:JSON.stringify(request)});assert.equal(first.status,200);
  const receipt=await first.json();const retry=await fetch(url+'/player/v2/owner/commands',{method:'POST',headers,body:JSON.stringify(request)});assert.equal(retry.status,200);assert.deepEqual(await retry.json(),receipt);
  assert.equal(current.state.fleets.find(f=>f.id==='to-destroy')!.used,true);assert.equal(current.state.economy.outposts[0]!.drillers,90);
  assert.equal(current.state.events.filter(e=>e.kind==='fleet-recalled').length,1);
  const after=await(await fetch(url+'/player/v2/owner/observation',{headers})).json();assert.equal(after.view.fleets.length,1);assert.equal(after.view.fleets[0].returned,true);assert.equal(after.view.fleets[0].drillers,5);assert.notEqual(after.revision,before.revision);
  const retired=await fetch(url+'/player/v2/owner/commands',{method:'POST',headers,body:JSON.stringify(ownerCommand('order','retired-gift',after.revision,{action:{kind:'toggle-gift',fleetId:'to-destroy'}}))});assert.equal(retired.status,400);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));storage.close();}
});

test('access credentials survive restart, validate file and rotate across room scopes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'subterfuge-access-'));
  try{
    const path=join(dir,'access.json'),data=PlayerAccess.generate(2);await savePlayerAccess(path,data);
    const loaded=await loadPlayerAccess(path,2,data.roomId);
    assert.equal(loaded.identity(`Bearer ${data.credentials[1]!.token}`),1);assert.equal(loaded.identity('Bearer nope'),null);
    const next=await loadPlayerAccess(path,2,'new-room');assert.equal(next.identity(`Bearer ${data.credentials[1]!.token}`),null);
    const file=JSON.parse(await readFile(path,'utf8'));assert.equal(file.roomId,'new-room');
    assert.throws(()=>new PlayerAccess({...data,credentials:[data.credentials[0]!,data.credentials[0]!]}),/credential/);
  }finally{await rm(dir,{recursive:true,force:true});}
});



test('model thinking time does not stale unchanged decisions, while visible changes still do',async()=>{
 let current=room(),seconds=0;const data=PlayerAccess.generate(2),{server,storage}=v2PlayerApi(()=>current,next=>{current=next;},data,{seconds:()=>seconds});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const headers={Authorization:`Bearer ${data.credentials[0]!.token}`,'Content-Type':'application/json'},observe=async()=>await(await fetch(url+'/player/v2/owner/observation',{headers})).json();
 const order=(id:string,revision:string)=>fetch(url+'/player/v2/owner/commands',{method:'POST',headers,body:JSON.stringify(ownerCommand('order',id,revision,{action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}))});
 try{
  const original=await observe();seconds=599;const delayed=await observe();
  assert.equal(delayed.revision,original.revision);assert.equal(delayed.secondsSinceLastTick,599);assert.equal(original.secondsSinceLastTick,0);
  assert.equal((await order('delayed-decision',original.revision)).status,200);assert.equal(current.state.commands[0]!.seconds,599);assert.equal(current.state.economy.outposts[0]!.shieldDisableSeconds,1199);
  const accepted=await observe();assert.notEqual(accepted.revision,original.revision);
  current.state.economy.outposts[1]!.drillers+=1;current.state.economy.outposts[2]!.drillers-=1;
  assert.equal((await observe()).revision,accepted.revision);
  current.state.economy.outposts[1]!.drillers+=123;assert.notEqual((await observe()).revision,accepted.revision);
  current.state.economy.outposts[0]!.drillers+=1;assert.notEqual((await observe()).revision,accepted.revision);
  assert.equal((await order('stale-decision',accepted.revision)).status,409);assert.equal(current.state.commands.length,1);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));storage.close();}
});

test('display countdown changes keep revision stable but cancellation-window closure changes it',async()=>{
 let current=room();current.state=submitFleetOrder(current.state,{id:'fleet',player:0,action:{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方后方',drillers:10}},50).state;
 current.state=advanceFleetScenario(current.state,101);let seconds=10;
 const data=PlayerAccess.generate(2),{server,storage}=v2PlayerApi(()=>current,next=>{current=next;},data,{seconds:()=>seconds});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const observe=async()=>await(await fetch(url+'/player/v2/owner/observation',{headers:{Authorization:`Bearer ${data.credentials[0]!.token}`}})).json();
 try{
  const before=await observe();assert.equal(before.view.fleets[0].launchRemainingSeconds,40);seconds=49;
  const near=await observe();assert.equal(near.view.fleets[0].launchRemainingSeconds,1);assert.equal(near.revision,before.revision);
  seconds=50;const expired=await observe();assert.equal(expired.view.fleets[0].launchRemainingSeconds,0);assert.notEqual(expired.revision,before.revision);
  seconds=51;const committed=await observe();assert.equal(committed.view.fleets[0].canCancelLaunch,false);assert.equal(expired.view.fleets[0].canCancelLaunch,false);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));storage.close();}
});



test('v2 owner API enforces identity, hides world state, rejects stale actions and serializes commits',async()=>{
  let current=room(),accessData=PlayerAccess.generate(2),saves=0;
  const {server,storage,replaceAccess}=v2PlayerApi(()=>current,next=>{current=next;},accessData,{onSave:()=>{saves++;}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
  const request=(path:string,player=0,data?:unknown,extra:Record<string,string>={})=>fetch(url+path,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${accessData.credentials[player]!.token}`,'Content-Type':'application/json',...extra},...(data!==undefined?{body:JSON.stringify(data)}:{})});
  const observe=async()=>await(await request('/player/v2/owner/observation')).json();
  try{
    assert.equal((await fetch(url+'/player/v2/owner/observation')).status,401);
    assert.equal((await request('/player/v2/owner/observation',0,undefined,{Origin:'https://untrusted.example'})).status,403);
    for(const path of ['/api/state','/api/export','/api/chat/session'])assert.equal((await request(path)).status,404);
    for(const path of ['/tool/observation','/tool/order','/player/observation','/player/order','/player/v1/observation','/player/v1/commands']){
      assert.equal((await request(path)).status,404,path);
      assert.equal((await request(path,0,{})).status,404,path);
    }
    assert.equal(saves,0,'retired routes cannot commit a world effect');
    for(const path of ['/player/v2/admin','/player/v2/preview'])assert.equal((await request(path)).status,401);
    let observed=await observe();
    assert.equal(observed.view.player,0);assert.equal(observed.view.outposts.find((o:{id:string})=>o.id==='红方矿场').drillers,undefined);
    assert.equal((await request('/player/v2/owner/observation?player=1')).status,400);
    assert.equal('initial' in observed.view,false);assert.equal('events' in observed.view,false);
    current.state.economy.outposts[1]!.productionProgress+=100;
    assert.deepEqual(await observe(),observed);


    const post=(id:string,action:unknown,revision=observed.revision)=>request('/player/v2/owner/commands',0,ownerCommand('order',id,revision,{action}));
    assert.equal((await post('invalid-action',{kind:'unsupported-action'})).status,400);
    const action={kind:'set-shields',outpostId:'蓝方工厂',enabled:false};
    assert.equal((await request('/player/v2/owner/commands',0,ownerCommand('order','spoof',observed.revision,{player:1,action}))).status,400);
    assert.equal((await post('internal',{kind:'reserve-fleet',reservationId:'secret'})).status,400);
    const concurrent=await Promise.all(['a','b'].map(id=>post(id,action)));
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);assert.equal(saves,1);assert.equal(current.state.commands.length,1);
    const winner=concurrent[0]!.status===200?'a':'b';
    assert.equal((await post(winner,action,observed.revision)).status,200);assert.equal(saves,1);
    observed=await observe();
    assert.equal((await post('enemy',{kind:'set-shields',outpostId:'红方矿场',enabled:false})).status,400);
    assert.equal((await request('/player/v2/owner/commands',0,ownerCommand('schedule','plan',observed.revision,{action},102))).status,200);
    const own=await observe(),other=await(await request('/player/v2/owner/observation',1)).json();
    assert.equal(own.scheduled.length,1);assert.equal(other.scheduled.length,0);
    const scheduleId=own.scheduled[0].id;
    assert.equal((await request('/player/v2/owner/commands',1,ownerCommand('cancel-schedule','cancel-other',other.revision,{id:scheduleId}))).status,400);
    assert.equal((await request('/player/v2/owner/commands',0,ownerCommand('cancel-schedule','cancel-own',own.revision,{id:scheduleId}))).status,200);
    const previous=accessData.credentials[0]!.token;accessData=PlayerAccess.generate(2);replaceAccess(accessData);
    assert.equal((await fetch(url+'/player/v2/owner/observation',{headers:{Authorization:`Bearer ${previous}`}})).status,401);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));storage.close();}
});

test('visible troop and outpost changes invalidate stale v2 commands',async()=>{
 let current=room(),accessData=PlayerAccess.generate(2),saves=0;
 current.state.initial.positions['红方矿场']={x:1,y:0};current.state.initial.positions['红方后方']={x:2,y:0};
 const {server,storage,replaceAccess}=v2PlayerApi(()=>current,next=>{current=next;},accessData,{onSave:()=>{saves++;}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const request=(path:string,data?:unknown,seat=0)=>fetch(url+path,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${accessData.credentials[seat]!.token}`,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const observe=async()=>await(await request('/player/v2/owner/observation')).json();
 const order=(id:string,revision:string,action:unknown={kind:'set-shields',outpostId:'蓝方工厂',enabled:false})=>request('/player/v2/owner/commands',ownerCommand('order',id,revision,{action}));
 try{
  const old=await observe();current.state.economy.outposts[0]!.drillers++;const fresh=await observe();
  assert.equal(fresh.view.outposts[0].drillers,old.view.outposts[0].drillers+1);assert.notEqual(old.revision,fresh.revision);
  assert.equal((await order('stale-after-troops',old.revision)).status,409);assert.equal((await order('still-valid',fresh.revision)).status,200);assert.equal(saves,1);
  const before=await observe();current.state.commands.push({id:'external-no-op',player:0,tick:current.state.economy.tick,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}});
  assert.equal((await order('own-command-conflict',before.revision)).status,409);
  for(const mutate of [()=>{current.state.economy.outposts[1]!.owner=0;},()=>{current.state.economy.outposts[1]!.shield++;},()=>{current.state.economy.outposts[0]!.drillers++;}]){
   const observation=await observe();mutate();assert.equal((await order('changed-'+observation.revision,observation.revision)).status,409);
  }
  current.state.economy.outposts[1]!.owner=1;
  assert.equal((await order('illegal-owner',(await observe()).revision,{kind:'set-shields',outpostId:'红方矿场',enabled:false})).status,400);
  assert.equal((await order('unknown-revision','0'.repeat(64))).status,409);
  assert.equal(saves,1);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));storage.close();}
});
