import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PlayerProtocolClient,parseManualCommandView,parseManualCommandReceiptPage} from '../packages/player-sdk/src/index.js';
import {sdkFixture} from './player-sdk-test-helpers.js';
import type {ManualCommandView,ProtocolEventPage} from '../packages/contracts/src/index.js';
const view:ManualCommandView={version:1,receiptsFromVersion:1,hasEarlierReceipts:false,receipts:[{id:'manual:0:1',version:1,player:0,tick:5,seconds:0,kind:'order',orderId:'test-manual',action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false},outcome:'applied',affectedFleetIds:[],cancelledScheduleIds:[]}],protections:[{receiptId:'manual:0:1',kind:'outpost',scope:['outpost:蓝方工厂','action:set-shields']}]};
test('manual mine cancellation protection survives SDK parsing',()=>{
 const cancelled:ManualCommandView={...structuredClone(view),receipts:[{...view.receipts[0]!,action:{kind:'toggle-mine',outpostId:'蓝方工厂'}}],protections:[{receiptId:'manual:0:1',kind:'outpost',scope:['outpost:蓝方工厂','action:toggle-mine']}]};
 assert.deepEqual(parseManualCommandView(cancelled,0),cancelled);
 const funding:ManualCommandView={...structuredClone(view),receipts:[{...view.receipts[0]!,action:{kind:'toggle-funding',recipient:1}}],protections:[{receiptId:'manual:0:1',kind:'funding',scope:['recipient:1']}]};
 assert.deepEqual(parseManualCommandView(funding,0),funding);
 assert.throws(()=>parseManualCommandView({...cancelled,protections:[{...cancelled.protections[0],kind:'toString'}]}),/protection/);
});

