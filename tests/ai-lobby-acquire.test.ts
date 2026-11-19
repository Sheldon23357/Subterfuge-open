import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {ProtocolPlayerGateway} from '../packages/ai/src/controller/transport/protocol-gateway.js';
import {GameRequestError,GameTransportError} from '../packages/ai/src/controller/transport/gateway.js';

async function flush(){await new Promise<void>(resolve=>setImmediate(resolve));for(let i=0;i<30;i++)await Promise.resolve();}
function fixture(t:TestContext,fetcher?:typeof fetch){
  t.mock.timers.enable({apis:['setTimeout']});
  // Native AbortSignal.timeout uses an internal clock. Tie it to the same
  // virtual clock as timers/promises so deadlines are exercised without sleep.
  t.mock.method(AbortSignal,'timeout',(ms:number)=>{
    const controller=new AbortController();
    setTimeout(()=>controller.abort(new DOMException('Timed out','TimeoutError')),ms);
    return controller.signal;
  });
  let status='waiting',reads=0,acquires=0,identityChecks=0;
  const gateway=new ProtocolPlayerGateway({id:'seat',serverUrl:'http://127.0.0.1:4312',roomId:'test-lobby',lobbySeat:1,gamePlayer:1,chatPlayer:1,chatCount:2,lobbyConnection:true,tokenEnv:'TEST_TOKEN',settings:{model:'',personality:'schemer'}},'synthetic-token',undefined,{fetch:fetcher??(async()=>{
    reads++;return Response.json({roomId:'test-lobby',player:1,occupied:[true,true],status,gameSeat:0});
  })});
  t.mock.method(gateway,'checkIdentity',async()=>{identityChecks++;return {} as never;});
  t.mock.method(gateway.client,'control',async()=>({mode:'manual'} as never));
  t.mock.method(gateway.client,'acquire',async()=>{acquires++;return {} as never;});
  // Post-acquisition synchronization has its own protocol integration tests.
  t.mock.method(gateway as any,'document',async()=>({}));
  t.after(()=>{gateway.cancelAcquire();gateway.close();});
  return {gateway,setStatus:(value:string)=>{status=value;},get reads(){return reads;},get acquires(){return acquires;},get identityChecks(){return identityChecks;}};
}

test('a bot can wait past 35 seconds and five minutes, then acquire once when the host starts',async t=>{
  const f=fixture(t);let failure:unknown,completed=false;
  const task=f.gateway.acquire().then(()=>{completed=true;},error=>{failure=error;});
  await flush();assert.equal(f.gateway.waitingForGame,true);
  for(let i=0;i<61;i++){t.mock.timers.tick(5000);await flush();}
  assert.equal(failure,undefined);assert.equal(completed,false);
  assert.equal(f.gateway.waitingForGame,true);assert.ok(f.reads>35);
  assert.equal(f.identityChecks,0);assert.equal(f.acquires,0);
  f.setStatus('starting');t.mock.timers.tick(500);await flush();await task;
  assert.equal(failure,undefined);assert.equal(completed,true);
  assert.equal(f.acquires,1);assert.equal(f.gateway.config.gamePlayer,0);
  assert.equal(f.gateway.waitingForGame,false);
});

test('pause immediately cancels gathering and a later host start cannot acquire control',async t=>{
  const f=fixture(t),task=f.gateway.acquire(),rejected=assert.rejects(task,{name:'AbortError'});
  await flush();assert.equal(f.gateway.waitingForGame,true);
  f.gateway.cancelAcquire();await rejected;
  f.setStatus('starting');t.mock.timers.tick(300000);await flush();
  assert.equal(f.acquires,0);assert.equal(f.identityChecks,0);assert.equal(f.gateway.waitingForGame,false);
});

function stalledFetch(body=false):typeof fetch{return async(_input,init)=>{
  const stalled=new Promise<never>((_resolve,reject)=>{
    const signal=init!.signal!;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
  if(!body)return stalled;
  const response=new Response();response.json=()=>stalled;return response;
};}
for(const body of [false,true])test(`a stalled lobby ${body?'body':'request'} times out as a retryable read without obtaining a lease`,async t=>{
  const f=fixture(t,stalledFetch(body));
  const rejected=assert.rejects(f.gateway.acquire(),error=>error instanceof GameTransportError&&error.diagnostic?.failure==='timeout'&&error.diagnostic.path==='/lobby/v2'&&error.diagnostic.outcome==='read-only');
  await flush();t.mock.timers.tick(15000);await rejected;
  assert.equal(f.acquires,0);assert.equal(f.gateway.waitingForGame,false);
});

test('pause cancels a stalled lobby request without turning cancellation into an automatic retry',async t=>{
  const f=fixture(t,stalledFetch()),rejected=assert.rejects(f.gateway.acquire(),{name:'AbortError'});
  await flush();f.gateway.cancelAcquire();await rejected;assert.equal(f.acquires,0);
});

for(const status of ['cancelled','unauthorized','wrong-seat'])test(`lobby ${status} fails membership validation without acquiring control`,async t=>{
  const f=fixture(t,async()=>Response.json({roomId:'test-lobby',player:status==='wrong-seat'?0:1,occupied:[true,true],status:status==='cancelled'?'cancelled':'waiting'}, {status:status==='unauthorized'?401:200}));
  await assert.rejects(f.gateway.acquire(),error=>error instanceof GameRequestError&&error.code==='lobby-membership-invalid');
  assert.equal(f.acquires,0);assert.equal(f.gateway.waitingForGame,false);
});

test('malformed lobby data is a fatal response error rather than a retryable network failure',async t=>{
  const f=fixture(t,async()=>new Response('not-json'));
  await assert.rejects(f.gateway.acquire(),error=>error instanceof GameTransportError&&error.diagnostic?.failure==='invalid-response');
  assert.equal(f.acquires,0);
});

test('a failed lobby connection uses the existing automatic reconnect classification',async t=>{
  const f=fixture(t,async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('refused'),{code:'ECONNREFUSED'})});});
  await assert.rejects(f.gateway.acquire(),error=>error instanceof GameTransportError&&error.diagnostic?.failure==='connection-refused'&&error.diagnostic.outcome==='read-only');
  assert.equal(f.acquires,0);
});

test('waiting for a foreign lease still has a separate 35 second deadline after gathering',async t=>{
  const f=fixture(t);let reads=0;
  const lease={mode:'agent',generation:1,sessionId:'foreign',expiresAt:1000000,remainingTtlMs:30000};
  t.mock.method(f.gateway.client,'control',async()=>{reads++;return lease as never;});
  const rejected=assert.rejects(f.gateway.acquire(),error=>error instanceof GameTransportError&&error.diagnostic?.failure==='timeout'&&error.diagnostic.path==='/player/v2/control');
  await flush();t.mock.timers.tick(40000);await flush();
  assert.equal(f.gateway.waitingForGame,true);assert.equal(reads,0);
  f.setStatus('starting');t.mock.timers.tick(500);await flush();
  assert.equal(f.gateway.waitingForGame,false);assert.ok(reads>0);
  t.mock.timers.tick(35000);await rejected;assert.equal(f.acquires,0);
});
