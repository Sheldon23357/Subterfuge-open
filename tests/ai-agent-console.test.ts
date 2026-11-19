import {AgentRuntime} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {startAgentConsole,type AgentConsoleOptions} from '../packages/ai/src/application/agent-console.js';
import {localAgentConnections} from '../packages/ai/src/application/local-agent-connections.js';
import {parseAgentConfig} from '../packages/ai/src/controller/contracts/agent-config.js';
async function fixture(options:Pick<AgentConsoleOptions,'localConnections'>&{tickTimes?:AgentRuntime['tickTimes']}={}){
  const dir=mkdtempSync(join(tmpdir(),'console-test-'));
  for(const name of ['index.html','agent-console.js','agent-console.css'])writeFileSync(join(dir,name),'synthetic');
  const runtime=new AgentRuntime(parseAgentConfig({storeDirectory:join(dir,'private'),seats:[{id:'seat',serverUrl:'http://localhost:1',roomId:'synthetic',lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:1,tokenEnv:'SYNTHETIC_TOKEN',settings:{model:'test',personality:'schemer'},extraSecret:'must-not-leak'}]}),{step:async()=>{throw Error('No provider calls allowed');}},{SYNTHETIC_TOKEN:'synthetic-secret'});
  runtime.tickTimes=options.tickTimes??(async()=>null);
  const server=await startAgentConsole(runtime,{webRoot:dir,provider:'offline',...options});
  const page=await fetch(server.url),cookie=page.headers.get('set-cookie')!.split(';')[0]!;
  const bootstrap=await fetch(server.url+'api/agent/bootstrap',{headers:{cookie,'X-Agent-Console':'1'}});const {csrf}=await bootstrap.json() as {csrf:string};
  const headers={cookie,'X-Agent-CSRF':csrf,'Content-Type':'application/json',Origin:server.url.slice(0,-1)};
  return {dir,runtime,originalConfig:structuredClone(runtime.config),server,page,cookie,headers,get:(path:string)=>fetch(server.url+path,{headers}),post:(path:string,body:unknown)=>fetch(server.url+path,{method:'POST',headers,body:JSON.stringify(body)}),close:async()=>{await Promise.all([runtime.shutdown(),server.close()]);rmSync(dir,{recursive:true,force:true});}};
}
test('console recovers oversized legacy cookies without touching other cookies and retains a header bound',async()=>{
 const f=await fixture();
 const read=(cookie:string)=>new Promise<{status:number;cookies:string[]}>((resolve,reject)=>{
  const req=request(f.server.url,{headers:{Cookie:cookie},maxHeaderSize:64*1024},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode!,cookies:res.headers['set-cookie']??[]}));});req.on('error',reject);req.end();
 });
 try{
  const legacy=Array.from({length:240},(_,i)=>`agent_console_${i.toString(16).padStart(16,'0')}=${'a'.repeat(64)}`);
  const result=await read([...legacy,'other_app=keep','agent_console_4499=keep'].join('; '));
  assert.equal(result.status,200);assert.equal(result.cookies.length,241);
  assert.equal(result.cookies[0]!.split('=')[0],`agent_console_${new URL(f.server.url).port}`);
  assert.ok(result.cookies.slice(1).every(c=>/Max-Age=0/.test(c)));
  assert.ok(result.cookies.every(c=>!c.startsWith('other_app=')&&!c.startsWith('agent_console_4499=')));
  assert.equal((await read('too_large='+ 'x'.repeat(70*1024))).status,431);
 }finally{await f.close();}
});

test('console restarts overwrite a stable per-port cookie while rejecting old session and CSRF values',async()=>{
 const f=await fixture();let restarted:Awaited<ReturnType<typeof startAgentConsole>>|undefined;
 try{
  await f.server.close();
  restarted=await startAgentConsole(f.runtime,{webRoot:f.dir,provider:'offline',port:Number(new URL(f.server.url).port)});
  const get=(suffix:string,headers:Record<string,string>={})=>new Promise<{status:number;cookies:string[]}>((resolve,reject)=>{
   const req=request(restarted!.url+suffix,{headers,agent:false},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode!,cookies:res.headers['set-cookie']??[]}));});req.on('error',reject);req.end();
  });
  const page=await get(''),cookie=page.cookies[0]!.split(';')[0]!;
  assert.equal(cookie.split('=')[0],f.cookie.split('=')[0]);assert.notEqual(cookie,f.cookie);
  assert.equal((await get('api/agent/bootstrap',{Cookie:f.cookie,'X-Agent-Console':'1'})).status,401);
  assert.equal((await get('api/agent/status',{...f.headers,Cookie:cookie})).status,403);
  assert.equal((await get('api/agent/bootstrap',{Cookie:cookie,'X-Agent-Console':'1'})).status,200);
 }finally{await restarted?.close();await f.close();}
});

