/** Real loopback HTTP + independent subprocesses. Synthetic fixture grants only. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = resolve(import.meta.dirname, '../../..');
process.chdir(root);
const build = process.env.PLAYER_PROTOCOL_BUILD;
assert.ok(build, 'PLAYER_PROTOCOL_BUILD must name an isolated TypeScript output directory; use interop/run.mjs');
const {protocolHarness} = await import(pathToFileURL(join(build,'tests/player-protocol-test-helpers.js')));
const {createPlayerProtocolApi} = await import(pathToFileURL(join(build,'packages/server/src/player-protocol-api.js')));
const {SerialExecutor} = await import(pathToFileURL(join(build,'packages/server/src/player-access.js')));
const goBinary = process.env.PLAYER_GO_BINARY;
const pythonClient = process.env.PLAYER_PYTHON_CLIENT || join(root,'examples/player-clients/python/client.py');
assert.ok(goBinary, 'Build the independent Go executable and supply PLAYER_GO_BINARY; no silent skip');

async function run(language, args, token, cwd, expectedCode=0) {
  const command = language === 'python' ? process.env.PYTHON || 'python3' : goBinary;
  const argv = language === 'python' ? [pythonClient, ...args] : args;
  const child = spawn(command, argv, {cwd, env: {...process.env, PLAYER_EXECUTOR_TOKEN: token}, stdio: ['ignore','pipe','pipe']});
  let stdout='',stderr=''; child.stdout.on('data', x=>stdout+=x); child.stderr.on('data', x=>stderr+=x);
  const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
  const [code,signal]=await once(child,'close');clearTimeout(timer);
  assert.equal(code,expectedCode,`${language} failed (${signal}): ${stderr}`);
  assert.equal(stdout.includes(token)||stderr.includes(token),false,"Never print bearer credentials");
  return expectedCode===0?JSON.parse(stdout):{stdout,stderr};
}
async function listen(server,t) {
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, {drop=false, holdCommitted=false}={}) {
  let committedResolve; const committed = new Promise(resolve=>{committedResolve=resolve;});
  const h=protocolHarness(t);
  // The common server helper begins with an existing fixture lease; release it
  // before starting independent processes. No takeover endpoint is introduced.
  h.repository.controlOperation(h.first.principal,'release',{roomEpoch:h.authority.roomEpoch,sessionId:h.session,fence:h.lease.generation,idempotencyKey:'release-helper'});
  const server=createPlayerProtocolApi({repository:h.repository,roomId:'fixture-room',serial:new SerialExecutor(),load:()=>h.store.load(),commit:(room,rev)=>h.store.commit(room,rev)});
  const upstream=await listen(server,t);let posts=0,lookups=0,dropped=false;
  const proxy=createServer((req,res)=>{void(async()=>{
    const body=[];for await(const part of req)body.push(part);
    if(req.url==='/player/v2/commands')posts++;
    if(req.url==='/player/v2/commands/lookup')lookups++;
    const response=await fetch(upstream+req.url,{method:req.method,headers:{Authorization:req.headers.authorization,'Content-Type':'application/json'},...(req.method==='GET'?{}:{body:Buffer.concat(body)})});
    const bytes=Buffer.from(await response.arrayBuffer());
    if(holdCommitted&&req.url==='/player/v2/commands'&&response.ok){committedResolve(JSON.parse(bytes));return;}
    if(drop&&!dropped&&req.url==='/player/v2/commands'&&response.ok){dropped=true;res.destroy();return;}
    res.writeHead(response.status,{'Content-Type':'application/json'});res.end(bytes);
  })().catch(error=>res.destroy(error));});
  const origin=await listen(proxy,t);
  const directory=mkdtempSync(join(tmpdir(),'independent-player-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const scope=h.repository.scope('fixture-room',h.authority.roomEpoch,0);
  const identity={...scope,gamePlayer:0,lobbySeat:0,chatPlayer:0,chatCount:2,roster:[{gamePlayer:0,chatPlayer:0},{gamePlayer:1,chatPlayer:1}]};
  delete identity.roomEpoch;
  const identityPath=join(directory,'identity.json'),commandPath=join(directory,'command.json');
  writeFileSync(identityPath,JSON.stringify(identity));
  writeFileSync(commandPath,JSON.stringify({kind:'order',payload:{action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}}));
  return {h,server,proxy,directory,origin,identityPath,commandPath,committed,stats:()=>({posts,lookups,dropped})};
}
for(const language of ['python','go']) {
  test(`V07 ${language}: clean working directory read-only default, real lease/order/receipt, persisted cursor resume`,async t=>{
    const x=await fixture(t);const state=join(x.directory,language==='python'?'state.sqlite':'state.json');
    const args=['--origin',x.origin,'--identity',x.identityPath,'--state',state];
    const readonly=await run(language,args,x.h.first.token,x.directory);
    assert.equal(readonly.mode,'paused');assert.equal(x.h.store.load().room.state.commands.length,0);assert.equal(x.stats().posts,0);
    const written=await run(language,[...args,'--allow-write','--command',x.commandPath],x.h.first.token,x.directory);
    assert.equal(written.receipt.state,'applied');assert.equal(written.receipt.effectCommitted,true);assert.equal(x.h.store.load().room.state.commands.length,1);
    const resumed=await run(language,[...args,'--resume-only'],x.h.first.token,x.directory);
    assert.equal(resumed.mode,'paused');assert.equal(x.stats().posts,1);assert.equal(x.h.store.load().room.state.commands.length,1);
    const resumedAgain=await run(language,[...args,'--resume-only'],x.h.first.token,x.directory);
    assert.equal(resumedAgain.cursor,resumed.cursor);assert.equal(x.stats().posts,1);
    assert.equal(readFileSync(state).includes(Buffer.from(x.h.first.token)),false,'credential must not be persisted');
  });
  test(`C04 V07 ${language}: real response dropped after commit; lookup finds original intent with no resend`,async t=>{
    const x=await fixture(t,{drop:true});const args=['--origin',x.origin,'--identity',x.identityPath,'--state',join(x.directory,language==='python'?'state.sqlite':'state.json')];
    const written=await run(language,[...args,'--allow-write','--command',x.commandPath],x.h.first.token,x.directory);
    assert.equal(written.recovery.status,'found');assert.equal(written.recovery.receipt.state,'applied');assert.equal(x.stats().dropped,true);assert.equal(x.stats().lookups,1);assert.equal(x.stats().posts,1);assert.equal(x.h.store.load().room.state.commands.length,1);
    await run(language,[...args,'--resume-only'],x.h.first.token,x.directory);
    assert.equal(x.stats().posts,1);assert.equal(x.h.store.load().room.state.commands.length,1);
  });
}

function readClientState(language,path) {
  if(language==='go')return JSON.parse(readFileSync(path));
  const db=new DatabaseSync(path,{readOnly:true});try{return JSON.parse(db.prepare('SELECT document FROM state').get().document);}finally{db.close();}
}
async function commitAndKill(t,language,x,args) {
  const program=language==='python'?'python3':goBinary;
  const argv=[...(language==='python'?[pythonClient]:[]),...args,'--allow-write','--command',x.commandPath];
  const child=spawn(program,argv,{cwd:x.directory,env:{...process.env,PLAYER_EXECUTOR_TOKEN:x.h.first.token},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const exit=once(child,'close');let stderr='';child.stderr.on('data',d=>stderr+=d);
  const receipt=await Promise.race([x.committed,exit.then(()=>{throw Error('Child exited before commit: '+stderr)}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Commit timeout')),20000);timer.unref();})]);
  assert.equal(receipt.state,'applied');child.kill('SIGKILL');const [code,signal]=await exit;assert.equal(signal,'SIGKILL');
  return receipt;
}
for(const language of ['python','go']) {
  test(`C04 S06 L06 ${language}: SIGKILL after server commit and restart reconciles durable outbox`,async t=>{
    const x=await fixture(t,{holdCommitted:true});
    const args=['--origin',x.origin,'--identity',x.identityPath,'--state',join(x.directory,language==='python'?'state.sqlite':'state.json')];
    const committed=await commitAndKill(t,language,x,args);
    const before=readClientState(language,args[5]);
    assert.equal(before.outbox[committed.idempotencyKey].outcome,'unknown');
    // A denied bearer cannot erase or retire an already admitted command.
    x.h.repository.revokeGrant(x.h.first.principal.grantId);
    await run(language,[...args,'--resume-only'],x.h.first.token,x.directory,1);
    const denied=readClientState(language,args[5]);
    assert.deepEqual(denied.outbox,before.outbox);
    const replacement=x.h.grant();
    const recovered=await run(language,[...args,'--resume-only'],replacement.token,x.directory);
    assert.equal(recovered.reconciled.length,1);assert.equal(recovered.reconciled[0].result,'found');
    assert.equal(x.stats().posts,1);assert.equal(x.stats().lookups,1);assert.equal(x.h.store.load().room.state.commands.length,1);
  });
}
test('V07 Python and Go control distinct seats in the same isolated room',async t=>{
  const x=await fixture(t);
  const pythonArgs=['--origin',x.origin,'--identity',x.identityPath,'--state',join(x.directory,'python.sqlite'),'--allow-write','--command',x.commandPath];
  const python=await run('python',pythonArgs,x.h.first.token,x.directory);assert.equal(python.receipt.state,'applied');
  const grant=x.h.grant(1);const identity=JSON.parse(readFileSync(x.identityPath));
  Object.assign(identity,{playerId:x.h.repository.scope('fixture-room',x.h.authority.roomEpoch,1).playerId,gamePlayer:1,lobbySeat:1,chatPlayer:1});
  const identityPath=join(x.directory,'identity-go.json'),commandPath=join(x.directory,'command-go.json');
  writeFileSync(identityPath,JSON.stringify(identity));writeFileSync(commandPath,JSON.stringify({kind:'order',payload:{action:{kind:'set-shields',outpostId:'红方矿场',enabled:false}}}));
  const goArgs=['--origin',x.origin,'--identity',identityPath,'--state',join(x.directory,'go.json'),'--allow-write','--command',commandPath];
  const go=await run('go',goArgs,grant.token,x.directory);assert.equal(go.receipt.state,'applied');
  assert.notEqual(go.receipt.scope.playerId,python.receipt.scope.playerId);assert.equal(go.receipt.scope.roomEpoch,python.receipt.scope.roomEpoch);
  assert.equal(x.h.store.load().room.state.commands.length,2);assert.equal(x.stats().posts,2);
});

for(const language of ['python','go']) {
  test(`E04 C10 V07 ${language}: opaque subject survives authoritative seat renumbering without replaying old intent`,async t=>{
    const x=await fixture(t,{holdCommitted:true});
    const state=join(x.directory,language==='python'?'state.sqlite':'state.json');
    const args=['--origin',x.origin,'--identity',x.identityPath,'--state',state];
    const committed=await commitAndKill(t,language,x,args);
    assert.match(committed.scope.playerId,/^player-[0-9a-f-]{36}$/);
    const other=x.h.repository.scope('fixture-room',committed.scope.roomEpoch,1);
    const epoch=x.h.repository.ensureEpoch('fixture-room',2,{fork:true,subjectMapping:[{oldPlayer:0,newPlayer:1},{oldPlayer:1,newPlayer:0}]}).roomEpoch;
    const mapped=x.h.repository.scope('fixture-room',epoch,1);
    assert.equal(mapped.playerId,committed.scope.playerId);assert.notEqual(mapped.playerId,other.playerId);
    const identity=JSON.parse(readFileSync(x.identityPath));
    Object.assign(identity,{playerId:mapped.playerId,gamePlayer:1,lobbySeat:1,chatPlayer:1});
    // This fixture acts as the trusted binding authority, not an unverified hello.
    writeFileSync(x.identityPath,JSON.stringify(identity));
    const grant=x.h.grant(1);
    const result=await run(language,[...args,'--resume-only'],grant.token,x.directory);
    assert.equal(result.reconciled[0].result,'found');assert.equal(result.scope.roomEpoch,epoch);
    const record=readClientState(language,state).outbox[committed.idempotencyKey];
    assert.equal(record.outcome,'applied');assert.equal(record.blocked,'epoch-or-identity-changed');
    assert.equal(record.request.roomEpoch,committed.scope.roomEpoch);assert.deepEqual(record.receipt,committed);
    assert.equal(x.stats().posts,1);assert.equal(x.h.store.load().room.state.commands.length,1);
  });
}

// V07-runtime is deliberately separate from the nine independent-client/core
// cases: it executes the real official AgentRuntime and SeatRunner, not a bare SDK.
test('V07-runtime: official AgentRuntime, Python and Go share three isolated seats with private state and exactly-once effects', {timeout:60000}, async t=>{
  const [{AgentRuntime,agentStoreKey},{parseAgentConfig},{createGameOnlyServer},{createFleetScenario},{createHash}]=await Promise.all([
    import(pathToFileURL(join(build,'packages/ai/src/application/agent-runtime.js'))),
    import(pathToFileURL(join(build,'packages/ai/src/controller/contracts/agent-config.js'))),
    import(pathToFileURL(join(build,'packages/server/src/game-server.js'))),
    import(pathToFileURL(join(build,'packages/engine/src/index.js'))),
    import('node:crypto'),
  ]);
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const directory=mkdtempSync(join(tmpdir(),'three-client-runtime-'));
  const roomId='synthetic-three-client-runtime';
  const setup=JSON.parse(readFileSync(join(root,'examples/fleet-lab.json'))).initial;
  setup.economy.players.push({active:true,neptunium:0,minesCreated:0});
  setup.economy.outposts.find(outpost=>outpost.id==='红方后方').owner=2;
  const access={format:'player-access/1',roomId,credentials:[0,1,2].map(player=>({player,token:hash(`synthetic-three-seat-owner-${player}`)}))};
  const service=await createGameOnlyServer({store:join(directory,'authority.sqlite'),access,initialRoom:{state:createFleetScenario(setup),scheduled:[],playerRoomId:roomId},clock:'manual',checkpointDirectory:join(directory,'unused-checkpoints')});
  const runtimes=[];let proxy;
  t.after(async()=>{
    for(const runtime of runtimes)await runtime.shutdown();
    if(proxy){proxy.closeAllConnections();await new Promise(done=>proxy.close(done));}
    await service.close();rmSync(directory,{recursive:true,force:true});
  });
  const address=await service.listen(),upstream=`http://127.0.0.1:${address.port}`;
  const epoch=service.repository.currentEpoch(roomId),tokens=[0,1,2].map(player=>hash(`synthetic-three-seat-executor-${player}`));
  for(const player of [0,1,2])service.repository.registerGrant({grantId:`synthetic-three-grant-${player}`,roomId,roomEpoch:epoch,player,tokenHash:hash(tokens[player]),expiresAtMs:Date.now()+120000,scopes:['observe','events.read','commands.write','control.lease',...(player===0?['chat.send','commander.worker']:[])]});
  const privateNotices=['SYNTHETIC_PRIVATE_OFFICIAL_THREAD','SYNTHETIC_PRIVATE_PYTHON_THREAD','SYNTHETIC_PRIVATE_GO_THREAD'];
  for(const player of [0,1,2])service.commander.workerSync(roomId,player,{op:'notice',id:`private-${player}`,reply:privateNotices[player]},setup.economy.initialTick);
  const requests=[];
  proxy=createServer((req,res)=>{void(async()=>{
    const parts=[];for await(const part of req)parts.push(part);
    const body=Buffer.concat(parts),seat=tokens.indexOf(String(req.headers.authorization??'').replace(/^Bearer /,''));
    const response=await fetch(upstream+req.url,{method:req.method,headers:{Authorization:String(req.headers.authorization??''),'Content-Type':'application/json'},...(req.method==='GET'?{}:{body})});
    const bytes=Buffer.from(await response.arrayBuffer());
    requests.push({seat,path:req.url,method:req.method,body:body.toString(),status:response.status,response:bytes.toString()});
    res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json'});res.end(bytes);
  })().catch(error=>res.destroy(error));});
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const origin=`http://127.0.0.1:${proxy.address().port}`;
  const scopes=[0,1,2].map(player=>service.repository.scope(roomId,epoch,player));
  assert.equal(new Set(scopes.map(scope=>scope.playerId)).size,3);
  for(const scope of scopes)assert.match(scope.playerId,/^player-[0-9a-f-]{36}$/);
  const roster=[0,1,2].map(player=>({gamePlayer:player,chatPlayer:player}));
  const clients=[];
  for(const [player,language,outpostId] of [[1,'python','红方矿场'],[2,'go','红方后方']]){
    const identity={...scopes[player],gamePlayer:player,lobbySeat:player,chatPlayer:player,chatCount:3,roster};delete identity.roomEpoch;
    const identityPath=join(directory,`${language}-identity.json`),commandPath=join(directory,`${language}-command.json`),state=join(directory,language==='python'?'python.sqlite':'go.json');
    writeFileSync(identityPath,JSON.stringify(identity));writeFileSync(commandPath,JSON.stringify({kind:'order',payload:{action:{kind:'set-shields',outpostId,enabled:false}}}));
    const args=['--origin',origin,'--identity',identityPath,'--state',state];
    const readonly=await run(language,args,tokens[player],directory);assert.equal(readonly.mode,'paused');
    clients.push({player,language,args,commandPath,state});
  }
  const modelSecret='SYNTHETIC_LOCAL_MODEL_SECRET_NEVER_UPLOAD';
  const localMemory='SYNTHETIC_OFFICIAL_LOCAL_STRATEGY_NEVER_UPLOAD';
  const {observation}=await import(pathToFileURL(join(build,'packages/server/src/player-api.js')));
  const officialOutpost=observation(service.store.load().room,0,roomId).outpostNames['蓝方工厂'];
  assert.ok(officialOutpost,'fake provider uses the same authorized outpost name as the model prompt');
  let calls=0;const providerInputs=[];
  const provider={step:async request=>{
    providerInputs.push(JSON.stringify(request));calls++;
    assert.ok(calls<=2,'Unexpected model/provider call after one explicitly requested round');
    return{tokens:0,reply:calls===1?{tool:'order',arguments:{action:{kind:'set-shields',outpostId:officialOutpost,enabled:false}},summary:'Synthetic official order'}:{tool:'finish',arguments:{memory:{strategy:localMemory}},summary:'Synthetic private finish'}};
  }};
  const seat={id:'official',serverUrl:origin,roomId,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:3,tokenEnv:'EXECUTOR_TOKEN',roster,settings:{model:'synthetic-model',personality:'schemer'}};
  const config=parseAgentConfig({storeDirectory:join(directory,'official-private'),seats:[seat]});
  const environment={EXECUTOR_TOKEN:tokens[0],OPENAI_API_KEY:modelSecret};
  let runtime=new AgentRuntime(config,provider,environment);runtimes.push(runtime);
  assert.ok(runtime instanceof AgentRuntime);assert.equal(runtime.status()[0].enabled,false);assert.equal(calls,0);assert.equal(service.store.load().room.state.commands.length,0);
  await runtime.runOne('official'); // Explicit start: actual runtime -> SeatRunner -> fake provider -> tool -> v2.
  assert.equal(calls,2);assert.equal(runtime.status()[0].status,'paused');assert.equal(runtime.status()[0].error,null);
  assert.equal(service.store.load().room.state.commands.length,1);
  const receipts=[];
  const officialDatabase=join(config.storeDirectory,agentStoreKey(seat)+'.sqlite');
  function officialState(){const db=new DatabaseSync(officialDatabase,{readOnly:true});try{return{transport:JSON.parse(db.prepare('SELECT document FROM player_protocol_client WHERE singleton=1').get().document),private:JSON.parse(db.prepare('SELECT payload FROM seats WHERE room=? AND seat=0').get(roomId).payload)};}finally{db.close();}}
  const official=officialState(),officialOrders=Object.values(official.transport.outbox).filter(record=>record.request.kind==='order');
  assert.equal(officialOrders.length,1);assert.equal(officialOrders[0].receipt.state,'applied');assert.equal(official.private.memory.strategy,localMemory);
  receipts.push(officialOrders[0].receipt);
  for(const client of clients){
    const output=await run(client.language,[...client.args,'--allow-write','--command',client.commandPath],tokens[client.player],directory);
    assert.equal(output.receipt.state,'applied');assert.equal(output.receipt.effectCommitted,true);assert.deepEqual(output.receipt.scope,scopes[client.player]);receipts.push(output.receipt);
  }
  assert.equal(service.store.load().room.state.commands.length,3);
  const orderPosts=()=>requests.filter(row=>row.path==='/player/v2/commands'&&JSON.parse(row.body).kind==='order');
  assert.deepEqual(orderPosts().map(row=>row.seat).sort(),[0,1,2]);
  assert.equal(new Set(receipts.map(receipt=>receipt.idempotencyKey)).size,3);
  for(let player=0;player<3;player++)assert.deepEqual(receipts[player].scope,scopes[player]);
  const states=[official.transport,...clients.map(client=>readClientState(client.language,client.state))];
  for(let player=0;player<3;player++){
    const own=JSON.stringify(states[player]);assert.ok(own.includes(privateNotices[player]),'Each snapshot has its own private thread');
    for(let other=0;other<3;other++)if(other!==player)assert.equal(own.includes(privateNotices[other]),false,'Another seat private thread leaked');
  }
  async function request(player,path,body){const response=await fetch(origin+'/player/v2'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+tokens[player],'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};}
  // Six directed cross-seat checks use real HTTP auth, not client-side hiding.
  for(let player=0;player<3;player++)for(let other=0;other<3;other++)if(player!==other){
    const hidden=await request(player,'/commands/'+receipts[other].commandId);assert.equal(hidden.status,404);
    assert.equal(JSON.stringify(hidden.body).includes(receipts[other].idempotencyKey),false);
    const lookup=await request(player,'/commands/lookup',{roomEpoch:epoch,idempotencyKeys:[receipts[other].idempotencyKey]});
    assert.equal(lookup.status,200);assert.equal(lookup.body.results[0].status,'absent_within_retained_scope');assert.equal(lookup.body.results[0].receipt,undefined);
    const crossed=await request(player,'/events?after='+encodeURIComponent(states[other].cursor)+'&limit=200');
    assert.equal(crossed.status,409);assert.equal(crossed.body.code,'RESYNC_REQUIRED');
  }
  for(let player=0;player<3;player++){
    const hello=await request(player,'/sessions/hello',{supportedVersions:[{major:2,minor:0}],requiredCapabilities:['core/2'],optionalCapabilities:[],executorInstanceId:`synthetic-repeat-hello-${player}`});
    assert.equal(hello.status,200);assert.deepEqual(hello.body.scope,scopes[player]);
  }
  await runtime.shutdown();runtime=new AgentRuntime(config,provider,environment);runtimes.push(runtime);
  await runtime.tick();assert.equal(runtime.status()[0].enabled,false);assert.equal(runtime.status()[0].calls,2);assert.equal(calls,2);
  for(const client of clients){const resumed=await run(client.language,[...client.args,'--resume-only'],tokens[client.player],directory);assert.equal(resumed.mode,'paused');}
  await runtime.shutdown();
  assert.equal(orderPosts().length,3);assert.equal(service.store.load().room.state.commands.length,3);assert.equal(calls,2);
  assert.ok(requests.every(row=>row.path.startsWith('/player/v2/')),'Official runtime must not silently fall back to v1');
  for(let player=0;player<3;player++){
    const traffic=JSON.stringify(requests.filter(row=>row.seat===player));
    for(let other=0;other<3;other++)if(other!==player)assert.equal(traffic.includes(privateNotices[other]),false);
  }
  assert.equal(JSON.stringify(requests).includes(localMemory),false,'Official memory stays local');
  assert.equal(JSON.stringify(requests).includes(modelSecret),false,'Model credentials never enter game protocol');
  assert.equal(providerInputs.some(input=>input.includes(privateNotices[1])||input.includes(privateNotices[2])),false);
  for(const client of clients){const bytes=readFileSync(client.state);assert.equal(bytes.includes(Buffer.from(localMemory)),false);assert.equal(bytes.includes(Buffer.from(modelSecret)),false);}
});
