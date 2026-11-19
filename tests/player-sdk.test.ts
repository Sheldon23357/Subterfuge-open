import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {PlayerProtocolClient,MemoryProtocolClientStore,FileProtocolClientStore,PlayerProtocolClientError,type ProtocolClientStore} from '../packages/player-sdk/src/index.js';
import {SqliteProtocolClientStore} from '../packages/ai/src/controller/transport/protocol-store.js';
import {protocolHarness} from './player-protocol-test-helpers.js';
import {createPlayerProtocolApi} from '../packages/server/src/player-protocol-api.js';
import {SerialExecutor} from '../packages/server/src/player-access.js';
import type {PlayerObservation,ProtocolEvent,ProtocolEventPage} from '../packages/contracts/src/index.js';
async function setup(t:TestContext,options:{fetcher?:typeof fetch;store?:(path:string)=>ProtocolClientStore;afterAdmission?:()=>Promise<void>}={}){
  const h=protocolHarness(t);h.elapsed+=31000;
  const server=createPlayerProtocolApi({repository:h.repository,roomId:'fixture-room',serial:new SerialExecutor(),load:()=>h.store.load()!,commit:(room,revision)=>h.store.commit(room,revision),...(options.afterAdmission?{afterAdmission:options.afterAdmission}:{})});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const store=options.store?.(join(h.dir,'private-transport.json'))??new MemoryProtocolClientStore();
  const settings={serverUrl:`http://127.0.0.1:${address.port}`,token:h.first.token,store,expectedIdentity:{roomId:'fixture-room',gamePlayer:0},optionalCapabilities:['actions.order/1'],...(options.fetcher?{fetch:options.fetcher}:{})};
  const client=new PlayerProtocolClient(settings);
  const intent=async(id='sdk-command')=>({idempotencyKey:id,clientCommandId:id,expectedRevision:((await client.snapshot()).observation as PlayerObservation).revision,instructionsVersion:'0',kind:'order' as const,payload:{action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}});
  return {h,server,client,store,settings,intent};
}
test('a definitive first-attempt admission rejection settles the outbox without disabling an owned lease',async t=>{
 const x=await setup(t,{fetcher:async(input,init)=>String(input).endsWith('/commands')?new Response(JSON.stringify({code:'REVISION_CONFLICT',outcome:'rejected'}),{status:409}):fetch(input,init)});
 await x.client.acquire();const intent=await x.intent('admission-rejected');
 await assert.rejects(x.client.command(intent),(e:unknown)=>e instanceof PlayerProtocolClientError&&e.code==='REVISION_CONFLICT');
 const row=Object.values(x.client.state.outbox)[0]!;assert.equal(row.state,'settled');assert.equal(row.attempts,1);assert.equal(row.reason,'REVISION_CONFLICT');assert.equal(x.client.writable,true);
 await assert.rejects(x.client.command(intent));assert.equal(Object.values(x.client.state.outbox)[0]!.attempts,1);await x.client.release();
});
test('SDK explicitly negotiates v2, defaults paused and commits one game effect',async t=>{
  const x=await setup(t);await x.client.connect();assert.equal(x.client.writable,false);const intent=await x.intent();
  await assert.rejects(x.client.command(intent),(e:unknown)=>e instanceof PlayerProtocolClientError&&e.code==='WRITE_PAUSED');
  await x.client.acquire();const receipt=await x.client.command(intent);assert.equal(receipt.state,'applied');assert.equal(x.h.store.load()!.room.state.commands.length,1);
  assert.deepEqual(await x.client.command(intent),receipt);assert.equal(x.h.store.load()!.room.state.commands.length,1);
  await assert.rejects(x.client.command({...intent,payload:{action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:true}}}),/IDEMPOTENCY_CONFLICT/);
  await x.client.release();assert.equal(x.client.writable,false);
});
test('SDK persists before send and recovers a dropped committed response after process reconstruction',async t=>{
  let dropped=false,store:ProtocolClientStore;const x=await setup(t,{store:path=>store=new FileProtocolClientStore(path),fetcher:async(input,init)=>{
    if(String(input).endsWith('/commands')){assert.equal(Object.values(store.load().outbox)[0]?.state,'unknown');const response=await fetch(input,init);await response.text();dropped=true;throw Error('synthetic socket reset');}return fetch(input,init);
  }});
  await x.client.acquire();await assert.rejects(x.client.command(await x.intent()),/TRANSPORT_UNCONFIRMED/);assert.equal(dropped,true);assert.equal(x.client.writable,false);
  const restarted=new PlayerProtocolClient({...x.settings,fetch});assert.equal(restarted.writable,false);await restarted.connect();const result=await restarted.reconcile();assert.equal(result[0]!.receipt?.state,'applied');assert.equal(result[0]!.state,'settled');assert.equal(x.h.store.load()!.room.state.commands.length,1);
  assert.ok(!readFileSync((x.store as FileProtocolClientStore).path,'utf8').includes(x.h.first.token));
});
test('SDK renegotiates an expired server session before an explicit control retry',async t=>{
 let hellos=0,expire=false;
 const x=await setup(t,{fetcher:async(input,init)=>{
  const path=new URL(String(input)).pathname;
  if(path.endsWith('/sessions/hello'))hellos++;
  if(expire&&path.endsWith('/control')){expire=false;return Response.json({code:'LEASE_LOST',outcome:'rejected'},{status:409});}
  return fetch(input,init);
 }});
 await x.client.connect();assert.equal(hellos,1);
 expire=true;await assert.rejects(x.client.control(),/LEASE_LOST/);
 assert.equal(x.client.hello,null);assert.equal(x.client.writable,false);
 await x.client.acquire();assert.equal(hellos,2);assert.equal(x.client.writable,true);
});