test('tick timings use the selected room, validate cursors and require the console session',async()=>{
 const reads:{roomId:string;after:number}[]=[];
 const f=await fixture({tickTimes:async(id,after)=>{reads.push({roomId:id,after});return {roomId:'synthetic',headTick:0,ended:false,serverTimeMs:1000,headElapsedMs:null,records:[],nextCursor:after,hasMore:false};}});
 try{
  assert.equal((await fetch(f.server.url+'api/agent/tick-times?seat=seat')).status,401);
  const response=await f.get('api/agent/tick-times?seat=seat&after=4');assert.equal(response.status,200);
  assert.equal((await response.json()).available,true);assert.deepEqual(reads,[{roomId:'seat',after:4}]);
  for(const query of ['seat=other','seat=seat&after=-1','seat=seat&after=1.5','seat=seat&after=9007199254740992','seat=seat&seat=other','seat=seat&path=other'])assert.equal((await f.get('api/agent/tick-times?'+query)).status,400);
 }finally{await f.close();}
 const remote=await fixture();try{assert.equal((await(await remote.get('api/agent/tick-times?seat=seat')).json()).available,false);}finally{await remote.close();}
 const unsupported=await fixture({tickTimes:async(id)=>{assert.equal(id,'seat');return null;}});
 try{const response=await unsupported.get('api/agent/tick-times?seat=seat&after=7');assert.equal(response.status,200);assert.deepEqual(await response.json(),{available:false,records:[],hasMore:false,nextCursor:7});}finally{await unsupported.close();}
});

test('executor-only connections cannot export an owner browser identity',async()=>{
 const f=await fixture();try{assert.throws(()=>f.runtime.browserIdentity('seat'),/owner connection/);assert.equal((await f.post('api/agent/browser-entry',{id:'seat'})).status,409);}finally{await f.close();}
});