test('SDK reads archived release facts without exposing a release operation',()=>{
 const release={id:'manual:0:2',version:2,player:0,tick:5,seconds:0,kind:'release-protection' as const,outcome:'released' as const,operationId:'release-1',releasedReceiptIds:['manual:0:1'],releasedScopes:['action:set-shields','outpost:蓝方工厂'],affectedFleetIds:[],cancelledScheduleIds:[]};
 const released:ManualCommandView={...view,version:2,receipts:[...view.receipts,release],protections:[]};
 assert.deepEqual(parseManualCommandView(released,0),released);
 assert.deepEqual(parseManualCommandReceiptPage({version:2,receipts:[release],nextCursor:2,hasMore:false},0).receipts,[release]);
 for(const changed of [{outcome:'applied'},{operationId:undefined},{releasedReceiptIds:[]},{releasedReceiptIds:['manual:0:1','manual:0:1']},{releasedScopes:undefined},{releasedScopes:[]},{cancelledScheduleIds:['would-cancel']},{action:{kind:'set-shields'}}])assert.throws(()=>parseManualCommandView({...released,receipts:[{...release,...changed}]}));
 assert.throws(()=>parseManualCommandView({...view,receipts:[{...view.receipts[0],releasedReceiptIds:['manual:0:1']}]}),/release fact/);
});
test('manual command parser validates facts, seat identity, protected targets and exact numeric versions',()=>{
 assert.deepEqual(parseManualCommandView(view,0),view);
 assert.deepEqual(parseManualCommandReceiptPage({version:1,receipts:view.receipts,nextCursor:1,hasMore:false},0).receipts,view.receipts);
 assert.throws(()=>parseManualCommandReceiptPage({version:1,receipts:view.receipts,nextCursor:0,hasMore:false},0),/cursor/);
 assert.throws(()=>parseManualCommandReceiptPage({version:1,receipts:[],nextCursor:0,hasMore:true},0),/page/);
 assert.throws(()=>parseManualCommandView(view,1),/identity mismatch/);
 for(const version of [-1,1.5,Number.MAX_SAFE_INTEGER+1,'1'])assert.throws(()=>parseManualCommandView({...view,version}));
 assert.throws(()=>parseManualCommandView({...view,receipts:[{...view.receipts[0],outcome:'scheduled'}]}),/outcome/);
 assert.throws(()=>parseManualCommandView({...view,protections:[{receiptId:'manual:0:1',kind:'human',scope:['outpost:base']}]}),/protection/);
 assert.throws(()=>parseManualCommandView({...view,receipts:[view.receipts[0],view.receipts[0]]}),/Duplicate/);
 const copied=parseManualCommandView(view);copied.receipts[0]!.action!.enabled=true;assert.equal(view.receipts[0]!.action!.enabled,false);
});
test('negotiated manual facts survive reconstruction, invalidate on ordinary observation events and refresh without resuming writes',async t=>{
 let current:ManualCommandView=structuredClone(view),emit=false;
 const x=await sdkFixture(t,{fetcher:async(input,init)=>{
   const response=await fetch(input,init),path=new URL(String(input)).pathname;
   if(path==='/player/v2/snapshot'){
     const page=await response.json();assert.equal(page.page.count,1);
     const payload=JSON.parse(page.page.text);payload.observation.manualCommands=current;page.page.text=JSON.stringify(payload);page.snapshotDigest=createHash('sha256').update(page.page.text).digest('hex');
     // The simulated event is a legitimate same-stream cut in this isolated test transport.
     if(emit){page.highWatermark=x.store.load().sequence;page.cursor=x.store.load().cursor;}
     return Response.json(page);
   }
   if(path==='/player/v2/events'&&emit){
     const page=await response.json() as ProtocolEventPage,seq=(BigInt(page.coverage.fromExclusive)+1n).toString(),event={scope:page.scope,streamEpoch:page.streamEpoch,seq,cursor:'synthetic-manual-cursor',type:'observation.changed',schemaVersion:1,required:true,payload:{}};
     return Response.json({...page,events:[event],nextCursor:event.cursor,coverage:{...page.coverage,toInclusive:seq}});
   }
   return response;
 }});
 const client=new PlayerProtocolClient({...x.settings,optionalCapabilities:['actions.order/1','manual-commands/1']});
 assert.equal(client.manualCommands,null);await client.connect();assert.ok(client.hasCapability('manual-commands/1'));await client.snapshot();assert.deepEqual(client.manualCommands,view);assert.equal(client.writable,false);
 const restarted=new PlayerProtocolClient({...x.settings,optionalCapabilities:['actions.order/1','manual-commands/1']});assert.equal(restarted.manualCommands,null);await restarted.connect();assert.deepEqual(restarted.manualCommands,view);assert.equal(restarted.writable,false);
 const outbox=structuredClone(x.store.load().outbox);emit=true;await restarted.events();assert.equal(restarted.manualCommands,null);assert.equal(restarted.state.needsSnapshot,true);assert.deepEqual(restarted.state.outbox,outbox);
 current={...current,version:2,receipts:[...current.receipts,{...current.receipts[0]!,id:'manual:0:2',version:2,orderId:'test-manual-2'}]};await restarted.snapshot();assert.equal((restarted.manualCommands as ManualCommandView|null)?.version,2);assert.equal(restarted.writable,false);
 current={...current,version:3,receipts:[...current.receipts,{id:'manual:0:3',version:3,player:0,tick:5,seconds:0,kind:'release-protection',outcome:'released',operationId:'reconnect-release',releasedReceiptIds:['manual:0:1'],releasedScopes:['outpost:蓝方工厂'],affectedFleetIds:[],cancelledScheduleIds:[]}],protections:[]};
 await restarted.snapshot();assert.deepEqual(restarted.manualCommands,current);assert.equal(restarted.writable,false);
 const committed=restarted.state;current=structuredClone(view);await assert.rejects(restarted.snapshot(),/version regressed/);assert.deepEqual(restarted.state,committed);
});
test('manual capability is opt-in and does not expose an owner command or human role path',async t=>{
 const x=await sdkFixture(t);await x.client.connect();await x.client.snapshot();assert.equal(x.client.hasCapability('manual-commands/1'),false);assert.equal(x.client.manualCommands,null);
 const negotiated=new PlayerProtocolClient({...x.settings,optionalCapabilities:['manual-commands/1']});await negotiated.connect();assert.deepEqual((await negotiated.extensionRequest('manual-commands/1','/manual-commands?after=0&limit=100') as {receipts:unknown[]}).receipts,[]);await assert.rejects(negotiated.extensionRequest('core/2','/manual-commands'),/UNSUPPORTED_CAPABILITY/);await assert.rejects(negotiated.extensionRequest('manual-commands/1','/owner/commands',{}),/extension endpoint/);await assert.rejects(negotiated.extensionRequest('manual-commands/1','/manual-commands/release',{}),/extension endpoint/);
});
