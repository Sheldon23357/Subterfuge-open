import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {sdkFixture} from './player-sdk-test-helpers.js';
import {PlayerProtocolClient,MemoryProtocolClientStore} from '../packages/player-sdk/src/index.js';
import type {PlayerObservation} from '../packages/contracts/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {ActivityFacts} from '../packages/ai/src/controller/observation/activity-facts.js';
import {createPlayerProtocolApi} from '../packages/server/src/player-protocol-api.js';
import {SerialExecutor} from '../packages/server/src/player-access.js';
import {protocolHarness} from './player-protocol-test-helpers.js';
import {readActivity} from '../packages/engine/src/notification-journal.js';
import {submitFleetOrder} from '../packages/engine/src/index.js';

test('verified room replay cache preserves immutable activity heads across isolated world clones',t=>{
 const h=protocolHarness(t),first=h.store.load()!.room,second=h.store.load()!.room;
 const original=readActivity(first.state,0);assert.ok(original);assert.deepEqual(readActivity(second.state,0),original);
 const home=first.state.economy.outposts.find(p=>p.owner===0)!;
 const advanced=submitFleetOrder(first.state,{id:'only-local-clone',player:0,action:{kind:'set-shields',outpostId:home.id,enabled:false}}).state;
 assert.ok(readActivity(advanced,0)!.length>original.length);
 assert.deepEqual(readActivity(first.state,0),original);assert.deepEqual(readActivity(h.store.load()!.room.state,0),original);
 home.drillers=0;assert.notEqual(h.store.load()!.room.state.economy.outposts.find(p=>p.id===home.id)!.drillers,0);
});

test('scoped HTTP activity pages recover more than one event page at a pinned snapshot cut after restart',async t=>{
 const x=await sdkFixture(t);
 let serverUrl=x.settings.serverUrl;
 const create=()=>new PlayerProtocolClient({...x.settings,serverUrl,store:new MemoryProtocolClientStore(),optionalCapabilities:['activity.read/1']});
 const client=create(),initial=(await client.snapshot()).observation as PlayerObservation;
 for(let i=0;i<225;i++){
  x.h.apply(x.h.command(`activity-${i}`,{payload:{action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:i%2===1}}}));
  x.h.repository.observe('fixture-room',0,observation(x.h.store.load()!.room,0,'fixture-room').revision,x.h.store.load()!.room.state.economy.tick);
  // The fixture shares the HTTP event loop. Let expired idle connections close
  // during this long synchronous history build, as they do in separate hosts.
  if(i%10===9)await new Promise<void>(resolve=>setImmediate(resolve));
 }
 let pages=0;
 while((await client.events()).hasMore)pages++;
 assert.ok(pages>=2,'event transport must consume all pages, not install a newer snapshot over a backlog');
 const current=(await client.snapshot()).observation as PlayerObservation;
 assert.equal(current.activity!.length,10);assert.ok(current.activityCursor!>=225);
 const facts=new ActivityFacts();facts.baseline=()=>({roomId:initial.roomId,player:initial.view.player,activityCursor:initial.activityCursor,manualVersion:initial.manualCommands?.version});
 let activityPages=0;
 const full=await facts.hydrate(current,async(after,through)=>{
  activityPages++;
  return client.extensionRequest('activity.read/1',`/activity?after=${after}&through=${through}&limit=100`);
 });
 assert.ok(activityPages>=3);assert.equal(full.activity!.length,current.activityCursor!-initial.activityCursor!);
 const pinned=current.activityCursor!;
 x.h.apply(x.h.command('after-cut',{payload:{action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:true}}}));
 const replay=await facts.hydrate(current,(after,through)=>client.extensionRequest('activity.read/1',`/activity?after=${after}&through=${through}&limit=100`));
 assert.deepEqual(replay.activity,full.activity,'newer activity cannot enter an older snapshot');
 x.server.closeAllConnections();await new Promise<void>(resolve=>x.server.close(()=>resolve()));
 x.h.restart();
 const server=createPlayerProtocolApi({repository:x.h.repository,roomId:'fixture-room',serial:new SerialExecutor(),load:()=>x.h.store.load()!,commit:(room,revision)=>x.h.store.commit(room,revision)});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const address=server.address();assert.ok(address&&typeof address==='object');serverUrl=`http://127.0.0.1:${address.port}`;
 const restarted=create(),restored=(await restarted.snapshot()).observation as PlayerObservation;
 const page=await restarted.extensionRequest('activity.read/1',`/activity?after=0&through=${pinned}&limit=100`) as {events:unknown[]};
 assert.deepEqual(page.events,full.activity!.slice(0,100));assert.ok(restored.activityCursor!>pinned);
 await assert.rejects(restarted.extensionRequest('activity.read/1',`/activity?after=0&through=${pinned+1000}&limit=100`),/INVALID_REQUEST/);
 await assert.rejects(restarted.extensionRequest('activity.read/1',`/activity?after=0&after=1&through=${pinned}`),/INVALID_REQUEST/);
});