test('console session cookie, custom bootstrap and CSRF protect every API',async()=>{
  const f=await fixture();try{
    assert.match(f.page.headers.get('set-cookie')!,/HttpOnly; SameSite=Strict/);assert.ok(!f.server.url.includes(f.cookie));
    for(const path of ['status','config','provider-presets','logs?seat=seat']){
      assert.equal((await fetch(f.server.url+'api/agent/'+path)).status,401);
      assert.equal((await fetch(f.server.url+'api/agent/'+path,{headers:{cookie:f.cookie}})).status,403);
      assert.equal((await f.get('api/agent/'+path)).status,200);
    }
    assert.equal((await fetch(f.server.url+'api/agent/bootstrap',{headers:{cookie:f.cookie}})).status,403);
    for(const origin of ['null','https://evil.example','http://localhost:1234'])assert.equal((await fetch(f.server.url+'api/agent/status',{headers:{...f.headers,Origin:origin}})).status,403);
    assert.equal((await fetch(f.server.url+'api/agent/bootstrap',{headers:{cookie:f.cookie,'X-Agent-Console':'1','Sec-Fetch-Site':'cross-site'}})).status,403);
    for(const host of ['evil.example','localhost:'+new URL(f.server.url).port]){
      const status=await new Promise<number>(resolve=>{const req=request(f.server.url+'api/agent/status',{headers:{...f.headers,Host:host}},res=>{res.resume();resolve(res.statusCode!);});req.end();});assert.equal(status,403);
    }
    assert.equal((await fetch(f.server.url+'api/agent/action',{method:'POST',headers:{cookie:f.cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
  }finally{await f.close();}
});
test('console paths, methods, request schemas and redacted projections',async()=>{
  const f=await fixture();try{
    const config=JSON.stringify(await (await f.get('api/agent/config')).json());assert.ok(!/SYNTHETIC_TOKEN|synthetic-secret|must-not-leak|storeDirectory|tokenEnv/.test(config));
    const status=JSON.stringify(await (await f.get('api/agent/status')).json());assert.ok(!status.includes('localhost'));
    assert.equal((await fetch(f.server.url+'api/agent/status',{method:'DELETE',headers:f.headers})).status,405);
    assert.equal((await f.get('api/agent/action')).status,404);
    for(const path of ['api/agent/logs?seat=seat&before=0','api/agent/logs?seat=seat&before=no','api/agent/logs?seat=seat&before=9007199254740992','api/agent/logs?seat=seat&seat=other','api/agent/logs?seat=unknown','api/agent/logs?seat=seat&file=x'])assert.equal((await f.get(path)).status,400);
    for(const path of ['/../agent-runtime.ts','/%2e%2e/agent-runtime.ts','//evil.example/x','/agent-console.js%00']){
      const code=await new Promise<number>(resolve=>{const req=request(f.server.url,{path,headers:f.headers},res=>{res.resume();resolve(res.statusCode!);});req.end();});assert.equal(code,400);
    }
    assert.equal((await f.get('unknown')).status,404);
    for(const settings of [{model:'x',personality:'invalid'},{model:'x'.repeat(101),personality:'schemer'},{model:'x',personality:'schemer',token:'secret'},{model:'x',personality:'schemer',provider:'x'.repeat(61)}])assert.equal((await f.post('api/agent/settings',{id:'seat',settings})).status,400);
    assert.equal((await f.post('api/agent/settings',{id:'seat',settings:{model:'changed',personality:'schemer'},live:true})).status,400);
    assert.equal((await f.post('api/agent/settings',{id:'seat',settings:{model:'changed',personality:'schemer'}})).status,200);
    assert.equal(f.runtime.consoleConfig().seats[0]!.settings.model,'changed');
    for(const action of ['run-one','shell',['start'],['pause'],{toString:'start'},null,1])assert.equal((await f.post('api/agent/action',{id:'seat',action})).status,400);
    assert.equal((await f.post('api/agent/action',{id:'other',action:'pause'})).status,400);
    assert.equal((await fetch(f.server.url+'api/agent/settings',{method:'POST',headers:f.headers,body:'x'.repeat(16385)})).status,413);
  }finally{await f.close();}
});
test('disconnect rejects unauthenticated and invalid requests then pauses and removes only the selected connection',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.server.url+'api/agent/disconnect',{method:'POST',headers:{cookie:f.cookie,'Content-Type':'application/json'},body:JSON.stringify({id:'seat'})})).status,403);
    assert.equal((await f.post('api/agent/disconnect',{id:'seat',other:true})).status,400);
    assert.equal((await f.post('api/agent/disconnect',{id:'unknown'})).status,400);
    const response=await f.post('api/agent/disconnect',{id:'seat'});assert.equal(response.status,200);assert.equal(f.runtime.status().length,0);
  }finally{await f.close();}
});
test('actions return jobs immediately and pause remains available during startup',async()=>{
  const f=await fixture();let release:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  f.runtime.start=async()=>{await gate;};f.runtime.pause=async()=>{release();};
  try{
    const result=await f.post('api/agent/action',{id:'seat',action:'start'});assert.equal(result.status,202);
    let status=await (await f.get('api/agent/status')).json() as {jobs:{status:string}[]};assert.equal(status.jobs[0]!.status,'running');
    assert.equal((await f.post('api/agent/action',{id:'seat',action:'start'})).status,409);
    assert.equal((await f.post('api/agent/action',{id:'seat',action:'pause'})).status,202);
    status=await (await f.get('api/agent/status')).json() as {jobs:{status:string}[]};assert.ok(status.jobs.every(j=>j.status==='completed'));
  }finally{release();await f.close();}
});
test('journal export is bounded metadata only and settings reject live lifecycle state',async()=>{
  const f=await fixture();try{
    // Synthetic private journal injection verifies unknown nested payloads never escape.
    const entry=(f.runtime as unknown as {entries:Map<string,{store:{append:(r:string,s:number,k:string,p:unknown)=>void};desired:boolean}>}).entries.get('seat')!;
    // Use the store public save API without changing runner/store implementation.
    const e=entry as unknown as {store:{save:(state:unknown,kind:string,payload?:unknown)=>void};runner:{state:unknown};desired:boolean};
    for(let i=0;i<35;i++)e.store.save(e.runner.state,'usage',{tokens:5,secret:'synthetic-secret',arguments:{token:'must-not-leak'}});
    const logs=f.runtime.consoleLogs('seat');assert.equal(logs.entries.length,30);assert.ok(logs.nextCursor);assert.ok(!JSON.stringify(logs).includes('secret'));assert.deepEqual(logs.entries[0]!.payload,{tokens:5});
    e.store.save(e.runner.state,'tool-rejected',{tool:'order',summary:'synthetic-secret',arguments:{action:{kind:'launch',token:'synthetic-secret'}},diagnostic:{request:{status:409,path:'/secret',token:'synthetic-secret'}}});
    assert.deepEqual(f.runtime.consoleLogs('seat').entries[0]!.payload,{tool:'order',outcome:'rejected',action:'launch',httpStatus:409});
    e.store.save(e.runner.state,'tool-result',{tool:'synthetic-secret',arguments:{action:{kind:'synthetic-secret'}},diagnostic:{request:{status:600}}});
    assert.deepEqual(f.runtime.consoleLogs('seat').entries[0]!.payload,{outcome:'result'});
    e.store.save(e.runner.state,'mode-test-execution-model-call',{callId:'test-call',sequence:1,prompt:'authorized context synthetic-secret',output:{summary:'<script>synthetic-secret</script>',token:'must-not-leak'},usage:{inputTokens:0,outputTokens:2},usageKnown:{input:true,output:true,cached:false},headers:{authorization:'synthetic-secret'},privateExtra:'do-not-export'});
    const detail=JSON.stringify(f.runtime.consoleLogs('seat').entries[0]!.payload);
    assert.doesNotMatch(detail,/authorized context/);assert.match(detail,/summary-only/);assert.match(detail,/promptCharacters/);assert.match(detail,/inputTokens/);
    for(const secret of ['synthetic-secret','must-not-leak','do-not-export','authorization'])assert.ok(!detail.includes(secret),secret);
    entry.desired=true;assert.throws(()=>f.runtime.updateSettings('seat',{model:'x',personality:'schemer'}));entry.desired=false;
  }finally{await f.close();}
});

