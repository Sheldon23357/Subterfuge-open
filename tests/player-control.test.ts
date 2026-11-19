import {playerControlPresentation} from '../packages/client/src/player-control-view.js';
import {request as httpRequest} from 'node:http';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {PlayerControl,PlayerControlError} from '../packages/server/src/player-control.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import type {LabRoom} from '../packages/server/src/planning.js';
const session='agent-session-000001',other='agent-session-000002';
const agent=(id=session)=>({'x-subterfuge-controller':'agent','x-subterfuge-control-session':id});
test('advance readiness requires a current owned lease and the exact observation/chat basis',()=>{
 let now=1000;const control=new PlayerControl(()=>now),revision='a'.repeat(64);
 assert.equal(control.readyToAdvance('room',0,revision,2),false);
 assert.throws(()=>control.reportReadiness('room',0,{ready:true,revision,chatCursor:2},{}));
 control.command('room',0,{action:'acquire',sessionId:session,ttlMs:1000});
 control.reportReadiness('room',0,{ready:true,revision,chatCursor:2},agent());
 assert.equal(control.readyToAdvance('room',0,revision,2),true);
 assert.equal(control.readyToAdvance('other',0,revision,2),false);
 assert.equal(control.readyToAdvance('room',1,revision,2),false);
 assert.equal(control.readyToAdvance('room',0,'b'.repeat(64),2),false);
 assert.equal(control.readyToAdvance('room',0,revision,3),false);
 control.command('room',0,{action:'renew',sessionId:session,ttlMs:1000});assert.equal(control.readyToAdvance('room',0,revision,2),true);
 control.reportReadiness('room',0,{ready:false},agent());assert.equal(control.readyToAdvance('room',0,revision,2),false);
 control.reportReadiness('room',0,{ready:true,revision,chatCursor:2},agent());now=2001;assert.equal(control.readyToAdvance('room',0,revision,2),false);
 control.command('room',0,{action:'acquire',sessionId:other});assert.equal(control.readyToAdvance('room',0,revision,2),false);
 assert.throws(()=>control.reportReadiness('room',0,{ready:true,revision,chatCursor:2},agent()));
});
test('control ownership is room/seat scoped, expires fail-closed and fences previous owners and legacy',()=>{
 let now=1000;const control=new PlayerControl(()=>now);
 const conflict=(fn:()=>unknown)=>assert.throws(fn,(e:unknown)=>e instanceof PlayerControlError&&e.status===409);
 control.assertWrite('room',0,{});
 control.command('room',0,{action:'acquire',sessionId:session,ttlMs:1000});
 assert.equal(control.status('room',0).sessionId,null);assert.equal(control.status('room',0).manualCommandsAllowed,true);
 assert.equal(control.status('room',0,agent()).sessionId,session);
 conflict(()=>control.command('room',0,{action:'acquire',sessionId:other}));
 assert.doesNotThrow(()=>control.assertWrite('room',0,{})); // A legitimate owner may issue manual gameplay while the agent lease survives.
 conflict(()=>control.assertWrite('room',1,agent()));
 conflict(()=>control.assertWrite('other-room',0,agent()));
 control.assertWrite('room',0,agent());
 control.command('room',0,{action:'takeover',mode:'agent',sessionId:other});
 conflict(()=>control.assertWrite('room',0,agent()));
 conflict(()=>control.command('room',0,{action:'release',sessionId:session}));
 control.command('room',0,{action:'renew',sessionId:other,ttlMs:1000});now=2000;
 conflict(()=>control.assertWrite('room',0,agent(other)));
 conflict(()=>control.command('room',0,{action:'renew',sessionId:other}));
 control.assertWrite('room',0,{});
 assert.throws(()=>control.assertWrite('room',0,{'x-subterfuge-controller':'legacy'}),/Invalid controller/);
 control.command('room',0,{action:'acquire',sessionId:'agent-session-000003'});
 control.command('room',0,{action:'takeover',mode:'manual'});
 conflict(()=>control.assertWrite('room',0,agent()));
 control.assertWrite('room',0,{});
});

