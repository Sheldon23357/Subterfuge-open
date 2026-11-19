import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createServer,request as httpRequest} from 'node:http';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {errorDiagnostic,diagnosticText} from '../packages/contracts/src/index.js';
import {PlayerGateway,GameTransportError,GameRequestError} from '../packages/ai/src/controller/transport/gateway.js';import {AiStore,initialState,type AiSnapshot,type GameGateway} from '../packages/ai/src/index.js';
import {CodexProvider} from '../packages/ai/src/application/providers/codex.js';
import {ProviderError,classifyProviderFailure} from '../packages/ai/src/controller/contracts/provider-error.js';
import {recoveryDelay} from '../packages/ai/src/controller/runtime/recovery.js';

test('recovery distinguishes read-only HTTP failures from rejected writes and permanent errors',()=>{
  const d={requestId:'policy',method:'GET',path:'/tool/observation',origin:'http://localhost',timeoutMs:15000,elapsedMs:1,stage:'http-response' as const,failure:'http-error',outcome:'rejected' as const};
  for(const status of [408,429,500,502,503,504]){
    assert.equal(recoveryDelay(new GameRequestError(status,undefined,undefined,undefined,d),1),15000);
    assert.equal(recoveryDelay(new GameRequestError(status,undefined,undefined,undefined,{...d,method:'POST',path:'/tool/attack-routes'}),1),null);
    assert.equal(recoveryDelay(new GameRequestError(status,undefined,undefined,undefined,{...d,method:'POST',path:'/tool/order'}),1),null);
  }
  for(const status of [400,401,403,409])assert.equal(recoveryDelay(new GameRequestError(status,undefined,undefined,undefined,d),1),null);
  for(const failure of ['room-mismatch','invalid-json','invalid-response','tls'])assert.equal(recoveryDelay(new GameTransportError({...d,outcome:'read-only',failure}),1),null);
  for(const reason of ['model-not-supported','context-limit','unsupported-cli-option'])assert.equal(recoveryDelay(new ProviderError('unknown',undefined,{stage:'process-exit',reason}),1),null);
  for(const message of ['read ECONNRESET','fetch failed','stream ended before completion'])assert.equal(classifyProviderFailure(message).code,'transient');
});
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {requestDiagnostics,createRequestDiagnosticLog,type RequestDiagnostic} from '../packages/server/src/request-diagnostics.js';

const privateToken='diagnostic-canary-token';
const gateway=()=>new PlayerGateway('http://127.0.0.1:4310',privateToken,'room',0,2);
const withOwnedControl=(fetcher:typeof fetch):typeof fetch=>async(input,init)=>{if(new URL(String(input)).pathname==='/player/v2/owner/control')return Response.json({roomId:'room',mode:'agent',sessionId:new Headers(init?.headers).get('x-subterfuge-control-session'),expiresAt:Date.now()+60000});return fetcher(input,init);};
function fixture(){
  const room={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]};
  const snapshot:AiSnapshot={observation:observation(room,0,'room'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
  const store=new AiStore(':memory:'),state=initialState('room',0,{model:'',personality:'schemer'});
  return {room,snapshot,store,state};
}

test('diagnostics keep bounded low-level causes while dropping credentials, bodies, paths and cyclic fields',()=>{
  const error=Object.assign(new TypeError(`fetch failed Bearer ${privateToken}`),{cause:Object.assign(new Error(`connect password=${privateToken} https://user:${privateToken}@example.test/private?token=${privateToken}`),{code:'ECONNREFUSED',syscall:'connect',errno:-4078}),headers:{authorization:privateToken},body:privateToken});
  error.cause.cause=error;
  const result=errorDiagnostic(error,true),json=JSON.stringify(result);
  assert.ok(json.includes('ECONNREFUSED'));assert.ok(json.includes('connect'));assert.ok(json.includes('CircularCause'));
  assert.ok(!json.includes(privateToken));assert.ok(!json.includes('example.test'));
  assert.ok(!diagnosticText('C:\\Users\\PrivateName\\secret.txt').includes('PrivateName'));
  assert.ok(!JSON.stringify(errorDiagnostic(new SyntaxError(privateToken),true)).includes(privateToken));
  const source=new Error('failure');source.stack='Error: failure\n at submit (file:///D:/PrivateName/game.js:12:4)\n at request (C:\\PrivateName\\gateway.ts:23:5)';
  const stack=errorDiagnostic(source,true).stack!;
  assert.ok(stack.includes('game.js:12:4'));assert.ok(stack.includes('gateway.ts:23:5'));assert.ok(!stack.includes('PrivateName'));
  assert.equal(diagnosticText('x'.repeat(1000)).length,600);
});

test('network failures distinguish timeout, refused connections, resets and DNS without recording request credentials',async t=>{
  for(const [code,failure] of [['ECONNREFUSED','connection-refused'],['ECONNRESET','connection-reset'],['EAI_AGAIN','dns'],['UND_ERR_CONNECT_TIMEOUT','timeout']]){
    const mock=t.mock.method(globalThis,'fetch',async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('socket failed'),{code,syscall:'connect'})});});
    await assert.rejects(gateway().request(`/tool/notifications?after=${privateToken}`),(error:unknown)=>{
      assert.ok(error instanceof GameTransportError);const d=error.diagnostic!;
      assert.equal(d.failure,failure);assert.equal(d.stage,'connect-or-send');assert.equal(d.path,'/player/v2/owner/notifications');assert.equal(d.timeoutMs,15000);
      assert.equal(d.outcome,'read-only');assert.ok(d.elapsedMs>=0);assert.match(d.requestId,/^[0-9a-f-]{36}$/);
      assert.equal(new Headers((mock.mock.calls[0]!.arguments[1] as RequestInit).headers).get('x-request-id'),d.requestId);
      assert.ok(!JSON.stringify(d).includes(privateToken));return true;
    });
    mock.mock.restore();
  }
});