test('console atomically saves programmatic parameters and rejects invalid updates',async()=>{
  const f=await fixture();try{
    const response=await f.post('api/agent/configuration',{id:'seat',provider:{kind:'offline'},settings:{model:'',personality:'sentinel',bot:{aggression:1.5,maxSimulations:24,reviewIntervalTicks:9}}});
    assert.equal(response.status,200);
    const before=await (await f.get('api/agent/config')).json();
    const settings=(before as {seats:{settings:{bot:{schemaVersion:number;minCaptureGain:number;maxSimulations:number}}}[]}).seats[0]!.settings.bot;
    assert.equal(settings.schemaVersion,2);assert.equal(settings.minCaptureGain,2/1.5);assert.equal(settings.maxSimulations,24);
    for(const bot of [{riskForceFraction:2},{schemaVersion:3},{schemaVersion:2,aggression:1.5},{schemaVersion:2,forceBufferRatio:1.01},{minActionGain:2}]){
      const invalid=await f.post('api/agent/configuration',{id:'seat',provider:{kind:'offline'},settings:{model:'',personality:'sentinel',bot}});
      assert.equal(invalid.status,400);assert.deepEqual(await (await f.get('api/agent/config')).json(),before);
    }
    const current=await f.post('api/agent/configuration',{id:'seat',settings:{model:'',personality:'sentinel',bot:{schemaVersion:2,minActionGain:3,minCaptureGain:1.25,forceBufferRatio:0.255,maxElapsedMs:1001}}});
    assert.equal(current.status,200);
    const canonical=(await current.json()).settings;
    assert.equal(canonical.bot.schemaVersion,2);assert.equal(canonical.bot.minActionGain,3);assert.equal(canonical.bot.minCaptureGain,1.25);
    assert.equal(canonical.bot.forceBufferRatio,0.255);assert.equal(canonical.bot.maxElapsedMs,1001);
    assert.equal('aggression' in canonical.bot,false);assert.equal('attackForceMargin' in canonical.bot,false);
    const getCurrent=async()=>((await (await f.get('api/agent/config')).json()) as {seats:{settings:unknown}[]}).seats[0]!.settings;
    assert.deepEqual(await getCurrent(),canonical);
    assert.equal((await f.post('api/agent/configuration',{id:'seat',settings:canonical})).status,200);
    assert.deepEqual(await getCurrent(),canonical);
    assert.equal(f.runtime.status()[0]!.calls,0);
  }finally{await f.close();}
});

test('console settings are process-only and CLI config remains authoritative on restart',async()=>{
  const f=await fixture();try{
    const response=await f.post('api/agent/settings',{id:'seat',settings:{model:'temporary',personality:'schemer'}});
    assert.equal((await response.json() as {persistence:string}).persistence,'process');
    await f.runtime.shutdown();
    const restarted=new AgentRuntime(f.originalConfig,{step:async()=>{throw Error('No calls');}},{SYNTHETIC_TOKEN:'synthetic-secret'});
    try{assert.equal(restarted.consoleConfig().seats[0]!.settings.model,'test');}finally{await restarted.shutdown();}
  }finally{await f.close();}
});