async function controlHttp(t:import('node:test').TestContext){
 const h=protocolHarness(t),serial=new SerialExecutor();let switched=0;
 const server=await createOwnerPlayerApi(h,{serial,onExternalControl:()=>{switched++;}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const base=`http://127.0.0.1:${address.port}`;
 const request=(path:string,body?:unknown,headers:Record<string,string>={},seat=0)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${h.ownerCredentials.credentials[seat]!.token}`,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const observe=async()=>await(await request('/player/v2/owner/observation')).json();
 const command=(id:string,revision:string,enabled=false)=>({kind:'order',clientCommandId:id,expectedRevision:revision,payload:{action:{kind:'set-shields',outpostId:'蓝方工厂',enabled}}});
 return{h,serial,base,request,observe,command,get switched(){return switched;}};
}

test('v2 owner control authenticates competing claims and scopes session visibility and writes to the seat',async t=>{
 const f=await controlHttp(t),path='/player/v2/owner/control';
 assert.equal((await fetch(f.base+path)).status,401);
 assert.equal((await f.request(path,undefined,{Origin:'https://untrusted.example'})).status,403);
 assert.equal((await f.request(path,{action:'acquire',sessionId:session,player:1})).status,400);
 const claims=await Promise.all([session,other].map(sessionId=>f.request(path,{action:'acquire',sessionId,ttlMs:1000})));
 assert.deepEqual(claims.map(r=>r.status).sort(),[200,409]);const owner=claims[0]!.status===200?session:other;
 const hidden=await(await f.request(path)).json(),owned=await(await f.request(path,undefined,agent(owner))).json();
 assert.equal(hidden.protocol,'player-control/2');assert.equal(hidden.mode,'agent');assert.equal(hidden.sessionId,null);assert.equal(owned.sessionId,owner);
 const baseline=await f.observe(),body=f.command('controlled-order',baseline.revision);
 assert.equal((await f.request('/player/v2/owner/commands',body,agent(owner),1)).status,409);
 assert.equal(f.h.store.load()!.revision,1);
 assert.equal((await f.request('/player/v2/owner/commands',body,agent(owner))).status,200);
 assert.equal(f.h.store.load()!.revision,2);
 f.h.wall+=1000;f.h.elapsed+=1000;
 assert.equal((await f.request(path,{action:'renew',sessionId:owner})).status,409);
 assert.equal((await f.request('/player/v2/owner/commands',body,agent(owner))).status,409);
 assert.equal((await f.request('/player/v2/owner/commands',body)).status,200);assert.equal(f.h.store.load()!.revision,2);
});

test('v2 checks executor lease again after waiting in the shared world queue',async t=>{
 const f=await controlHttp(t),path='/player/v2/owner/control';
 assert.equal((await f.request(path,{action:'acquire',sessionId:session,ttlMs:1000})).status,200);
 const observed=await f.observe();let unlock!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 const barrier=f.serial.run(async()=>{entered();await new Promise<void>(r=>unlock=r);});await started;
 const pending=f.request('/player/v2/owner/commands',f.command('queued-expired',observed.revision),agent());
 await new Promise(r=>setTimeout(r,25));f.h.wall+=1000;f.h.elapsed+=1000;unlock();await barrier;
 assert.equal((await pending).status,409);assert.equal(f.h.store.load()!.revision,1);
 assert.equal((await f.request(path,{action:'takeover',mode:'agent',sessionId:other})).status,200);
 assert.equal((await f.request('/player/v2/owner/commands',f.command('old-owner',observed.revision),agent())).status,409);
});

test('v2 owner gameplay preserves the active executor lease and explicit manual takeover fences it',async t=>{
 const f=await controlHttp(t),path='/player/v2/owner/control';
 await f.request(path,{action:'acquire',sessionId:session});const observed=await f.observe(),body=f.command('manual-order',observed.revision);
 const collaborative=await(await f.request(path)).json();assert.equal(collaborative.manualCommandsAllowed,true);assert.equal(playerControlPresentation(collaborative).blocked,false);assert.equal(playerControlPresentation(collaborative).exclusiveBlocked,true);
 assert.equal((await f.request('/player/v2/owner/commands',body)).status,200);assert.equal(f.switched,0);
 assert.equal((await(await f.request(path,undefined,agent())).json()).sessionId,session);
 const takeover=await f.request(path,{action:'takeover',mode:'manual'});assert.equal(takeover.status,200);assert.equal(f.switched,1);
 const released=await(await f.request(path)).json();assert.equal(released.mode,'manual');assert.equal(released.manualCommandsAllowed,true);
 assert.equal((await f.request('/player/v2/owner/commands',body,agent())).status,409);
 assert.equal((await f.request('/player/v2/owner/commands',body)).status,200);assert.equal(f.h.store.load()!.revision,2);
});

test('v2 expectedRevision rejects new stale intents while accepted command retries remain idempotent',async t=>{
 const f=await controlHttp(t),before=await f.observe(),path='/player/v2/owner/commands',first=f.command('cas-first',before.revision);
 for(const expectedRevision of ['stale',before.revision+','+before.revision])assert.equal((await f.request(path,{...first,expectedRevision})).status,400);
 assert.equal((await f.request(path,first)).status,200);
 const changed=await f.observe();assert.notEqual(changed.revision,before.revision);
 const stale=await f.request(path,f.command('cas-stale',before.revision,true));assert.equal(stale.status,409);assert.equal((await stale.json()).code,'REVISION_CONFLICT');
 assert.equal((await f.request(path,first)).status,200);assert.equal(f.h.store.load()!.revision,2);
 assert.equal((await f.request(path,f.command('cas-fresh',changed.revision,true))).status,200);assert.equal(f.h.store.load()!.revision,3);
});


test('delegated v2 executor lease permits owner orders without changing its fence',async t=>{
 const f=await controlHttp(t),repo=f.h.repository,grant=f.h.grant();
 const executorSession=repo.createSession(grant.principal,'collaboration-test',['core/2']);
 repo.controlOperation(grant.principal,'acquire',{roomEpoch:grant.principal.roomEpoch,sessionId:executorSession,idempotencyKey:'collaboration-acquire'});
 const control=await(await f.request('/player/v2/owner/control')).json();
 assert.equal(control.mode,'agent');assert.equal(control.manualCommandsAllowed,true);
 assert.equal(playerControlPresentation(control).blocked,false);
 const fence=repo.control(grant.principal,executorSession);
 const observed=await f.observe();
 assert.equal((await f.request('/player/v2/owner/commands',f.command('owner-with-delegated-agent',observed.revision))).status,200);
 const after=repo.control(grant.principal,executorSession);
 assert.equal(after.generation,fence.generation);assert.equal(after.sessionId,executorSession);
 assert.equal((await f.request('/player/v2/owner/chat',{id:'blocked-chat',to:null,text:'test'})).status,409);
});