test('body failures, malformed responses, HTTP rejection and mismatched rooms keep distinct causes and uncertain writes',async t=>{
  const cases:[()=>Promise<Response>,string,string][]=[
    [async()=>new Response(`<html>${privateToken}</html>`,{headers:{'Content-Type':'text/html'}}),'invalid-json','read-response'],
    [async()=>Response.json(null),'invalid-response','validate-response'],
    [async()=>Response.json({roomId:'different-room',secret:privateToken}),'room-mismatch','validate-response'],
    [async()=>({ok:true,status:200,headers:new Headers(),json:async()=>{throw new DOMException('read timed out','TimeoutError');}} as unknown as Response),'timeout','read-response'],
  ];
  for(const [fetch,failure,stage] of cases){
    const mock=t.mock.method(globalThis,'fetch',withOwnedControl(fetch));
    await assert.rejects(gateway().request('/tool/order',{order:{id:'once-only'}}),(error:unknown)=>{
      assert.ok(error instanceof GameTransportError);assert.equal(error.diagnostic!.failure,failure);assert.equal(error.diagnostic!.stage,stage);assert.equal(error.diagnostic!.outcome,'unknown');assert.equal(error.diagnostic!.status,200);
      assert.ok(!JSON.stringify(error.diagnostic).includes(privateToken));return true;
    });mock.mock.restore();
  }
  t.mock.method(globalThis,'fetch',async()=>new Response(privateToken,{status:503}));
  await assert.rejects(gateway().request('/tool/observation'),(error:unknown)=>{
    assert.ok(error instanceof GameRequestError);assert.equal(error.status,503);assert.equal(error.diagnostic!.failure,'http-error');assert.equal(error.diagnostic!.outcome,'rejected');assert.ok(!JSON.stringify(error.diagnostic).includes(privateToken));return true;
  });
});

test('observation failure records its endpoint even before any model round starts',async()=>{
  const f=fixture(),error=new GameTransportError({requestId:'request-1',method:'GET',path:'/tool/notifications',origin:'http://127.0.0.1:1',timeoutMs:15000,elapsedMs:15003,stage:'read-response',failure:'timeout',outcome:'read-only'});
  try{
    const runner=new SeatRunner(f.state,f.store,{snapshot:async()=>{throw error;},request:async()=>{throw Error('No writes');}},{step:async()=>{throw Error('No model');}});
    await runner.poll(0,true);
    const event=f.store.latest<any>('room',0,'error');
    assert.equal(event.phase,'observation');assert.equal(event.diagnostic.request.path,'/tool/notifications');assert.equal(event.diagnostic.request.elapsedMs,15003);
    assert.ok(f.state.error!.includes('请求超时'));assert.ok(f.state.error!.includes('只读'));assert.equal(f.state.calls,0);
  }finally{f.store.close();}
});