async function probeServer(){
  const {createServer}=await import('node:http');
  const token='a'.repeat(64),requests:{url:string;authorization:string|undefined}[]=[];
  let override:unknown,redirect:string|null=null;let gate:Promise<void>|null=null;
  const server=createServer(async(req,res)=>{const path=new URL(req.url??'/', 'http://localhost').pathname;requests.push({url:req.url??'',authorization:req.headers.authorization});if(gate)await gate;if(redirect&&path==='/player/v2/protocol'){res.writeHead(302,{Location:redirect});res.end();return;}if(path==='/lobby/v2'||path==='/player/v2/owner/identity'){res.writeHead(404).end();return;}let response=override;if(response===undefined){if(path==='/player/v2/protocol')response={versions:[{major:2,minor:0}],capabilities:['core/2']};else if(path==='/player/v2/sessions/hello')response={scope:{roomId:'discovered-room',roomEpoch:'1',player:1},version:{major:2,minor:0},sessionId:'synthetic-session',identity:{roomId:'discovered-room',lobbySeat:0,gamePlayer:1,chatPlayer:1,chatCount:2,roster:[{chatPlayer:0,gamePlayer:0},{chatPlayer:1,gamePlayer:1}]}};else response={mode:'manual'};}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(response));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error();
  return {url:`http://127.0.0.1:${address.port}`,token,requests,hold:(promise:Promise<void>)=>{gate=promise;},set:(value:unknown)=>{override=value;},redirect:(url:string)=>{redirect=url;},close:async()=>{await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}};
}
test('connection probe binds server identity, never echoes credentials and confirms once',async()=>{
  const f=await fixture(),upstream=await probeServer();try{
    const response=await f.post('api/agent/connections/probe',{serverUrl:upstream.url,playerToken:upstream.token});assert.equal(response.status,200);
    const probe=await response.json() as {probeId:string;identity:{roomId:string;gamePlayer:number}};
    assert.equal(probe.identity.gamePlayer,1);assert.equal(probe.identity.roomId,'discovered-room');assert.ok(!JSON.stringify(probe).includes(upstream.token));
    assert.deepEqual(upstream.requests.map(request=>request.url),['/lobby/v2','/player/v2/protocol','/player/v2/owner/identity','/player/v2/sessions/hello','/player/v2/control?sessionId=synthetic-session']);assert.ok(upstream.requests.every(request=>request.authorization==='Bearer '+upstream.token));
    const input={probeId:probe.probeId,id:'discovered',settings:{model:'',personality:'schemer'}};
    assert.equal((await f.post('api/agent/instances',{...input,roomId:'forged'})).status,400);
    const responses=await Promise.all([f.post('api/agent/instances',input),f.post('api/agent/instances',input)]);assert.deepEqual(responses.map(r=>r.status).sort(),[201,400]);
    const seat=f.runtime.consoleConfig().seats.find(s=>s.id==='discovered')!;assert.equal(seat.gamePlayer,1);assert.equal(seat.roomId,'discovered-room');assert.equal(seat.mode,'live');
    assert.equal(f.runtime.status().find(s=>s.id==='discovered')!.enabled,false);
    assert.equal((await f.post('api/agent/mode',{id:'discovered',live:'true'})).status,404);
    assert.equal((await f.post('api/agent/mode',{id:'discovered',live:false})).status,404);
    assert.equal((await (await f.get('api/agent/status')).json() as {mode:string}).mode,'live');
    assert.equal((await f.post('api/agent/remove',{id:'discovered'})).status,200);assert.equal(f.runtime.status().length,1);
  }finally{await f.close();await upstream.close();}
});
test('probe rejects redirects, arbitrary paths, malicious mapping and oversized responses',async()=>{
  const f=await fixture(),upstream=await probeServer(),target=await probeServer();try{
    for(const serverUrl of [upstream.url+'/other',upstream.url+'?token=x',upstream.url+'#x','http://example.com','file:///tmp/x'])assert.equal((await f.post('api/agent/connections/probe',{serverUrl,playerToken:upstream.token})).status,400);
    assert.equal(upstream.requests.length,0);
    for(const mapping of [null,{protocol:'bad'},{protocol:'player-control/1',roomId:'room',mode:['manual'],player:0,lobbySeat:0,chatPlayer:0,chatCount:1,roster:[{chatPlayer:0,gamePlayer:0}]},{protocol:'player-control/1',roomId:'room',mode:'manual',controller:'external',player:0,lobbySeat:0,chatPlayer:0,chatCount:1,roster:[{chatPlayer:0,gamePlayer:0}]},{protocol:'player-control/1',roomId:'room',mode:'manual',gamePlayer:1,player:0,lobbySeat:0,chatPlayer:0,chatCount:1,roster:[{chatPlayer:0,gamePlayer:0}]}, {protocol:'player-control/1',roomId:upstream.token,mode:'manual'}, {protocol:'player-control/1',roomId:'room',mode:'manual',player:0,lobbySeat:0,chatPlayer:0,chatCount:2,roster:[{chatPlayer:0,gamePlayer:0},{chatPlayer:0,gamePlayer:1}]}, {blob:'x'.repeat(65536)}]){
      upstream.set(mapping);const response=await f.post('api/agent/connections/probe',{serverUrl:upstream.url,playerToken:upstream.token});assert.equal(response.status,400);assert.ok(!(await response.text()).includes(upstream.token));
    }
    upstream.redirect(target.url+'/player/v2/protocol');assert.equal((await f.post('api/agent/connections/probe',{serverUrl:upstream.url,playerToken:upstream.token})).status,400);assert.equal(target.requests.length,0);
  }finally{await f.close();await upstream.close();await target.close();}
});
test('probe drafts expire, failed confirmation is retryable and pending draft count is bounded',async()=>{
  const f=await fixture(),upstream=await probeServer();try{
    const probe=await (await f.post('api/agent/connections/probe',{serverUrl:upstream.url,playerToken:upstream.token})).json() as {probeId:string};
    const settings={model:'',personality:'schemer'};
    assert.equal((await f.post('api/agent/instances',{probeId:probe.probeId,id:'seat',settings})).status,400);
    assert.equal((await f.post('api/agent/instances',{probeId:probe.probeId,id:'retry',settings})).status,201);
    const drafts=await Promise.all(Array.from({length:10},()=>f.post('api/agent/connections/probe',{serverUrl:upstream.url,playerToken:upstream.token})));assert.ok(drafts.every(r=>r.status===200));
    assert.equal((await f.post('api/agent/connections/probe',{serverUrl:upstream.url,playerToken:upstream.token})).status,429);
    const expired=await drafts[0]!.json() as {probeId:string};const now=Date.now;Date.now=()=>now()+301000;
    try{assert.equal((await f.post('api/agent/instances',{probeId:expired.probeId,id:'expired',settings})).status,400);}finally{Date.now=now;}
  }finally{await f.close();await upstream.close();}
});
test('provider configuration routes are paused-only, bounded and never echo API keys',async()=>{
  const f=await fixture();try{
    const key='synthetic-model-secret';
    const result=await f.post('api/agent/provider',{id:'seat',config:{kind:'openai-compatible',model:'synthetic',baseUrl:'https://example.com/v1',apiKey:key,apiStyle:'chat'}});assert.equal(result.status,200);assert.ok(!(await result.text()).includes(key));
    const config=await (await f.get('api/agent/config')).json();assert.ok(!JSON.stringify(config).includes(key));
    assert.equal((await f.post('api/agent/provider',{id:'seat',config:{kind:'codex',model:'test',executable:'/evil'}})).status,400);
    assert.equal((await f.post('api/agent/provider',{id:'seat',config:{kind:'offline',model:''}})).status,200);
    assert.equal((await f.post('api/agent/models',{id:'seat'})).status,200);
    let release:()=>void=()=>{};const gate=new Promise<void>(r=>{release=r;});f.runtime.start=async()=>{await gate;};
    await f.post('api/agent/action',{id:'seat',action:'start'});
    try{for(const path of ['provider','remove','models'])assert.equal((await f.post('api/agent/'+path,{id:'seat',config:{kind:'offline',model:''},live:true})).status,409);}finally{release();}
  }finally{await f.close();}
});

test('in-flight probes reserve draft capacity before contacting another target',async()=>{
  const f=await fixture(),upstream=await probeServer();let release:()=>void=()=>{};upstream.hold(new Promise<void>(resolve=>{release=resolve;}));
  const tasks=Array.from({length:10},()=>f.post('api/agent/connections/probe',{serverUrl:upstream.url,playerToken:upstream.token}));
  try{
    for(let i=0;i<100&&upstream.requests.length<10;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(upstream.requests.length,10);
    assert.equal((await f.post('api/agent/connections/probe',{serverUrl:upstream.url,playerToken:upstream.token})).status,429);
    assert.equal(upstream.requests.length,10);release();assert.ok((await Promise.all(tasks)).every(r=>r.status===200));
  }finally{release();await Promise.all(tasks);await f.close();await upstream.close();}
});

test('diagnostics routes keep session boundaries and debug settings explicitly opt in',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.server.url+'api/agent/debug/state?seat=seat')).status,401);
    assert.equal((await fetch(f.server.url+'api/agent/debug/state?seat=seat',{headers:{cookie:f.cookie}})).status,403);
    assert.equal((await f.get('api/agent/debug/state?seat=seat&seat=other')).status,400);
    assert.equal((await f.get('api/agent/debug/state?seat=unknown')).status,400);
    assert.equal((await f.get('api/agent/debug/calls?seat=seat&limit=500')).status,400);
    assert.equal((await f.get('api/agent/debug/calls?seat=seat&generation=foreign')).status,400);
    assert.equal((await fetch(f.server.url+'api/agent/debug/stats?seat=seat')).status,401);
    assert.equal((await fetch(f.server.url+'api/agent/debug/stats?seat=seat',{headers:{cookie:f.cookie}})).status,403);
    for(const suffix of ['seat=unknown','seat=seat&seat=other','seat=seat&generation=foreign','seat=seat&limit=30','seat=seat&room=other'])assert.equal((await f.get('api/agent/debug/stats?'+suffix)).status,400);
    const stats=await f.get('api/agent/debug/stats?seat=seat');assert.equal(stats.status,200);
    const statsBody=await stats.json() as {calls:number;rounds:unknown[];composition:{all:{calls:number}}};
    assert.equal(statsBody.calls,0);assert.deepEqual(statsBody.rounds,[]);assert.equal(statsBody.composition.all.calls,0);
    let status=await (await f.get('api/agent/debug/status?seat=seat')).json() as {captureCalls:boolean};assert.equal(status.captureCalls,true);
    assert.equal((await f.post('api/agent/debug/settings',{id:'seat',settings:{captureCalls:true}})).status,200);
    status=await (await f.get('api/agent/debug/status?seat=seat')).json() as {captureCalls:boolean};assert.equal(status.captureCalls,true);
    for(const settings of [{captureCalls:false},{captureCalls:['true']},{captureCalls:true,token:'bad'},{}])assert.equal((await f.post('api/agent/debug/settings',{id:'seat',settings})).status,400);
    assert.equal((await f.post('api/agent/debug/resume',{id:'seat',breakpointId:[]})).status,400);
    assert.equal((await f.post('api/agent/debug/compare',{id:'seat',left:'bad',right:[]})).status,404);
    const state=await (await f.get('api/agent/debug/state?seat=seat')).text();assert.ok(!state.includes('synthetic-secret'));assert.ok(state.includes('known-session-secrets-and-patterns'));
  }finally{await f.close();}
});


