import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once,EventEmitter} from 'node:events';
import type {ServerResponse} from 'node:http';
import {protocolHarness} from './player-protocol-test-helpers.js';
import {SerialExecutor} from '../packages/server/src/player-access.js';
import {createPlayerProtocolApi} from '../packages/server/src/player-protocol-api.js';
import {PlayerProtocolAdmission} from '../packages/server/src/player-protocol-admission.js';
async function setup(t:TestContext){const h=protocolHarness(t),serial=new SerialExecutor(),server=createPlayerProtocolApi({repository:h.repository,roomId:'fixture-room',serial,load:()=>h.store.load()!,commit:(room,revision)=>h.store.commit(room,revision)});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});const base=`http://127.0.0.1:${address.port}/player/v2`,headers={Authorization:'Bearer '+h.first.token},call=(path:string,body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return{h,serial,server,base,headers,call};}
test('removed calculations and redundant executor endpoints stay absent without admitting commands',async t=>{
 const x=await setup(t),info=await(await x.call('/protocol')).json();
 for(const capability of ['queries/1','sse/1','status/1'])assert.ok(!info.capabilities.includes(capability));
 for(const path of ['/queries/forecast','/queries/forecast-batch','/queries/preview','/queries/route-preview','/queries/deployment-preview','/queries/fleet-arrivals','/queries/attack-routes','/queries/history','/readiness','/status'])assert.equal((await x.call(path,{})).status,404,path);
 for(const path of ['/events/stream','/commands/retired','/commander','/chat/conversations','/status'])assert.equal((await x.call(path)).status,404,path);
 assert.equal(x.h.repository.inspect().operations.length,0);assert.equal(x.h.store.load()!.room.state.commands.length,0);
});
test('R05 entry admission is bounded per authenticated player and global queue, without borrowing another player budget',()=>{const budget=new PlayerProtocolAdmission(),release=Array.from({length:8},()=>budget.enter('player-one','read'));assert.throws(()=>budget.enter('player-one','write'),/budget/);const other=budget.enter('player-two','write');other();for(const end of release)end();const restored=budget.enter('player-one','read');restored();});
test('R05 HTTP rejects excess pending reads before joining the shared serial queue',async t=>{const x=await setup(t);let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),barrier=new Promise<void>(r=>release=r),blocking=x.serial.run(async()=>{enter();await barrier;});await entered;let arrived!:()=>void,count=0;const allArrived=new Promise<void>(resolve=>arrived=resolve);x.server.on('request',()=>{if(++count===12)arrived();});const pending=Array.from({length:12},()=>x.call('/control'));const rejected=await Promise.race(pending);assert.equal(rejected.status,429);await allArrived;release();await blocking;const responses=await Promise.all(pending);assert.equal(responses.filter(r=>r.status===200).length,8);assert.equal(responses.filter(r=>r.status===429).length,4);});