test('unconfirmed writes remain stopped and correlate the exact tool with the transport diagnostic',async()=>{
  const f=fixture();let writes=0;
  const error=new GameTransportError({requestId:'request-2',method:'POST',path:'/tool/order',origin:'http://127.0.0.1:1',timeoutMs:15000,elapsedMs:12,stage:'connect-or-send',failure:'connection-reset',outcome:'unknown'});
  try{
    const runner=new SeatRunner(f.state,f.store,{snapshot:async()=>f.snapshot,request:async()=>{writes++;throw error;}},{step:async()=>({tokens:0,reply:{tool:'order',arguments:JSON.stringify({action:{kind:'check-in'}}),summary:'签到'}})});
    await runner.poll(0,true);await runner.poll(10000,true);
    assert.equal(writes,1);assert.equal(f.state.status,'error');assert.ok(f.state.error!.includes('结果未确认'));
    const event=f.store.latest<any>('room',0,'error');assert.equal(event.diagnostic.tool.tool,'order');assert.equal(event.diagnostic.request.requestId,'request-2');
    const decision=f.store.decisionPage('room',0).entries[0]!.payload as any;
    assert.equal(decision.steps[0].status,'unconfirmed');assert.equal(decision.diagnostics[0].diagnostic.tool.id,decision.steps[0].id);
  }finally{f.store.close();}
});

test('an observation error during model work is logged as observation and preserves the active round',async()=>{
  const f=fixture();let release!:()=>void,entered!:()=>void,observations=0;
  const busy=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  try{
    const mockGateway:GameGateway={snapshot:async()=>{if(++observations>1)throw new GameTransportError();return f.snapshot;},request:async()=>{throw Error('No write');}};
    const runner=new SeatRunner(f.state,f.store,mockGateway,{step:async()=>{entered();await busy;return {tokens:0,reply:{tool:'finish',arguments:'{}',summary:'结束'}};}});
    const pending=runner.poll(0,true);await started;await runner.poll(6000,true);
    const event=f.store.latest<any>('room',0,'observation-error');assert.equal(event.diagnostic.phase,'observation');assert.equal(event.diagnostic.tool,undefined);assert.equal(f.state.status,'thinking');
    release();await pending;assert.equal(f.state.status,'waiting');
  }finally{release?.();f.store.close();}
});