test('local auto-connect verifies identity, stays paused and deduplicates concurrent requests',async()=>{
  const upstream=await probeServer();
  const candidate={serverUrl:upstream.url,roomId:'discovered-room',player:0,token:upstream.token};
  const f=await fixture({localConnections:async()=>[candidate]});
  try{
    const responses=await Promise.all([f.post('api/agent/connections/local',{}),f.post('api/agent/connections/local',{})]);
    const bodies=await Promise.all(responses.map(async r=>{assert.equal(r.status,200);return await r.json() as {available:number;added:string[]};}));
    assert.equal(bodies.reduce((n,b)=>n+b.added.length,0),1);
    assert.ok(!JSON.stringify(bodies).includes(upstream.token));
    assert.ok(bodies.every(b=>b.available===1));
    const added=f.runtime.consoleConfig().seats.find(s=>s.roomId==='discovered-room')!;
    assert.equal(added.gamePlayer,1);assert.equal(added.mode,'live');
    const state=f.runtime.status().find(s=>s.id===added.id)!;
    assert.equal(state.enabled,false);assert.equal(state.calls,0);assert.equal(state.owned,false);
    assert.ok(upstream.requests.every(r=>['/lobby/v2','/player/v2/protocol','/player/v2/owner/identity','/player/v2/sessions/hello','/player/v2/control?sessionId=synthetic-session'].includes(r.url)));
    assert.equal((await f.post('api/agent/connections/local',{serverUrl:upstream.url})).status,400);
    candidate.roomId='stale-room';
    const stale=await (await f.post('api/agent/connections/local',{})).json();
    assert.deepEqual(stale,{available:0,added:[]});
    candidate.serverUrl='http://example.com';
    const count=upstream.requests.length;
    assert.equal((await f.post('api/agent/connections/local',{})).status,400);
    assert.equal(upstream.requests.length,count);
    assert.equal((await fetch(f.server.url+'api/agent/connections/local',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  }finally{await f.close();await upstream.close();}
});

test('local credential source reads only the configured player file and handles missing files',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'local-agent-'));
  try{
    assert.deepEqual(await localAgentConnections(dir,4311),[]);
    const credentials=[{player:0,token:'a'.repeat(64)},{player:1,token:'b'.repeat(64)}];
    writeFileSync(join(dir,'player-access.json'),JSON.stringify({format:'player-access/1',roomId:'local-room',credentials}));
    const connections=await localAgentConnections(dir,4311);
    assert.equal(connections.length,2);assert.equal(connections[0]!.serverUrl,'http://127.0.0.1:4311');
    await assert.rejects(localAgentConnections(dir,0));
    credentials[1]!.token=credentials[0]!.token;
    writeFileSync(join(dir,'player-access.json'),JSON.stringify({format:'player-access/1',roomId:'local-room',credentials}));
    await assert.rejects(localAgentConnections(dir,4311));
  }finally{rmSync(dir,{recursive:true,force:true});}
});