test('SDK accepted-but-unsettled commands remain blocked without blind retransmission',async t=>{
  const x=await setup(t,{afterAdmission:async()=>{throw Error('synthetic crash after admission');}});await x.client.acquire();await assert.rejects(x.client.command(await x.intent()),/STORAGE_UNAVAILABLE/);
  const rows=await x.client.reconcile();assert.equal(rows[0]?.state,'accepted');await assert.rejects(x.client.acquire(),/UNRESOLVED_OUTBOX/);assert.equal(x.h.store.load()!.room.state.commands.length,0);
});
test('SDK unavailable ledger history cannot turn an unknown write into a fresh command',async t=>{
  let deny=false;const x=await setup(t,{fetcher:async(input,init)=>{if(deny&&String(input).endsWith('/commands/lookup')){const body=JSON.parse(String(init?.body));const old=x.client.state.scope!;return Response.json({scope:old,results:body.idempotencyKeys.map((idempotencyKey:string)=>({status:'history_unavailable',idempotencyKey,coverage:{roomEpoch:body.roomEpoch,authoritative:false,retained:'unavailable',queryUntil:null}}))});}if(String(input).endsWith('/commands'))throw Error('offline before known outcome');return fetch(input,init);}});
  await x.client.acquire();await assert.rejects(x.client.command(await x.intent()));deny=true;assert.equal((await x.client.reconcile())[0]?.state,'blocked');await assert.rejects(x.client.acquire(),/UNRESOLVED_OUTBOX/);assert.equal(x.h.store.load()!.room.state.commands.length,0);
});
test('SDK events atomically apply materialized state and cursor; reducer failures leave both untouched',async t=>{
  const x=await setup(t);await x.client.acquire();await x.client.snapshot();const before=x.client.state;await x.client.command(await x.intent());
  const cut=x.client.state;await assert.rejects(x.client.events((_event,state)=>{state.mutation='must rollback';throw Error('application failed');}),/application failed/);
  assert.equal(x.client.state.cursor,cut.cursor);assert.deepEqual(x.client.state.application,{});
  const page=await x.client.events((event,state)=>{state.last=event.seq;});assert.ok(page.events.length>0);assert.equal(x.client.state.cursor,page.nextCursor);assert.equal(x.client.state.application.last,page.coverage.toInclusive);assert.notEqual(before.cursor,x.client.state.cursor);
});
test('SDK rejects event gaps and unknown required events without advancing cursor',async t=>{
  let mode:'gap'|'unknown'='gap';const x=await setup(t,{fetcher:async(input,init)=>{
    const response=await fetch(input,init);if(!String(input).includes('/events?'))return response;const page=await response.json() as ProtocolEventPage;
    const event:ProtocolEvent={scope:page.scope,streamEpoch:page.streamEpoch,seq:(BigInt(page.coverage.fromExclusive)+(mode==='gap'?2n:1n)).toString(),cursor:'bad-cursor',type:mode==='gap'?'observation.changed':'future.required',schemaVersion:1,required:true,payload:{}};
    return Response.json({...page,events:[event],nextCursor:event.cursor,coverage:{...page.coverage,toInclusive:event.seq}});
  }});
  await x.client.snapshot();const before=x.client.state.cursor;await assert.rejects(x.client.events(),/RESYNC_REQUIRED/);assert.equal(x.client.state.cursor,before);mode='unknown';await assert.rejects(x.client.events(),/UNSUPPORTED_REQUIRED_EVENT/);assert.equal(x.client.state.cursor,before);assert.equal(x.client.state.safetyStop,'unsupported-required-event');
});
test('SDK validates same-cut pagination and digest before replacing snapshot',async t=>{
  let corrupt=false;const x=await setup(t,{fetcher:async(input,init)=>{const response=await fetch(input,init);if(corrupt&&String(input).endsWith('/snapshot')){const page=await response.json();page.page.text+=' ';return Response.json(page);}return response;}});
  await x.client.snapshot();const before=x.client.state;corrupt=true;await assert.rejects(x.client.snapshot(),/digest mismatch/);assert.deepEqual(x.client.state,before);
});
test('SDK receipt updates ignore lower versions and reject conflicting equal versions',async t=>{
  let older=false,conflict=false;const x=await setup(t,{fetcher:async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith('/commands/lookup')&&(older||conflict)){const body=await response.json();for(const found of body.results){found.receipt.receiptVersion=older?'1':'2';found.receipt.state='accepted';found.receipt.effectCommitted=false;}return Response.json(body);}return response;}});
  await x.client.acquire();const result=await x.client.command(await x.intent());x.store.transaction(s=>{Object.values(s.outbox)[0]!.state='unknown';});older=true;await x.client.reconcile();assert.equal(Object.values(x.client.state.outbox)[0]!.receipt!.state,'applied');older=false;conflict=true;await assert.rejects(x.client.reconcile(),/same version/);assert.equal(Object.values(x.client.state.outbox)[0]!.receipt!.commandId,result.commandId);
});
test('SQLite private adapter rolls back cursor and outbox together and survives reopen',t=>{
  const h=protocolHarness(t),path=join(h.dir,'private.sqlite'),store=new SqliteProtocolClientStore(path);store.transaction(s=>{s.cursor='original';});assert.throws(()=>store.transaction(s=>{s.cursor='lost';s.application.x=1;throw Error('abort');}));store.close();const reopened=new SqliteProtocolClientStore(path);assert.equal(reopened.load().cursor,'original');assert.deepEqual(reopened.load().application,{});reopened.close();
});
test('SDK forbids downgrade, remote HTTP credentials, mismatched identity and unsafe extension paths',async t=>{
  const x=await setup(t);assert.throws(()=>new PlayerProtocolClient({...x.settings,serverUrl:'http://example.invalid'}),/HTTPS/);
  const wrong=new PlayerProtocolClient({...x.settings,expectedIdentity:{roomId:'fixture-room',gamePlayer:1}});await assert.rejects(wrong.connect(),/IDENTITY_MISMATCH/);
  const unsupported=new PlayerProtocolClient({...x.settings,requiredCapabilities:['missing/9']});await assert.rejects(unsupported.connect(),/PROTOCOL_INCOMPATIBLE/);
  await assert.rejects(x.client.extensionRequest('core/2','/owner/grants',{}),/extension endpoint/);
});
test('SDK epoch changes pin old outbox and cannot acquire or replay under a new epoch',async t=>{
  const x=await setup(t);await x.client.acquire();await x.client.command(await x.intent());const original=x.client.state;
  const restarted=new PlayerProtocolClient({...x.settings,fetch:async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith('/sessions/hello')){const body=await response.json();body.scope.roomEpoch='new-epoch';body.identity.roomEpoch='new-epoch';return Response.json(body);}return response;}});
  await assert.rejects(restarted.connect(),/epoch-changed/);assert.deepEqual(restarted.state.outbox,original.outbox);assert.equal(restarted.state.scope?.roomEpoch,original.scope?.roomEpoch);assert.equal(restarted.writable,false);await assert.rejects(restarted.acquire());await assert.rejects(restarted.snapshot(),/epoch-changed/);assert.equal(restarted.state.cursor,original.cursor);assert.deepEqual(restarted.state.snapshot,original.snapshot);
});
test('SDK ignores wall clock for lease safety and refuses expired fences before network transmission',async t=>{
  const x=await setup(t);let elapsed=100;const client=new PlayerProtocolClient({...x.settings,monotonicNow:()=>elapsed});await client.acquire();elapsed+=30000;assert.equal(client.writable,false);await assert.rejects(client.command(await x.intent()),/WRITE_PAUSED/);assert.equal(x.h.store.load()!.room.state.commands.length,0);
});
test('SDK event counters larger than IEEE754 safe integers retain exact ordering',async t=>{
  const x=await setup(t,{fetcher:async(input,init)=>{const response=await fetch(input,init);if(!String(input).includes('/events?'))return response;const page={scope:x.client.state.scope,streamEpoch:x.client.state.streamEpoch};const seq='9007199254740994';return Response.json({...page,inputCursor:'large-start',nextCursor:'large-end',events:[{scope:page.scope,streamEpoch:page.streamEpoch,seq,cursor:'large-end',type:'future.optional',schemaVersion:1,required:false,payload:{}}],hasMore:false,coverage:{fromExclusive:'9007199254740993',toInclusive:seq}});}});
  await x.client.snapshot();x.store.transaction(s=>{s.sequence='9007199254740993';s.cursor='large-start';});await x.client.events();assert.equal(x.client.state.sequence,'9007199254740994');
});
test('Official private database keeps AI state and transport state through live WAL backup and reopening',async t=>{
  const {AiStore}=await import('../packages/ai/src/controller/storage/store.js'),{initialState}=await import('../packages/ai/src/controller/contracts/types.js'),{backupCheckpointDatabase}=await import('../packages/ai/src/controller/storage/checkpoint-files.js');
  const h=protocolHarness(t),path=join(h.dir,'seat.sqlite'),backup=join(h.dir,'checkpoint.sqlite'),ai=new AiStore(path),state=initialState('fixture-room',0,{model:'synthetic',personality:'schemer'});ai.save(state,'test-fixture');
  const transport=new SqliteProtocolClientStore(path);transport.transaction(s=>{s.cursor='durable-cursor';s.scope=h.repository.scope('fixture-room',h.authority.roomEpoch,0);s.application.receipts=['synthetic-only'];});
  ai.save({...state,sequence:7},'test-second-connection');assert.equal(transport.load().cursor,'durable-cursor');backupCheckpointDatabase(path,backup);transport.close();ai.close();
  const restoredAi=new AiStore(backup),restoredTransport=new SqliteProtocolClientStore(backup);assert.equal(restoredAi.load('fixture-room',0)!.sequence,7);assert.equal(restoredTransport.load().cursor,'durable-cursor');assert.equal(restoredTransport.load().scope?.roomEpoch,h.authority.roomEpoch);assert.deepEqual(restoredTransport.load().application.receipts,['synthetic-only']);restoredTransport.close();restoredAi.close();
});
for(const intervention of ['pause','release','deadline'] as const)test(`SDK delayed renewal cannot resurrect control after ${intervention}`,async t=>{
  let releaseResponse!:()=>void,observed!:()=>void;const gate=new Promise<void>(resolve=>{releaseResponse=resolve;}),seen=new Promise<void>(resolve=>{observed=resolve;});let elapsed=100;
  const x=await setup(t,{fetcher:async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith('/control/renew')){observed();await gate;}return response;}}),client=new PlayerProtocolClient({...x.settings,monotonicNow:()=>elapsed});
  await client.acquire();const renewal=client.renew();await seen;
  if(intervention==='pause')client.pause();else if(intervention==='release')await client.release();else elapsed+=30000;
  releaseResponse();await assert.rejects(renewal,/CONTROL_RESPONSE_OBSOLETE/);assert.equal(client.writable,false);assert.equal(client.remainingLeaseMs,0);
});
test('SDK late acquisition after pause cannot enable gameplay',async t=>{
  let releaseResponse!:()=>void,observed!:()=>void;const gate=new Promise<void>(resolve=>{releaseResponse=resolve;}),seen=new Promise<void>(resolve=>{observed=resolve;});
  const x=await setup(t,{fetcher:async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith('/control/acquire')){observed();await gate;}return response;}});
  const acquisition=x.client.acquire();await seen;x.client.pause();releaseResponse();await assert.rejects(acquisition,/CONTROL_RESPONSE_OBSOLETE/);assert.equal(x.client.writable,false);
});
test('SDK obsolete renewal cannot overwrite or revoke a newly acquired fence',async t=>{
  let releaseResponse!:()=>void,observed!:()=>void;const gate=new Promise<void>(resolve=>{releaseResponse=resolve;}),seen=new Promise<void>(resolve=>{observed=resolve;});
  const x=await setup(t,{fetcher:async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith('/control/renew')){observed();await gate;}return response;}});
  await x.client.acquire();const old=x.client.authority().fence,renewal=x.client.renew();await seen;await x.client.release();await x.client.acquire();const current=x.client.authority().fence;assert.notEqual(current,old);releaseResponse();await assert.rejects(renewal,/CONTROL_RESPONSE_OBSOLETE/);assert.equal(x.client.writable,true);assert.equal(x.client.authority().fence,current);
});
test('SDK authoritative absence after a lost packet stays unknown until server fence retirement and a second lookup',async t=>{
  let lookups=0;const x=await setup(t,{fetcher:async(input,init)=>{if(String(input).endsWith('/commands'))throw Error('packet outcome unknown');if(String(input).endsWith('/commands/lookup'))lookups++;return fetch(input,init);}});
  await x.client.acquire();await assert.rejects(x.client.command(await x.intent()));assert.equal((await x.client.reconcile())[0]!.state,'unknown');await assert.rejects(x.client.acquire(),/UNRESOLVED_OUTBOX/);
  x.h.elapsed+=31000;const before=lookups;assert.equal((await x.client.reconcile())[0]!.state,'settled');assert.equal(lookups-before,2);assert.equal(x.h.store.load()!.room.state.commands.length,0);
});
test('SDK rejected retry never erases an earlier unknown attempt that committed before revocation',async t=>{
  let saved:{input:RequestInfo|URL;init:RequestInit|undefined}|null=null,attempts=0;const x=await setup(t,{fetcher:async(input,init)=>{
    if(String(input).endsWith('/commands')){attempts++;if(attempts===1){saved={input,init};throw Error('first packet delayed');}
      const original=await fetch(saved!.input,saved!.init);assert.equal(original.status,200);await original.text();x.h.repository.revokeGrant(x.h.first.principal.grantId);return fetch(input,init);
    }return fetch(input,init);
  }});
  await x.client.acquire();await assert.rejects(x.client.command(await x.intent()));await assert.rejects(x.client.reconcile({retryAbsent:true}),/UNAUTHORIZED/);
  const row=Object.values(x.client.state.outbox)[0]!;assert.equal(row.state,'unknown');assert.equal(row.attempts,2);assert.equal(x.h.store.load()!.room.state.commands.length,1);assert.equal(x.client.writable,false);
});
test('SDK pause during handshake prevents a pending acquire from ever being sent',async t=>{
  let releaseResponse!:()=>void,observed!:()=>void,acquires=0;const gate=new Promise<void>(resolve=>{releaseResponse=resolve;}),seen=new Promise<void>(resolve=>{observed=resolve;});
  const x=await setup(t,{fetcher:async(input,init)=>{if(String(input).endsWith('/control/acquire'))acquires++;const response=await fetch(input,init);if(String(input).endsWith('/sessions/hello')){observed();await gate;}return response;}});
  const acquisition=x.client.acquire();await seen;x.client.pause();releaseResponse();await assert.rejects(acquisition,/CONTROL_RESPONSE_OBSOLETE/);assert.equal(acquires,0);assert.equal(x.client.writable,false);
});
test('Official SQLite transport refuses a busy concurrent writer without losing its last commit',async t=>{
  const {DatabaseSync}=await import('node:sqlite');const h=protocolHarness(t),path=join(h.dir,'busy.sqlite'),store=new SqliteProtocolClientStore(path);store.transaction(s=>{s.cursor='committed';});
  const other=new DatabaseSync(path);other.exec('BEGIN IMMEDIATE');try{assert.throws(()=>store.transaction(s=>{s.cursor='must-not-commit';}),/locked|busy/);}finally{other.exec('ROLLBACK');other.close();}
  assert.equal(store.load().cursor,'committed');store.transaction(s=>{s.cursor='after-unlock';});store.close();const reopened=new SqliteProtocolClientStore(path);assert.equal(reopened.load().cursor,'after-unlock');reopened.close();
});
test('SDK rejects malformed UTF-8 responses rather than replacing bytes inside valid JSON',async t=>{
  const x=await setup(t,{fetcher:async()=>new Response(new Uint8Array([123,34,120,34,58,34,255,34,125]),{status:200})});await assert.rejects(x.client.connect(),/INVALID_RESPONSE/);assert.equal(x.client.writable,false);
});
test('SDK accepted responses pause further writes and receipt reconciliation never silently resumes',async t=>{
  const x=await setup(t,{fetcher:async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith('/commands')){const applied=await response.json();return Response.json({...applied,state:'accepted',receiptVersion:'1',effectCommitted:false});}return response;}});
  await x.client.acquire();const intent=await x.intent();assert.equal((await x.client.command(intent)).state,'accepted');assert.equal(x.client.writable,false);await assert.rejects(x.client.command({...intent,idempotencyKey:'must-wait',clientCommandId:'must-wait'}),/WRITE_PAUSED/);
  assert.equal((await x.client.reconcile())[0]!.receipt!.state,'applied');assert.equal(x.client.writable,false);assert.equal(x.h.store.load()!.room.state.commands.length,1);
});


test('request timing covers body reads, strips query values, and cannot alter transport results',async t=>{
 const x=await setup(t);const timings:{path:string;durationMs:number;status:number|null}[]=[];
 const delayedFetch:typeof fetch=async(input,init)=>{const response=await fetch(input,init),bytes=await response.arrayBuffer();return new Response(new ReadableStream({async start(controller){await new Promise(resolve=>setTimeout(resolve,30));controller.enqueue(new Uint8Array(bytes));controller.close();}}),{status:response.status,headers:response.headers});};
 const client=new PlayerProtocolClient({...x.settings,fetch:delayedFetch,onRequestTiming:event=>{timings.push(event);throw Error('synthetic diagnostics failure');}});
 await client.connect();await client.control();
 assert.ok(timings.some(e=>e.path==='/player/v2/control'&&e.status===200));
 assert.ok(timings.every(e=>!e.path.includes('?')&&e.durationMs>=25));
 assert.ok(!JSON.stringify(timings).includes(x.h.first.token));
});