test('server failures correlate by request ID, retain internal cause privately and keep public errors filtered',async t=>{
  const f=fixture(),h=protocolHarness(t,{room:f.room}),credentials=h.ownerCredentials,entries:RequestDiagnostic[]=[];
  const server=await createOwnerPlayerApi(h,{sync:async()=>{throw Object.assign(new Error(`disk full password=${privateToken}`),{code:'ENOSPC'});},onDiagnostic:entry=>entries.push(entry)});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`,client=new PlayerGateway(url,credentials.credentials[0]!.token,h.roomId,0,2);
    let requestId='';
    await assert.rejects(client.request('/tool/observation'),(error:unknown)=>{assert.ok(error instanceof GameRequestError);requestId=error.diagnostic!.requestId;assert.ok(!error.message.includes('disk full'));return true;});
    assert.equal(entries[0]!.requestId,requestId);assert.equal(entries[0]!.stage,'handler');assert.equal(entries[0]!.cause!.code,'ENOSPC');assert.equal(entries[0]!.path,'/player/v2/owner/observation');assert.ok(entries[0]!.queueMs!==undefined);
    assert.ok(!JSON.stringify(entries).includes(privateToken));assert.ok(!JSON.stringify(entries).includes(credentials.credentials[0]!.token));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));f.store.close();}
});

test('slow requests and client disconnects are recorded with their stage, while fast successes stay quiet',async t=>{
  let wall=1000;t.mock.method(Date,'now',()=>wall);
  let onAbort:(()=>void)|undefined;
  const entries:RequestDiagnostic[]=[],server=createServer((req,res)=>{
    const diagnostic=requestDiagnostics(req,res,entry=>{entries.push(entry);if(entry.kind==='request-aborted')onAbort?.();});
    if(req.url==='/diagnostic/slow'){diagnostic.stage('queue');wall+=6000;diagnostic.stage('handler');res.end('{}');}
    else if(req.url==='/diagnostic/wait')diagnostic.stage('queue');else res.end('{}');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    await (await fetch(url+'/tool/observation')).text();assert.equal(entries.length,0);
    await (await fetch(url+'/diagnostic/slow')).text();assert.equal(entries[0]!.kind,'request-slow');assert.equal(entries[0]!.elapsedMs,6000);assert.equal(entries[0]!.queueMs,6000);
    const received=once(server,'request'),client=httpRequest(url+'/diagnostic/wait');client.on('error',()=>{});client.end();await received;
    const closed=once(server,'close');
    const logged=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Missing disconnect diagnostic')),2000);onAbort=()=>{clearTimeout(timer);resolve();};});
    client.destroy();await logged;assert.equal(entries.at(-1)!.stage,'queue');assert.equal(entries.at(-1)!.kind,'request-aborted');
    server.close();await closed;
  }finally{server.closeAllConnections();server.close();}
});

test('provider spawn failure records its OS error without the executable path or raw provider output',async()=>{
  const provider=new CodexProvider('D:/missing-diagnostic-canary-directory/codex.exe');
  await assert.rejects(provider.step({model:'',prompt:'private prompt',effort:'low',signal:new AbortController().signal}),(error:unknown)=>{
    assert.ok(error instanceof ProviderError);assert.equal(error.code,'unavailable');assert.equal(error.diagnostic!.stage,'spawn');assert.equal(error.diagnostic!.cause!.code,'ENOENT');
    assert.ok(!JSON.stringify(error.diagnostic).includes('missing-diagnostic-canary-directory'));assert.ok(!JSON.stringify(error.diagnostic).includes('private prompt'));return true;
  });
});

test('provider reason classification preserves actionable causes without keeping raw account or model output',()=>{
  for(const [text,reason] of [['429 rate limit','rate-limit'],['503 overload','provider-unavailable'],['stream disconnected','stream-interrupted'],['model is not supported','model-not-supported'],['context window exceeded','context-limit'],['unexpected argument --future-flag','unsupported-cli-option'],['permission denied','executor-permission-denied']]){
    const failure=classifyProviderFailure(`${text} password=${privateToken}`);
    assert.equal(failure.diagnostic!.reason,reason);assert.ok(!JSON.stringify(failure).includes(privateToken));
  }
});

test('persistent server diagnostics rotate bounded files and tolerate disk failures without rejecting API work',async t=>{
  t.mock.method(console,'error',()=>{});
  const directory=await mkdtemp(join(tmpdir(),'subterfuge-diagnostics-'));
  const entry:RequestDiagnostic={kind:'request-error',at:'2026-10-17T00:00:00Z',requestId:'request-log-test',method:'GET',path:'/tool/notifications',stage:'handler',elapsedMs:10,status:400};
  try{
    const path=join(directory,'request.jsonl'),log=createRequestDiagnosticLog(path,300);
    for(let i=0;i<4;i++)log.write({...entry,requestId:`request-${i}`});
    await log.flush();
    assert.equal(JSON.parse((await readFile(path,'utf8')).trim()).requestId,'request-3');
    assert.equal(JSON.parse((await readFile(path+'.1','utf8')).trim()).requestId,'request-2');
    const broken=createRequestDiagnosticLog(join(directory,'missing','request.jsonl'));
    assert.doesNotThrow(()=>broken.write(entry));await assert.doesNotReject(broken.flush());
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('AI requests use fresh connections when a closing reused socket would reset reads or commands',async()=>{
  const counts=new WeakMap<object,number>();let connections=0,resets=0,requests=0;
  const server=createServer((req,res)=>{
    requests++;const count=(counts.get(req.socket)??0)+1;counts.set(req.socket,count);
    if(count>1){resets++;req.socket.resetAndDestroy();return;}
    assert.equal(req.headers.connection,'close');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/player/v2/owner/control'?{roomId:'fresh-connection',mode:'agent',sessionId:req.headers['x-subterfuge-control-session'],expiresAt:Date.now()+60000}:{roomId:'fresh-connection'}));
  });
  server.on('connection',()=>connections++);server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const client=new PlayerGateway(`http://127.0.0.1:${(server.address() as {port:number}).port}`,'unused','fresh-connection',0,2);
    for(let i=0;i<6;i++){await nextTurn();await client.request(i%2?'/tool/order':'/tool/observation',i%2?{order:{id:`command-${i}`}}:undefined);}
    assert.equal(requests,9);assert.equal(connections,9);assert.equal(resets,0);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('a server resetting after receiving a real write leaves it unconfirmed and is never automatically retried',async()=>{
  let received=0;
  const server=createServer(async(req,res)=>{if(req.url==='/player/v2/owner/control'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({roomId:'one-write',mode:'agent',sessionId:req.headers['x-subterfuge-control-session'],expiresAt:Date.now()+60000}));return;}for await(const _part of req){}received++;req.socket.resetAndDestroy();});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const client=new PlayerGateway(`http://127.0.0.1:${(server.address() as {port:number}).port}`,'unused','one-write',0,2);
    await assert.rejects(client.request('/tool/order',{order:{id:'do-not-repeat'}}),(error:unknown)=>{assert.ok(error instanceof GameTransportError);assert.equal(error.diagnostic!.failure,'connection-reset');assert.equal(error.diagnostic!.outcome,'unknown');return true;});
    await nextTurn();assert.equal(received,1);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