test('unified configuration validates both sections before saving either one',async()=>{
 const f=await fixture();try{
  const before=f.runtime.consoleConfig();const entries=f.runtime.consoleLogs('seat').entries.length;
  assert.equal((await f.post('api/agent/configuration',{id:'seat',provider:{kind:'codex',model:'chosen-model'},settings:{model:'old-model',personality:'merchant'}})).status,200);
  const saved=f.runtime.consoleConfig();assert.equal(saved.seats[0]!.providerConfig.kind,'codex');assert.equal(saved.seats[0]!.settings.model,'chosen-model');assert.equal(saved.seats[0]!.settings.personality,'merchant');
  assert.equal(f.runtime.consoleLogs('seat').entries.length,entries+1);
  assert.equal((await f.post('api/agent/configuration',{id:'seat',provider:{kind:'openai-compatible'},settings:{model:'other',personality:'schemer'}})).status,400);
  assert.deepEqual(f.runtime.consoleConfig(),saved);
  assert.equal((await f.post('api/agent/configuration',{id:'seat',provider:{kind:'offline'},settings:{model:'other',personality:'invalid'}})).status,400);
  assert.deepEqual(f.runtime.consoleConfig(),saved);assert.equal(f.runtime.consoleLogs('seat').entries.length,entries+1);
  assert.notDeepEqual(saved,before);
 }finally{await f.close();}
});

