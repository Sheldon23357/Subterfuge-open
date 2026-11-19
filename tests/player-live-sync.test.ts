import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sdkFixture} from './player-sdk-test-helpers.js';
import type {PlayerObservation} from '../packages/contracts/src/index.js';
import {ActivityFacts} from '../packages/ai/src/controller/observation/activity-facts.js';

test('live sync installs a scoped atomic cut without snapshot pages or completion pins',async t=>{
 const paths:string[]=[];
 const x=await sdkFixture(t,{fetcher:async(input,init)=>{paths.push(new URL(String(input)).pathname);return fetch(input,init);}});
 const first=await x.client.sync();assert.ok(first.document);
 assert.equal(x.client.state.cursor,first.cursor);assert.equal(x.client.state.sequence,first.highWatermark);
 assert.equal(x.client.state.decisionInputVersion,first.decisionInputVersion);
 assert.ok(!paths.some(path=>path.includes('/snapshot')));
 const unchanged=await x.client.sync();assert.equal(unchanged.document,null);
 x.h.apply(x.h.command('live-world-change'));
 const next=await x.client.sync();assert.ok(next.document);assert.notEqual(next.cursor,first.cursor);
 assert.notEqual((next.document.observation as PlayerObservation).revision,(first.document.observation as PlayerObservation).revision);
 const detached=x.client.state;detached.snapshot!.observation=null;
 assert.ok(x.client.state.snapshot!.observation,'installed documents are detached from callers');
});

test('live sync does not roll a newer installed snapshot back when a response arrives late',async t=>{
 let held:Response|undefined,release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});t.after(()=>release());
 const x=await sdkFixture(t,{fetcher:async(input,init)=>{
  const response=await fetch(input,init);
  if(new URL(String(input)).pathname==='/player/v2/sync'&&held===undefined){held=response;entered();await gate;}
  return response;
 }});
 const pending=x.client.sync();await started;
 x.h.apply(x.h.command('newer-than-sync'));const latest=await x.client.snapshot();const cursor=x.client.state.cursor;
 release();await pending;
 assert.equal(x.client.state.cursor,cursor);assert.deepEqual(x.client.state.snapshot,latest);
});

test('live sync rejects forged scope before installing a local document',async t=>{
 const x=await sdkFixture(t,{fetcher:async(input,init)=>{
  const response=await fetch(input,init);if(new URL(String(input)).pathname!=='/player/v2/sync')return response;
  const body=await response.json();body.scope.playerId='another-player';return Response.json(body);
 }});
 await assert.rejects(x.client.sync(),/IDENTITY_OR_EPOCH_MISMATCH/);assert.equal(x.client.state.snapshot,null);
});

test('a late pinned snapshot returns its fixed cut without replacing a newer live document',async t=>{
 let held=false,release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});t.after(()=>release());
 const x=await sdkFixture(t,{fetcher:async(input,init)=>{
  const response=await fetch(input,init);
  if(new URL(String(input)).pathname==='/player/v2/snapshot'&&!held){held=true;entered();await gate;}
  return response;
 }});
 const pending=x.client.snapshot();await started;
 x.h.apply(x.h.command('newer-live-cut'));const latest=await x.client.sync();const cursor=x.client.state.cursor;
 release();const old=await pending;
 assert.notEqual((old.observation as PlayerObservation).revision,(latest.document!.observation as PlayerObservation).revision);
 assert.equal(x.client.state.cursor,cursor);assert.deepEqual(x.client.state.snapshot,latest.document);
});

test('live synchronization refreshes control loss without authorizing further writes',async t=>{
 const x=await sdkFixture(t);await x.client.acquire();await x.client.sync();assert.equal(x.client.writable,true);
 x.h.repository.ownerControl('fixture-room',0,{action:'takeover',mode:'manual'});
 await x.client.sync();assert.equal(x.client.writable,false);
});

