import {once} from 'node:events';
import {join} from 'node:path';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {protocolHarness} from './player-protocol-test-helpers.js';
import {createPlayerProtocolApi} from '../packages/server/src/player-protocol-api.js';
import {SerialExecutor} from '../packages/server/src/player-access.js';
import {PlayerProtocolClient,MemoryProtocolClientStore,type ProtocolClientStore} from '../packages/player-sdk/src/index.js';
import type {PlayerObservation} from '../packages/contracts/src/index.js';
export async function sdkFixture(t:TestContext,options:{fetcher?:typeof fetch;store?:(path:string)=>ProtocolClientStore}={}){
  const h=protocolHarness(t);h.elapsed+=31000;const server=createPlayerProtocolApi({repository:h.repository,roomId:'fixture-room',serial:new SerialExecutor(),load:()=>h.store.load()!,commit:(room,revision)=>h.store.commit(room,revision)});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const path=join(h.dir,'client.sqlite'),store=options.store?.(path)??new MemoryProtocolClientStore(),settings={serverUrl:`http://127.0.0.1:${address.port}`,token:h.first.token,store,expectedIdentity:{roomId:'fixture-room',gamePlayer:0},optionalCapabilities:['actions.order/1','sse/1','state.sync/1'],...(options.fetcher?{fetch:options.fetcher}:{})};const client=new PlayerProtocolClient(settings);
  const intent=async(id='sdk-conformance')=>({idempotencyKey:id,clientCommandId:id,expectedRevision:((await client.snapshot()).observation as PlayerObservation).revision,instructionsVersion:'0',kind:'order' as const,payload:{action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}});
  return{h,server,client,settings,path,store,intent};
}