test('status exposes an opaque diagnostic generation for fixed-identity rebindings without exposing server URLs',async()=>{
 const f=await fixture();try{
  const status=await (await f.get('api/agent/status')).json() as {seats:{id:string;diagnosticGeneration:string;serverUrl?:string}[]};
  const stats=await (await f.get('api/agent/debug/stats?seat=seat')).json() as {generation:string};
  assert.equal(typeof status.seats[0]!.diagnosticGeneration,'string');assert.equal(status.seats[0]!.diagnosticGeneration,stats.generation);
  assert.equal(status.seats[0]!.serverUrl,undefined);
 }finally{await f.close();}
});

test('same-tab hall return is origin-bound, one-use and consumed only by console session',async()=>{
 const f=await fixture();
 const hall='https://game.example',token='a'.repeat(64);
 const begin=async()=>{const response=await f.post('api/agent/hall-link/start',{hallOrigin:hall});assert.equal(response.status,200);return (await response.json()).nonce as string;};
 const submit=(nonce:string,origin=hall)=>fetch(f.server.url+'hall-link/return',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({nonce,code:'ABC123',playerToken:token}),redirect:'manual'});
 try{
  const nonce=await begin();assert.match(nonce,/^[a-f0-9]{48}$/);
  assert.equal((await submit(nonce,'https://other.example')).status,403);
  assert.equal((await submit('0'.repeat(48))).status,403);
  const returned=await submit(nonce);assert.equal(returned.status,303);
  assert.equal(returned.headers.get('location'),f.server.url+'#handoff='+nonce);
  assert.ok(!returned.headers.get('location')!.includes(token));
  assert.equal((await submit(nonce)).status,403);
  assert.equal((await fetch(f.server.url+'api/agent/hall-link/consume',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce})})).status,401);
  const consumed=await f.post('api/agent/hall-link/consume',{nonce});assert.equal(consumed.status,200);
  assert.deepEqual(await consumed.json(),{hallOrigin:hall,code:'ABC123',playerToken:token});
  assert.equal((await f.post('api/agent/hall-link/consume',{nonce})).status,400);
  const expired=await begin(),original=Date.now;try{Date.now=()=>original()+300001;assert.equal((await submit(expired)).status,403);}finally{Date.now=original;}
 }finally{await f.close();}
});

test('binding model settings cannot modify a slot already claimed by another binding',async()=>{
 const f=await fixture();
 try{
  const before=f.runtime.consoleConfig();
  const result=await f.post('api/agent/configuration',{id:'seat',provider:{kind:'offline'},settings:{model:'',personality:'schemer'},requireUnbound:true});
  assert.equal(result.status,409);
  assert.deepEqual(f.runtime.consoleConfig(),before);
 }finally{await f.close();}
});

test('bootstrap identifies the binding guard supported by this running backend',async()=>{
 const f=await fixture();
 try{
  const response=await fetch(f.server.url+'api/agent/bootstrap',{headers:{cookie:f.cookie,'X-Agent-Console':'1'}});
  assert.equal(response.status,200);
  const boot=await response.json();assert.ok(boot.capabilities.includes('seat-binding.unbound-configuration/1'));
 }finally{await f.close();}
});