test('live synchronization waits outside the room executor and installs incoming private changes',async t=>{
 const x=await sdkFixture(t);await x.client.sync();let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});t.after(()=>release());
 t.mock.method(x.h.repository,'waitForEvents',async()=>{entered();await gate;});
 const pending=x.client.sync(1000);await started;
 await x.client.control(); // Would deadlock if synchronization held the executor.
 x.h.repository.domainEvent('fixture-room',0,'chat.changed',{cursor:'1'},true);
 release();const changed=await pending;assert.ok(changed.document);
});

test('live synchronization accepts expired equality cursors but never another seat session',async t=>{
 const x=await sdkFixture(t),headers={Authorization:'Bearer '+x.settings.token};
 const refreshed=await fetch(x.settings.serverUrl+'/player/v2/sync?after=expired-cursor',{headers});
 assert.equal(refreshed.status,200);assert.ok((await refreshed.json()).document);
 const other=x.h.grant(1,['observe','events.read']);
 const denied=await fetch(x.settings.serverUrl+'/player/v2/sync?sessionId='+x.h.session,{headers:{Authorization:'Bearer '+other.token}});
 assert.notEqual(denied.status,200,'sessions cannot cross their grant-scoped player identity');
 const own=await fetch(x.settings.serverUrl+'/player/v2/sync',{headers:{Authorization:'Bearer '+other.token}});
 assert.equal(own.status,200);assert.equal((await own.json()).document.observation.view.player,1);
 for(const scopes of [['observe'],['events.read']] as const){
  const grant=x.h.grant(0,[...scopes]);
  const missing=await fetch(x.settings.serverUrl+'/player/v2/sync',{headers:{Authorization:'Bearer '+grant.token}});
  assert.equal(missing.status,403,'live synchronization requires both read scopes');
 }
});

test('a pre-acquisition sync response cannot revoke a subsequently acquired lease',async t=>{
 let held=false,release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});t.after(()=>release());
 const x=await sdkFixture(t,{fetcher:async(input,init)=>{
  const response=await fetch(input,init);
  if(new URL(String(input)).pathname==='/player/v2/sync'&&!held){held=true;entered();await gate;}
  return response;
 }});
 const pending=x.client.sync();await started;await x.client.acquire();release();await pending;
 assert.equal(x.client.writable,true);
});

test('complete local activity facts need no history request and malformed facts still fail',async t=>{
 const x=await sdkFixture(t),initial=(await x.client.sync()).document!.observation as PlayerObservation;
 x.h.apply(x.h.command('live-departure',{payload:{action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:27}}}));
 const current=(await x.client.sync()).document!.observation as PlayerObservation;
 assert.ok(current.activityCursor!>initial.activityCursor!);
 const facts=new ActivityFacts();facts.baseline=()=>({roomId:initial.roomId,player:0,activityCursor:initial.activityCursor,manualVersion:initial.manualCommands?.version});
 let reads=0;const hydrated=await facts.hydrate(current,async()=>{reads++;throw Error('Unexpected history read');});
 assert.equal(reads,0);assert.deepEqual(hydrated.activity,current.activity);
 const corrupt=structuredClone(current);corrupt.activity![0]!.id=current.activityCursor!;
 await assert.rejects(facts.hydrate(corrupt,async()=>{throw Error('Unexpected history read');}),/Invalid activity snapshot fact/);
});

test('an independent old fact cut remains old after a newer durable acknowledgement',async t=>{
 const x=await sdkFixture(t),old=(await x.client.sync()).document!.observation as PlayerObservation,facts=new ActivityFacts();
 const baseline={roomId:old.roomId,player:old.view.player,activityCursor:old.activityCursor!+1,manualVersion:old.manualCommands!.version+1};facts.baseline=()=>baseline;
 let reads=0;const read=async()=>{reads++;throw Error('Old cut must not backfill from the future');};
 const hydrated=await facts.hydrate(old,read,read);assert.deepEqual(hydrated,old);assert.equal(reads,0);assert.equal(baseline.activityCursor,old.activityCursor!+1);
 facts.baseline=()=>({...baseline,roomId:'other-room'});await assert.rejects(facts.hydrate(old,read,read),/scope mismatch/);
 facts.baseline=()=>({...baseline,activityCursor:-1});await assert.rejects(facts.hydrate(old,read,read),/Invalid activity fact baseline/);
});
