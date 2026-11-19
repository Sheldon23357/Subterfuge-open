import {AgentRuntime} from './helpers/scripted-controller.js';
import {AgentRuntime as ProductAgentRuntime} from '../packages/ai/src/reference.js';
import {SeatRunner as ProductSeatRunner} from '../packages/ai/src/reference.js';
import {initialState} from '../packages/ai/src/controller/contracts/types.js';
import type {BotBackgroundServices} from '../packages/ai/src/controller/contracts/bot-mode.js';
import {test} from 'node:test';
import {resolveReferenceBotMode} from '../packages/ai/src/reference.js';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';import {AiStore,MAX_AGENT_INSTANCES,GameTransportError,agentStoreKey,parseAgentConfig,type AgentSeatConfig} from '../packages/ai/src/index.js';
import {ProtocolPlayerGateway} from '../packages/ai/src/controller/transport/protocol-gateway.js';
import {createFleetScenario,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {createPlayerApi,observation} from '../packages/server/src/player-api.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {RoomStore} from '../packages/server/src/room-store.js';
import {PlayerProtocolCoordinator} from '../packages/server/src/player-protocol-coordinator.js';
import {ChatStore} from '../packages/server/src/chat.js';
import {CommanderStore} from '../packages/server/src/commander-store.js';
import type {AgentProvider} from '../packages/ai/src/controller/contracts/types.js';
import {ProviderError} from '../packages/ai/src/controller/contracts/provider-error.js';
import {DatabaseSync} from 'node:sqlite';
import {GameRequestError} from '../packages/ai/src/controller/transport/gateway.js';
const fake:AgentProvider={step:async()=>({reply:{tool:'finish',arguments:{},summary:'fake'},tokens:0})};
test('temporary runtime transport failure retains run intent, reconnects automatically, and explicit pause cancels it',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const runtime=Object.create(AgentRuntime.prototype) as any;let starts=0;
 const entry={config:{id:'seat'},desired:true,gateway:{writable:true,cancelAcquire:()=>{},debugGate:{cancel:()=>{}}},runner:{closeForeground:()=>{},startReadinessTiming:()=>()=>{},state:{enabled:true,status:'waiting',error:null},pause(){this.state.enabled=false;this.state.status='paused';}}};
 Object.assign(runtime,{entries:new Map([['seat',entry]]),redact:(v:unknown)=>v,recordRuntimeError:()=>{},start:async()=>{starts++;}});
 const failure=new GameTransportError({requestId:'test',method:'POST',path:'/player/v2/control/ready',origin:'http://127.0.0.1',timeoutMs:15000,elapsedMs:15000,stage:'connect-or-send',failure:'TRANSPORT_UNCONFIRMED',outcome:'unknown'});
 runtime.halt(entry,failure,'readiness-report');assert.equal(entry.desired,true);assert.equal(entry.runner.state.enabled,true);
 t.mock.timers.tick(14999);assert.equal(starts,0);t.mock.timers.tick(1);await Promise.resolve();assert.equal(starts,1);
 entry.desired=true;runtime.halt(entry,failure,'control-renew');runtime.halt(entry);t.mock.timers.tick(300000);await Promise.resolve();assert.equal(starts,1);assert.equal(entry.desired,false);
});

for(const paused of [false,true])test(`in-flight observation cannot cancel runtime reconnect${paused?' or undo explicit pause':''}`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const runtime=Object.create(ProductAgentRuntime.prototype) as any;let starts=0,releases=0,errorReads=0;
 let finish!:()=>void;const observation=new Promise<void>(resolve=>{finish=resolve;});
 const entry={config:{id:'seat',roomId:'room',lobbySeat:0},desired:true,active:null,
  gateway:{writable:true,cancelAcquire:()=>{},debugGate:{cancel:()=>{}},release:async()=>{releases++;}},
  runner:{closeForeground:()=>{},startReadinessTiming:()=>()=>{},state:{enabled:true,status:'waiting',error:null},recovering:false,poll:()=>observation,pause(){this.state.enabled=false;this.state.status='paused';}},
  store:{latest:()=>{errorReads++;return undefined;}}};
 Object.assign(runtime,{fixedController:true,entries:new Map([['seat',entry]]),redact:(v:unknown)=>v,recordRuntimeError:()=>{},start:async()=>{starts++;}});
 const poll=runtime.poll(entry);
 const failure=new GameTransportError({requestId:'event-wait',method:'GET',path:'/player/v2/events',origin:'http://127.0.0.1',timeoutMs:15000,elapsedMs:15000,stage:'connect-or-send',failure:'TRANSPORT_UNCONFIRMED',outcome:'read-only'});
 runtime.halt(entry,failure,'event-wait');
 if(paused)runtime.halt(entry);
 finish();await poll;
 assert.equal(entry.desired,!paused);assert.equal(entry.runner.state.enabled,!paused);
 assert.equal(entry.runner.state.status,paused?'paused':'error');assert.equal(releases,0);assert.equal(errorReads,0);
 t.mock.timers.tick(14999);assert.equal(starts,0);
 t.mock.timers.tick(1);await Promise.resolve();assert.equal(starts,paused?0:1);
 runtime.halt(entry);
});

for(const code of ['CONTROL_RESPONSE_OBSOLETE','CONTROL_OPERATION_PENDING','LEASE_NOT_OWNED'])test(`transient control response ${code} retains intent and re-enters fenced acquisition`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const runtime=Object.create(AgentRuntime.prototype) as any;let starts=0;
 const entry={config:{id:'seat'},desired:true,gateway:{writable:true,cancelAcquire:()=>{},debugGate:{cancel:()=>{}}},runner:{closeForeground:()=>{},startReadinessTiming:()=>()=>{},state:{enabled:true,status:'waiting',error:null},pause(){this.state.enabled=false;}}};
 Object.assign(runtime,{entries:new Map([['seat',entry]]),redact:(v:unknown)=>v,recordRuntimeError:()=>{},start:async()=>{starts++;}});
 runtime.halt(entry,new GameRequestError(400,undefined,code),'control-renew');assert.equal(entry.desired,true);assert.equal(entry.runner.state.enabled,true);t.mock.timers.tick(15000);await Promise.resolve();assert.equal(starts,1);
 runtime.halt(entry);
});

for(const operation of ['control-renew','readiness-clear','runner'])for(const representation of ['transport','request'])test(`stale fence during ${operation} (${representation}) retains intent without replaying a write`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const runtime=Object.create(AgentRuntime.prototype) as any;let starts=0;
 const entry={config:{id:'seat'},desired:true,gateway:{writable:true,cancelAcquire:()=>{},debugGate:{cancel:()=>{}}},runner:{closeForeground:()=>{},startReadinessTiming:()=>()=>{},state:{enabled:true,status:'waiting',error:null},pause(){this.state.enabled=false;}}};
 Object.assign(runtime,{entries:new Map([['seat',entry]]),redact:(v:unknown)=>v,recordRuntimeError:()=>{},start:async()=>{starts++;}});
 const error=representation==='request'?new GameRequestError(409,undefined,'FENCE_STALE'):new GameTransportError({requestId:'old-fence',method:'POST',path:'/player/v2/control/renew',origin:'http://127.0.0.1',timeoutMs:15000,elapsedMs:0,stage:'http-response',failure:'FENCE_STALE',outcome:'rejected',status:409});
 runtime.halt(entry,error,operation);assert.equal(entry.desired,true);assert.equal(entry.runner.state.enabled,true);assert.equal(entry.gateway.writable,false);
 t.mock.timers.tick(14999);assert.equal(starts,0);t.mock.timers.tick(1);await Promise.resolve();assert.equal(starts,1);
 runtime.halt(entry);t.mock.timers.tick(300000);await Promise.resolve();assert.equal(starts,1);
});

for(const code of ['UNAUTHORIZED','SCOPE_DENIED','ROOM_EPOCH_CHANGED','IDENTITY_MISMATCH','LEASE_LOST'])test(`fatal authority change ${code} never automatically reacquires`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const runtime=Object.create(AgentRuntime.prototype) as any;let starts=0;
 const entry={config:{id:'seat'},desired:true,gateway:{writable:true,cancelAcquire:()=>{},debugGate:{cancel:()=>{}}},runner:{closeForeground:()=>{},startReadinessTiming:()=>()=>{},state:{enabled:true,status:'waiting',error:null},pause(){this.state.enabled=false;}}};
 Object.assign(runtime,{entries:new Map([['seat',entry]]),redact:(v:unknown)=>v,recordRuntimeError:()=>{},start:async()=>{starts++;}});
 runtime.halt(entry,new GameTransportError({requestId:'fatal',method:'POST',path:'/player/v2/control/renew',origin:'http://127.0.0.1',timeoutMs:15000,elapsedMs:0,stage:'http-response',failure:code,outcome:'rejected',status:403}),'control-renew');
 assert.equal(entry.desired,false);assert.equal(entry.runner.state.enabled,false);t.mock.timers.tick(300000);await Promise.resolve();assert.equal(starts,0);
});

test('runner transport failures enter automatic reconciliation instead of disabling the seat',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const runtime=Object.create(AgentRuntime.prototype) as any;let released=0;
 const request={requestId:'test',method:'POST',path:'/player/v2/commands',origin:'http://127.0.0.1',timeoutMs:15000,elapsedMs:15000,stage:'connect-or-send',failure:'TRANSPORT_UNCONFIRMED',outcome:'unknown'};
 const entry={config:{id:'seat',roomId:'room',lobbySeat:0},desired:true,active:null,gateway:{writable:false,cancelAcquire:()=>{},debugGate:{cancel:()=>{}},release:async()=>{released++;}},runner:{closeForeground:()=>{},startReadinessTiming:()=>()=>{},state:{enabled:true,status:'error',error:'transport'},recovering:false,poll:async()=>{},advanceReadiness:()=>null,pause(){this.state.enabled=false;this.state.status='paused';}},store:{latest:()=>({diagnostic:{request}})}};
 Object.assign(runtime,{fixedController:true,entries:new Map([['seat',entry]]),redact:(v:unknown)=>v,recordRuntimeError:()=>{}});
 await runtime.poll(entry);assert.equal(entry.desired,true);assert.equal(entry.runner.state.enabled,true);assert.equal(released,1);runtime.halt(entry);
});

test('a recovering seat refreshes its fenced gateway before attempting readiness writes',async()=>{
 const runtime=Object.create(AgentRuntime.prototype) as any;let polls=0,writes=0;
 const state={status:'error'},entry={desired:true,starting:null,active:null,gateway:{writable:false,request:async()=>{writes++;throw Error('Write while recovering');}},runner:{closeForeground:()=>{},startReadinessTiming:()=>()=>{},state,recovering:true,poll:async()=>{polls++;},advanceReadiness:()=>null}};
 runtime.fixedController=true;await runtime.poll(entry);assert.equal(polls,1);assert.equal(writes,0);assert.equal(entry.desired,true);
});

test('a rejected stale readiness assignment schedules ordinary observation without halting or resending',async()=>{
 const runtime=Object.create(AgentRuntime.prototype) as any;let calls=0;const records:any[]=[];
 const entry={reportedReadiness:'old-ack' as string|undefined,desired:true,gateway:{writable:true,request:async()=>{calls++;throw new GameRequestError(409,undefined,'REVISION_CONFLICT');}},runner:{closeForeground:()=>{},startReadinessTiming:()=>()=>{},state:{},telemetry:{tick:1}},store:{recordTiming:()=>{},save:(_state:unknown,kind:string,details:unknown)=>records.push({kind,details})}};
 await runtime.reportReadiness(entry,{ready:true,revision:'old',chatCursor:0},'readiness-report');
 assert.equal(entry.desired,true);assert.equal(calls,1);assert.equal(records[0].kind,'readiness-stale');assert.equal(entry.reportedReadiness,undefined);
 entry.gateway.request=async()=>{throw new GameRequestError(409,undefined,'FENCE_STALE');};
 await assert.rejects(runtime.reportReadiness(entry,{ready:false},'readiness-clear'));
});

test('idle event-driven seats never repeat full observation on a timer; real events and local publications still wake them',async t=>{
 const runtime=Object.create(AgentRuntime.prototype) as any,writes:boolean[]=[];let signature='first',observations=0;
 let clock=Date.now(),onPoll=()=>{},ready=true;t.mock.method(Date,'now',()=>clock);
 const entry={config:{settings:{}},desired:true,active:null,watching:undefined as Promise<void>|undefined,gateway:{writable:true,get readinessSignature(){return signature;},request:async(_path:string,body:{ready:boolean})=>{writes.push(body.ready);return {ready:body.ready};}},runner:{closeForeground:()=>{},startReadinessTiming:()=>()=>{},state:{status:'waiting'},telemetry:{tick:1},backgroundWakeRevision:0,hasUnresolvedWrites:false,poll:async()=>{observations++;onPoll();},advanceReadiness:()=>ready?{tick:1,revision:'same-world',chatCursor:0}:null},store:{recordTiming:()=>{},save:()=>{}}};
 runtime.fixedController=true;
 await runtime.poll(entry);await runtime.poll(entry);assert.deepEqual(writes,[true]);
 signature='new-input';await runtime.poll(entry);assert.deepEqual(writes,[true,true]);
 entry.watching=Promise.resolve();const before=observations;
 for(let i=0;i<3;i++){clock+=60000;await runtime.poll(entry);}
 assert.equal(observations,before,'idle seats remain ready even after minutes without an event');
 await runtime.poll(entry,false,undefined,true);assert.equal(observations,before+1,'a protocol event refreshes observations');
 entry.runner.backgroundWakeRevision=1;
 onPoll=()=>{entry.runner.backgroundWakeRevision=2;onPoll=()=>{};};
 await runtime.poll(entry);await runtime.poll(entry);await runtime.poll(entry);
 assert.equal(observations,before+1,'same-tick background publications do not reopen a completed foreground');onPoll=()=>{};
 ready=false;entry.runner.hasUnresolvedWrites=true;await runtime.poll(entry);assert.equal(observations,before+2,'unsettled work is still serviced');
 ready=true;entry.runner.hasUnresolvedWrites=false;await runtime.poll(entry,true);assert.equal(observations,before+3,'explicit runs still work');
 assert.deepEqual(writes,[true,true],'unchanged readiness is never resubmitted');
 delete (entry as {reportedReadiness?:string}).reportedReadiness;
 await runtime.poll(entry);assert.equal(observations,before+4,'a new lease or unconfirmed readiness must refresh and report');
 assert.deepEqual(writes,[true,true,true]);
});

for(const stage of ['observation','readiness'] as const)test(`protocol wakes during ${stage} survive the active poll and refresh readiness once`,async()=>{
 const runtime=Object.create(AgentRuntime.prototype) as any;let observations=0,writes=0,release!:()=>void,entered!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let signature='before';
 const entry={config:{settings:{}},desired:true,active:null,watching:Promise.resolve(),gateway:{writable:true,get readinessSignature(){return signature;},request:async()=>{writes++;if(stage==='readiness'&&writes===1){entered();await blocked;}return {ready:true};}},runner:{closeForeground:()=>{},startReadinessTiming:()=>()=>{},running:false,state:{status:'waiting'},telemetry:{tick:1},poll:async()=>{observations++;if(stage==='observation'&&observations===1){entered();await blocked;}if(observations>1)signature='after';},advanceReadiness:()=>({tick:1,revision:'world',chatCursor:0})},store:{recordTiming:()=>{},save:()=>{}}};
 runtime.fixedController=true;
 const active=runtime.poll(entry);await started;
 await runtime.poll(entry,false,undefined,true);await runtime.poll(entry,false,undefined,true);
 assert.equal(observations,1,'events cannot start a concurrent foreground poll');
 release();await active;await runtime.poll(entry);
 assert.equal(observations,2,'coalesced pending events refresh the next observation');assert.equal(writes,2,'new decision inputs receive a fresh ready assignment');
 await runtime.poll(entry);assert.equal(observations,2,'settled seats return to event-only waiting');
});

test('background publication marks a new observation wake, but paused seats cannot create one',()=>{
 const store=new AiStore(':memory:'),state=initialState('background-wake',0,{mode:'hybrid',model:'',personality:'schemer'});let wake!:()=>void;
 const mode={...resolveReferenceBotMode(state.settings),createBackground:(services:BotBackgroundServices)=>{wake=services.wake;return {settling:false,observe:()=>{},pause:()=>{},drain:async()=>{}};}};
 try{
  const runner=new ProductSeatRunner(state,store,{snapshot:async()=>{throw Error('Unexpected read');},request:async()=>{throw Error('Unexpected write');}},fake,1000,{},()=>mode);
  (runner as any).observeBackground({});assert.equal(runner.backgroundWakeRevision,0);
  state.enabled=true;wake();assert.equal(runner.backgroundWakeRevision,1);
  wake();assert.equal(runner.backgroundWakeRevision,2);
  runner.pause();wake();assert.equal(runner.backgroundWakeRevision,2);
 }finally{store.close();}
});

test('completed tick dispatches publications and incoming chat only to background without another readiness report',async()=>{
 const runtime=Object.create(AgentRuntime.prototype) as any;runtime.fixedController=true;
 const options:{backgroundOnly?:boolean}[]=[];let writes=0;
 const entry={config:{settings:{}},desired:true,active:null,watching:Promise.resolve(),gateway:{writable:true,readinessSignature:'session-tick-1',request:async()=>{writes++;return{ready:true};}},runner:{closeForeground:()=>{},startReadinessTiming:()=>()=>{},state:{status:'waiting'},telemetry:{tick:1},backgroundWakeRevision:0,hasUnresolvedWrites:false,poll:async(_time:number,_force:boolean,_refresh:boolean,option:{backgroundOnly?:boolean})=>{options.push(option);},pollBackground:async()=>{options.push({backgroundOnly:true});},advanceReadiness:()=>({tick:1,revision:'initial',chatCursor:0})},store:{recordTiming:()=>{},save:()=>{}}};
 await runtime.poll(entry);assert.equal(writes,1);
 entry.runner.backgroundWakeRevision=1;await runtime.poll(entry);runtime.pollBackground(entry);await (entry as any).backgroundObservation;await runtime.poll(entry);runtime.pollBackground(entry);await (entry as any).backgroundObservation;
 (entry as any).backgroundEventRevision=1;await runtime.poll(entry);runtime.pollBackground(entry);await (entry as any).backgroundObservation;
 assert.deepEqual(options.map(o=>!!o.backgroundOnly),[false,true,true]);assert.equal(writes,1);
 entry.runner.hasUnresolvedWrites=true;await runtime.poll(entry);assert.equal(options.at(-1)!.backgroundOnly,undefined,'unresolved writes retain foreground recovery');
 entry.runner.hasUnresolvedWrites=false;entry.runner.telemetry.tick=2;entry.gateway.readinessSignature='session-tick-2';await runtime.poll(entry,false,undefined,true);
 assert.equal(writes,2,'next tick requires its own completion report');
});
function runtimeEntry(runtime:AgentRuntime,id:string){return (runtime as unknown as {entries:Map<string,{gateway:ProtocolPlayerGateway;commander:{tick:()=>void}}>}).entries.get(id)!;}
function nearExpiry(runtime:AgentRuntime,id:string){Object.defineProperty(runtimeEntry(runtime,id).gateway,'expiresAt',{configurable:true,get:()=>Date.now()+1000});}
for(const mixed of [false,true])test(`automatic ${mixed?'mixed':'programmatic'} seats observe independently while peers work and renew leases during the wait`,async()=>{
 const f=await fixture(),originalNow=Date.now;let now=originalNow(),release!:()=>void;
 const held=new Promise<void>(r=>{release=r;});let polls=0,renewals=0,commanderPolls=0;
 try{
  Date.now=()=>now;
  const entries=f.seats.map((config,i)=>{const gateway={config,programmaticAutoAdvance:true,expiresAt:now+30000,renew:async()=>{renewals++;gateway.expiresAt=now+30000;}};return {runner:{closeForeground:()=>{},startReadinessTiming:()=>()=>{},state:{}},config:{...config,settings:{provider:mixed&&i===0?'codex':'offline'}},gateway,active:null as Promise<void>|null,desired:true,commander:{tick:()=>{commanderPolls++;}}};});
  const runtime=Object.create(AgentRuntime.prototype) as any;
  Object.assign(runtime,{resolveMode:resolveReferenceBotMode,entries:new Map(entries.map((e,i)=>[String(i),e])),fixedController:true,pollBackground:()=>{},poll:async(e:typeof entries[number],_force:boolean,coalesce:number|undefined)=>{if(e.active)return;polls++;assert.equal(coalesce,1000);e.active=polls===2?held:Promise.resolve();await e.active;e.active=null;}});
  const cycle=runtime.tick();await new Promise(r=>setImmediate(r));assert.equal(polls,2);
  now+=11000;await runtime.tick();assert.equal(polls,3);assert.equal(renewals,2);assert.equal(commanderPolls,4);
  release();await cycle;await runtime.tick();assert.equal(polls,5);
  await runtime.tick();assert.equal(polls,7,'no cohort-wide one-second blackout after completion');
  entries[0]!.gateway.programmaticAutoAdvance=false;
  runtime.poll=async(_e:unknown,_force:boolean,coalesce:unknown)=>{polls++;assert.equal(coalesce,1000);};
  await runtime.tick();assert.equal(polls,9,'manual/unsupported server uses ordinary polling');
 }finally{release?.();Date.now=originalNow;await f.close();}
});
test('configured programmatic seats restore their adapter without inheriting a model transport',async()=>{
 const f=await fixture();let runtime:AgentRuntime|undefined,calls=0;
 const config=f.config();config.seats[0]!.settings={...config.seats[0]!.settings,provider:'offline',model:''};
 try{
  for(let restart=0;restart<2;restart++){
   runtime=new ProductAgentRuntime(config,{step:async()=>{calls++;throw Error('Unexpected model transport');}},f.env);
   assert.equal(runtime.consoleConfig().seats[0]!.providerConfig.kind,'offline');
   await runtime.runOne('seat0');
   assert.equal(runtime.status()[0]!.calls,0);assert.equal(runtime.status()[0]!.tokens,0);
   assert.equal(calls,0);assert.equal(runtime.status()[0]!.error,null);
   await runtime.shutdown();runtime=undefined;
  }
 }finally{await runtime?.shutdown();await f.close();}
});
for(const operation of ['control-acquire','control-renew','readiness-clear','readiness-report','control-release'])test(`runtime persists redacted ${operation} failures with transport evidence and survives restart`,async()=>{
 const f=await fixture(),config=f.config();config.seats=config.seats.map((s,i)=>({...s,id:`ai-0${i+1}`}));
 const options={fixedSlots:true,profilesPath:join(f.dir,'profiles.json')};let runtime:AgentRuntime|undefined;
 const methods={acquire:ProtocolPlayerGateway.prototype.acquire,renew:ProtocolPlayerGateway.prototype.renew,release:ProtocolPlayerGateway.prototype.release,request:ProtocolPlayerGateway.prototype.request};
 const originalNow=Date.now,originalError=console.error;const lines:string[]=[];console.error=(line:unknown)=>{lines.push(String(line));};
 const error=new GameTransportError({requestId:'synthetic-runtime-request',method:'POST',path:operation.startsWith('readiness')?'/player/v2/readiness':'/player/v2/control/acquire',origin:f.seats[0]!.serverUrl,timeoutMs:15000,elapsedMs:15001,stage:'connect-or-send',failure:'timeout',outcome:'unknown',cause:{name:'Error',message:`socket failed ${f.env.TOKEN_0}`,code:'ECONNRESET'}});
 try{
  runtime=new AgentRuntime(config,fake,f.env,options);
  if(operation==='control-acquire')ProtocolPlayerGateway.prototype.acquire=async()=>{throw error;};
  if(operation==='control-acquire')await assert.rejects(runtime.start('ai-01'));else await runtime.start('ai-01');
  if(operation==='control-renew'){ProtocolPlayerGateway.prototype.renew=async()=>{throw error;};nearExpiry(runtime,'ai-01');await runtime.tick();}
  if(operation.startsWith('readiness')){ProtocolPlayerGateway.prototype.request=async function(path,data){if(path==='/tool/control/ready'&&(data as {ready:boolean}).ready===(operation==='readiness-report'))throw error;return methods.request.call(this,path,data);};if(operation==='readiness-clear')await (runtime as any).poll((runtime as any).entries.get('ai-01'),true);else await runtime.tick();}
  if(operation==='control-release'){ProtocolPlayerGateway.prototype.release=async()=>{throw error;};await runtime.pause('ai-01');}
  const events=runtime.debugRead('ai-01','events') as {entries:{kind:string;payload:any}[]};const failure=events.entries.find(e=>e.kind==='runtime-error')!.payload;
  assert.equal(failure.operation,operation);assert.ok(!isNaN(Date.parse(failure.at)));assert.equal(failure.diagnostic.request.requestId,'synthetic-runtime-request');assert.equal(failure.diagnostic.request.failure,'timeout');assert.equal(failure.diagnostic.request.cause.code,'ECONNRESET');
  assert.equal(runtime.status()[0]!.enabled,operation!=='control-release');assert.ok(runtime.status()[0]!.error);assert.equal(f.commandCount(),0);
  assert.ok(lines.some(l=>JSON.parse(l).kind==='agent-runtime-error'));assert.ok(!JSON.stringify({lines,events,status:runtime.status()}).includes(f.env.TOKEN_0!));
  Object.assign(ProtocolPlayerGateway.prototype,methods);await runtime.shutdown();runtime=new AgentRuntime(config,fake,f.env,options);
  assert.ok(runtime.status()[0]!.error);assert.ok((runtime.debugRead('ai-01','events') as any).entries.some((e:any)=>e.kind==='runtime-error'&&e.payload.operation===operation));
 }finally{Date.now=originalNow;Object.assign(ProtocolPlayerGateway.prototype,methods);await runtime?.shutdown();console.error=originalError;await f.close();}
});
test('runtime records its original failure to stderr when SQLite persistence fails',async()=>{
 const f=await fixture();let runtime:AgentRuntime|undefined,db:DatabaseSync|undefined;
 const acquire=ProtocolPlayerGateway.prototype.acquire,originalError=console.error,lines:string[]=[];console.error=(line:unknown)=>{lines.push(String(line));};
 try{
  runtime=new AgentRuntime(f.config(),fake,f.env);db=new DatabaseSync(join(f.dir,'private',agentStoreKey(f.seats[0]!)+'.sqlite'));
  db.exec("CREATE TRIGGER synthetic_save_failure BEFORE UPDATE ON seats BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;");
  ProtocolPlayerGateway.prototype.acquire=async()=>{throw Error(`synthetic acquire failure ${f.env.TOKEN_0}`);};
  await assert.rejects(runtime.start('seat0'));assert.equal(runtime.status()[0]!.enabled,false);
  const failure=lines.map(l=>JSON.parse(l)).find(l=>l.event?.operation==='control-acquire');assert.ok(failure.persistenceError);assert.match(failure.event.diagnostic.cause.message,/synthetic acquire failure/);assert.ok(!lines.join('\n').includes(f.env.TOKEN_0!));
 }finally{ProtocolPlayerGateway.prototype.acquire=acquire;db?.exec('DROP TRIGGER IF EXISTS synthetic_save_failure');db?.close();await runtime?.shutdown();console.error=originalError;await f.close();}
});
test('controller polls unresolved idle seats every second without making additional model calls',async()=>{
 const f=await fixture();let runtime:AgentRuntime|undefined;const originalNow=Date.now;let now=originalNow();
 try{
  Date.now=()=>now;assert.equal(f.config().pollMs,1000);
  assert.throws(()=>parseAgentConfig({...f.config(),pollMs:999}),/pollMs/);
  runtime=new AgentRuntime(f.config(),fake,f.env);for(const seat of f.seats)runtimeEntry(runtime,seat.id).commander.tick=()=>{};
  // Exercise periodic fallback; completed seats use the protocol event watcher.
  const entry=runtimeEntry(runtime,'seat0') as unknown as {runner:{advanceReadiness:()=>null};gateway:ProtocolPlayerGateway};entry.runner.advanceReadiness=()=>null;
  let observations=0;const snapshot=entry.gateway.snapshot.bind(entry.gateway);entry.gateway.snapshot=(...args)=>{observations++;return snapshot(...args);};
  await runtime.start('seat0');await runtime.tick();
  // A verified unchanged event cut can reuse the HTTP snapshot; count logical observations.
  const observed=()=>observations;
  const first=observed();assert.ok(first>0);assert.equal(runtime.status()[0]!.calls,0);
  now+=999;await runtime.tick();assert.equal(observed(),first);
  now+=1;await runtime.tick();assert.equal(observed(),first+1);assert.equal(runtime.status()[0]!.calls,0);
  now+=1000;await runtime.tick();assert.equal(observed(),first+2);assert.equal(runtime.status()[0]!.calls,0);
 }finally{Date.now=originalNow;await runtime?.shutdown();await f.close();}
});
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'agent-runtime-test-'));
  const initial=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  initial.size={width:80,height:80};initial.positions={'蓝方工厂':{x:0,y:0},'红方矿场':{x:20,y:0},'红方后方':{x:25,y:0}};
  const accessFile=PlayerAccess.generate(2),roomId=accessFile.roomId,access=new PlayerAccess(accessFile),store=new RoomStore(join(dir,'rooms.sqlite'));
  store.commit({state:createFleetScenario(initial),scheduled:[],playerRoomId:roomId},0);
  const repository=store.protocol!,authority=repository.startAuthority(roomId,initial.economy.players.length);
  const botTokens=initial.economy.players.map((_,player)=>`synthetic-agent-runtime-${player}-`+'x'.repeat(32));
  for(const [player,token] of botTokens.entries())repository.registerGrant({grantId:`agent-runtime-grant-${player}`,roomId,roomEpoch:authority.roomEpoch,player,tokenHash:createHash('sha256').update(token).digest('hex'),scopes:['observe','events.read','commands.write','control.lease','chat.send','commander.worker'],expiresAtMs:Date.now()+60_000_000});
  const chat=new ChatStore(join(dir,'chat.json'));await chat.load();
  const commander=new CommanderStore(join(dir,'commander.json'));
  const coordinator=new PlayerProtocolCoordinator(repository,{roomId:()=>roomId,load:()=>store.load()!.room});await coordinator.bindDomains(chat,commander);coordinator.refreshWorld();
  store.onCommit(room=>coordinator.worldCommitted(room));
  const serial=new SerialExecutor(),server=createPlayerApi({protocol:{repository,roomId,serial,load:()=>store.load()!,commit:(next,revision)=>store.commit(next,revision),ownerIdentity:authorization=>{const player=access.identity(authorization);return player===null?null:{roomId,player};},chat:()=>chat,commander,snapshot:player=>coordinator.snapshot(player),capabilities:()=>[...coordinator.capabilities(),'activity.read/1'],instructionsVersion:player=>coordinator.instructionsVersion(player)}});
  const requests:string[]=[];server.on('request',req=>requests.push(`${req.method} ${req.url}`));
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error();
  const seats:AgentSeatConfig[]=[0,1].map(i=>({id:`seat${i}`,serverUrl:`http://127.0.0.1:${address.port}`,roomId,lobbySeat:i,gamePlayer:i,chatPlayer:i,chatCount:2,tokenEnv:`TOKEN_${i}`,settings:{model:'',personality:'schemer'}}));
  const env=Object.fromEntries(botTokens.map((token,i)=>[`TOKEN_${i}`,token]));
  return {dir,seats,env,requests,accessFile,advance:()=>{const saved=store.load()!;store.commit({...saved.room,state:advanceFleetScenario(saved.room.state,saved.room.state.economy.tick+1)},saved.revision);},name:(id:string)=>observation(store.load()!.room,0,roomId).outpostNames![id]!,commandCount:()=>store.load()!.room.state.commands.length,config:()=>parseAgentConfig({storeDirectory:join(dir,'private'),seats}),close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('independent runtime isolates server/room/seat keys and rejects unsafe origins',()=>{
  const s:AgentSeatConfig={id:'a',serverUrl:'http://localhost:1',roomId:'r',lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'T',settings:{model:'',personality:'schemer'}};
  const keys=[agentStoreKey(s),agentStoreKey({...s,serverUrl:'http://localhost:2'}),agentStoreKey({...s,roomId:'r2'}),agentStoreKey({...s,lobbySeat:1})];assert.equal(new Set(keys).size,4);
  for(const serverUrl of ['http://example.com','https://user:password@example.com','https://example.com/?token=secret'])assert.throws(()=>parseAgentConfig({storeDirectory:'/tmp/unused',seats:[{...s,serverUrl}]}));
  assert.throws(()=>parseAgentConfig({storeDirectory:'/tmp/unused',seats:[s,{...s,id:'b'}]}));
});
test('gateway refuses writes without acquiring control',async()=>{
  const f=await fixture();try{
    const g=new ProtocolPlayerGateway(f.seats[0]!,f.env.TOKEN_0!);
    for(const path of ['/tool/order','/tool/schedule','/tool/cancel-schedule','/tool/chat','/tool/chat/seen','/tool/control/ready'])await assert.rejects(g.request(path,{}));
    await assert.rejects(g.request('https://example.com/tool/order',{}));
    assert.deepEqual(f.requests,[]);
  }finally{await f.close();}
});
test('multiple independent seats run with fake providers and restart paused preserving counters',async()=>{
  const f=await fixture();let r:AgentRuntime|undefined;
  try{r=new AgentRuntime(f.config(),fake,f.env);assert.ok(r.status().every(s=>!s.enabled));
    await Promise.all(f.seats.map(s=>r!.runOne(s.id)));assert.ok(r.status().every(s=>s.calls===0&&s.status==='paused'));
    assert.ok(f.requests.every(s=>!s.startsWith('POST ')||s.startsWith('POST /player/v2/')));
    await r.shutdown();r=new AgentRuntime(f.config(),fake,f.env);assert.ok(r.status().every(s=>s.calls===0&&!s.enabled));
    assert.equal(readdirSync(join(f.dir,'private')).filter(n=>n.endsWith('.sqlite')).length,2);
  }finally{await r?.shutdown();await f.close();}
});
test('live ownership is acquired/released, authentication failure never retries',async()=>{
  const f=await fixture();let r:AgentRuntime|undefined;
  try{r=new AgentRuntime(f.config(),fake,f.env);await r.runOne('seat0');assert.equal(r.status()[0]!.calls,0);
    assert.equal(f.requests.filter(p=>p==='POST /player/v2/control/acquire'||p==='POST /player/v2/control/release').length,2);await r.shutdown();
    f.requests.length=0;r=new AgentRuntime(f.config(),fake,{...f.env,TOKEN_0:'invalid'});await assert.rejects(r.start('seat0'));await r.tick();await r.tick();
    assert.equal(f.requests.length,1);assert.equal(r.status()[0]!.enabled,false);
  }finally{await r?.shutdown();await f.close();}
});
test('same local store cannot be opened by concurrent runtimes; graceful close releases lock',async()=>{
  const f=await fixture();let r:AgentRuntime|undefined;
  try{r=new AgentRuntime(f.config(),fake,f.env);assert.throws(()=>new AgentRuntime(f.config(),fake,f.env));await r.shutdown();r=new AgentRuntime(f.config(),fake,f.env);assert.equal(r.status()[0]!.status,'paused');}
  finally{await r?.shutdown();await f.close();}
});
test('identity mismatch fails closed before provider use or claim',async()=>{
  const f=await fixture();let r:AgentRuntime|undefined;
  try{const c=f.config();c.seats[0]!.gamePlayer=1;r=new AgentRuntime(c,fake,f.env);await assert.rejects(r.start('seat0'));assert.ok(!f.requests.some(p=>p==='POST /player/v2/control/acquire'));}
  finally{await r?.shutdown();await f.close();}
});
test('old server missing control protocol fails closed in live mode',async()=>{
  const server=createServer((_req,res)=>{res.writeHead(404);res.end('{}');});server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();if(!a||typeof a==='string')throw Error();
  const c:AgentSeatConfig={id:'a',serverUrl:`http://127.0.0.1:${a.port}`,roomId:'r',lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'T',settings:{model:'',personality:'schemer'}};
  try{const g=new ProtocolPlayerGateway(c,'synthetic');await assert.rejects(g.acquire());assert.equal(g.writable,false);await assert.rejects(g.request('/tool/chat',{}));}
  finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('long in-flight turns renew separately, pause waits for provider settlement and blocks restart',async()=>{
  const f=await fixture();let r:AgentRuntime|undefined;
  let entered!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<void>(resolve=>{finish=resolve;});
  const provider:AgentProvider={step:async()=>{entered();await blocked;return {reply:{tool:'finish',arguments:{},summary:'fake'},tokens:0};}};
  const originalNow=Date.now;
  try{r=new AgentRuntime(f.config(),provider,f.env);await r.start('seat0');const turn=r.tick();await started;
    nearExpiry(r,'seat0');await r.tick();
    // Scheduling no longer waits for a still-valid lease's renewal response.
    await (r as unknown as {entries:Map<string,{renewing:Promise<void>|null}>}).entries.get('seat0')!.renewing;
    assert.equal(f.requests.filter(p=>p==='POST /player/v2/control/acquire'||p==='POST /player/v2/control/renew').length,2,'acquire plus renew while provider is unresolved');
    const pause=r.pause('seat0');await assert.rejects(r.start('seat0'),/stopping/);finish();await pause;await turn;
    assert.equal(r.status()[0]!.status,'paused');assert.equal(r.status()[0]!.enabled,false);
  }finally{Date.now=originalNow;finish();await r?.shutdown();await f.close();}
});
test('accepted order with lost response stops without automatically replaying the write',async()=>{
  const f=await fixture();let r:AgentRuntime|undefined;
  const upstream=f.seats[0]!.serverUrl;let writes=0,accepted=false;
  const proxy=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=Buffer.concat(chunks).toString();
    const headers:Record<string,string>={};for(const [k,v]of Object.entries(req.headers))if(typeof v==='string'&&!['host','connection','content-length'].includes(k))headers[k]=v;
    const response=await fetch(upstream+req.url,{method:req.method!,headers,...(body?{body}:{})});const text=await response.text();
    if(req.url==='/player/v2/commands'){writes++;accepted=response.ok;res.destroy();return;}
    res.writeHead(response.status,{'Content-Type':'application/json'});res.end(text);
  });proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const a=proxy.address();if(!a||typeof a==='string')throw Error();
  const provider:AgentProvider={step:async()=>({reply:{tool:'order',arguments:{action:{kind:'set-shields',outpostId:f.name('蓝方工厂'),enabled:false}},summary:'synthetic order'},tokens:0})};
  try{const config=f.config();config.seats[0]!.serverUrl=`http://127.0.0.1:${a.port}`;r=new AgentRuntime(config,provider,f.env);await r.runOne('seat0');await r.tick();await r.tick();
    assert.equal(writes,1);assert.equal(accepted,true);assert.equal(r.status()[0]!.enabled,false);assert.ok(r.status()[0]!.error);assert.ok(!JSON.stringify(r.status()).includes(f.env.TOKEN_0!));
  }finally{await r?.shutdown();proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));await f.close();}
});
test('one process keeps two different server/room stores and decisions independent',async()=>{
  const a=await fixture(),b=await fixture();let r:AgentRuntime|undefined;
  try{const config=a.config();config.seats=[a.seats[0]!,{...b.seats[0]!,id:'other',tokenEnv:'OTHER'}];r=new AgentRuntime(config,fake,{...a.env,OTHER:b.env.TOKEN_0!});
    await r.runOne('seat0');assert.equal(r.status().find(s=>s.id==='other')!.calls,0);await r.runOne('other');assert.ok(r.status().every(s=>s.calls===0));
  }finally{await r?.shutdown();await a.close();await b.close();}
});
test('lease deadline uses local request start rather than server wall clock',async()=>{
  const f=await fixture(),{MemoryProtocolClientStore}=await import('../packages/player-sdk/src/index.js');
  const skewedFetch:typeof fetch=async(input,init)=>{
    const response=await fetch(input,init),path=new URL(typeof input==='string'?input:input instanceof URL?input:input.url).pathname;
    if(!path.startsWith('/player/v2/control'))return response;
    const value=await response.json() as any;
    for(const control of [value,value.current,value.operationResult])if(control?.expiresAt)control.expiresAt=new Date(1).toISOString();
    return new Response(JSON.stringify(value),{status:response.status,headers:response.headers});
  };
  const g=new ProtocolPlayerGateway(f.seats[0]!,f.env.TOKEN_0!,new MemoryProtocolClientStore(),{fetch:skewedFetch});
  try{const before=Date.now();await g.acquire();assert.equal(g.writable,true);assert.ok(g.expiresAt>=before+29000);assert.ok(g.expiresAt<=Date.now()+30000);await g.release();}
  finally{g.close();await f.close();}
});
for(const rejection of [400,401,403,409,'stale'] as const){
  test(`post-acquire order ${rejection} ${rejection==='stale'||rejection===400?'continues normal feedback':'stops the decision immediately'}`,async()=>{
    const f=await fixture();let r:AgentRuntime|undefined,providerCalls=0,orderAttempts=0;
    const upstream=f.seats[0]!.serverUrl;
    const proxy=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const body=Buffer.concat(chunks).toString(),headers:Record<string,string>={};
      for(const [k,v]of Object.entries(req.headers))if(typeof v==='string'&&!['host','connection','content-length'].includes(k))headers[k]=v;
      if(req.url==='/player/v2/commands'){
        orderAttempts++;
        res.writeHead(rejection==='stale'?409:rejection,{'Content-Type':'application/json'});
        res.end(JSON.stringify({code:rejection==='stale'?'REVISION_CONFLICT':rejection===401?'UNAUTHORIZED':rejection===403?'SCOPE_DENIED':rejection===409?'FENCE_STALE':'INVALID_REQUEST',outcome:'rejected',message:'Synthetic rejection'}));return;
      }
      const response=await fetch(upstream+req.url,{method:req.method!,headers,...(body?{body}:{})});
      res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());
    });
    proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const address=proxy.address();if(!address||typeof address==='string')throw Error();
    const provider:AgentProvider={step:async()=>{providerCalls++;return {reply:providerCalls===1?{tool:'order',arguments:{action:{kind:'set-shields',outpostId:f.name('蓝方工厂'),enabled:false}},summary:'Synthetic order'}:{tool:'finish',arguments:{},summary:'No retry'},tokens:0};}};
    try{
      const config=f.config();config.seats[0]!.serverUrl=`http://127.0.0.1:${address.port}`;
      r=new AgentRuntime(config,provider,f.env);await r.runOne('seat0');await r.tick();await r.tick();
      assert.equal(orderAttempts,1);assert.equal(providerCalls,rejection==='stale'||rejection===400?2:1);
      assert.equal(r.status()[0]!.enabled,false);assert.equal(r.status()[0]!.owned,false);
      assert.equal(Boolean(r.status()[0]!.error),rejection!=='stale'&&rejection!==400);
      assert.ok(f.requests.includes('POST /player/v2/control/acquire'),'acquired control before tool rejection');
    }finally{await r?.shutdown();proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));await f.close();}
  });
}
for(const status of [408,500,503]){
  test(`accepted write followed by HTTP ${status} does not request another model decision`,async()=>{
    const f=await fixture();let r:AgentRuntime|undefined,providerCalls=0,writes=0,accepted=false;
    const upstream=f.seats[0]!.serverUrl;
    const proxy=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString();
      const headers:Record<string,string>={};for(const [k,v]of Object.entries(req.headers))if(typeof v==='string'&&!['host','connection','content-length'].includes(k))headers[k]=v;
      const response=await fetch(upstream+req.url,{method:req.method!,headers,...(body?{body}:{})});const text=await response.text();
      if(req.url==='/player/v2/commands'){writes++;accepted=response.ok;res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'TEMPORARY_FAILURE',outcome:'unknown',message:'Synthetic failure after commit'}));return;}
      res.writeHead(response.status,{'Content-Type':'application/json'});res.end(text);
    });
    proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const address=proxy.address();if(!address||typeof address==='string')throw Error();
    const provider:AgentProvider={step:async()=>{providerCalls++;return {reply:providerCalls===1?{tool:'order',arguments:{action:{kind:'set-shields',outpostId:f.name('蓝方工厂'),enabled:false}},summary:'Synthetic order'}:{tool:'finish',arguments:{},summary:'No retry'},tokens:0};}};
    try{
      const config=f.config();config.seats[0]!.serverUrl=`http://127.0.0.1:${address.port}`;r=new AgentRuntime(config,provider,f.env);
      await r.runOne('seat0');await r.tick();await r.tick();
      assert.equal(accepted,true);assert.equal(writes,1);assert.equal(f.commandCount(),1);assert.equal(providerCalls,1);
      assert.equal(r.status()[0]!.enabled,false);assert.equal(r.status()[0]!.owned,false);assert.ok(r.status()[0]!.error);
      await r.shutdown();r=new AgentRuntime(config,provider,f.env);await r.tick();
      assert.equal(r.status()[0]!.enabled,false);assert.equal(writes,1);assert.equal(f.commandCount(),1);assert.equal(providerCalls,1);
    }finally{await r?.shutdown();proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));await f.close();}
  });
}
test('default runtime sends accepted orders and keeps memory tied to real receipts',async()=>{
  const f=await fixture();let r:AgentRuntime|undefined,calls=0;
  const provider:AgentProvider={step:async()=>{calls++;return {reply:calls===1?{tool:'order',arguments:{action:{kind:'set-shields',outpostId:f.name('蓝方工厂'),enabled:false}},summary:'Real deployment'}:{tool:'finish',arguments:{},summary:'Accepted receipt'},tokens:0};}};
  try{r=new AgentRuntime(f.config(),provider,f.env);await r.runOne('seat0');assert.equal(calls,2);assert.equal(f.commandCount(),1);assert.ok(f.requests.includes('POST /player/v2/commands'));assert.equal(r.status()[0]!.error,null);}
  finally{await r?.shutdown();await f.close();}
});

test('capacity accepts eight total instances and rejects nine before creating local state',()=>{
  assert.equal(MAX_AGENT_INSTANCES,8);
  const dir=mkdtempSync(join(tmpdir(),'agent-capacity-test-'));
  const seats:AgentSeatConfig[]=Array.from({length:9},(_,i)=>({id:`instance${i}`,serverUrl:`http://127.0.0.1:${4000+i}`,roomId:`room${i}`,lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:`TOKEN_${i}`,settings:{model:'',personality:'schemer'}}));
  const raw={storeDirectory:join(dir,'uncreated'),seats,pollMs:5000,live:true as const};
  try{
    assert.equal(parseAgentConfig({...raw,seats:seats.slice(0,8)}).seats.length,8);
    assert.throws(()=>parseAgentConfig(raw),/At most 8 AI instances/);
    assert.throws(()=>new AgentRuntime(raw,fake,{}),/At most 8 AI instances/);
    assert.equal(existsSync(raw.storeDirectory),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('eight live fake AI instances across four servers control, pause, run-one and persist independently',async()=>{
  const fixtures:Awaited<ReturnType<typeof fixture>>[]=[];let runtime:AgentRuntime|undefined;
  try{
    for(let i=0;i<4;i++)fixtures.push(await fixture());
    const env:NodeJS.ProcessEnv={},calls=new Map<string,number>();
    const seats=fixtures.flatMap((f,server)=>f.seats.map((seat,index)=>{
      const id=`server${server}-seat${index}`,tokenEnv=`INSTANCE_${server}_${index}`;
      env[tokenEnv]=f.env[`TOKEN_${index}`]!;
      return {...seat,id,tokenEnv,settings:{...seat.settings,model:id}};
    }));
    const provider:AgentProvider={step:async request=>{
      const count=(calls.get(request.model)??0)+1;calls.set(request.model,count);
      return {reply:count%2?{tool:'notebook',arguments:{memory:{strategy:`Private memory for ${request.model}`}},summary:'Synthetic isolated memory'}:{tool:'finish',arguments:{},summary:'Synthetic finish'},tokens:0};
    }};
    const config=parseAgentConfig({storeDirectory:join(fixtures[0]!.dir,'eight-private'),seats});
    runtime=new AgentRuntime(config,provider,env);
    assert.equal(runtime.status().length,8);assert.ok(runtime.status().every(s=>!s.enabled));
    await Promise.all(seats.map(s=>runtime!.start(s.id)));
    assert.ok(runtime.status().every(s=>s.enabled&&s.owned));
    const first=seats[0]!;
    await runtime.pause(first.id);
    assert.equal(runtime.status().find(s=>s.id===first.id)!.enabled,false);
    assert.ok(runtime.status().filter(s=>s.id!==first.id).every(s=>s.enabled&&s.owned));
    await runtime.runOne(first.id);
    assert.equal(runtime.status().find(s=>s.id===first.id)!.calls,0);
    assert.ok(runtime.status().filter(s=>s.id!==first.id).every(s=>s.calls===0));
    await runtime.tick();
    assert.ok(runtime.status().every(s=>s.calls===0&&!s.error));
    await Promise.all(seats.map(s=>runtime!.pause(s.id)));
    assert.ok(runtime.status().every(s=>!s.enabled&&!s.owned));
    await Promise.all(seats.map(s=>runtime!.runOne(s.id)));
    assert.ok(runtime.status().every(s=>s.calls===0&&!s.enabled&&!s.owned&&!s.error));
    assert.equal(readdirSync(config.storeDirectory).filter(p=>p.endsWith('.sqlite')).length,8);
    assert.ok(fixtures.every(f=>f.commandCount()===0),'fake memory decisions create no game orders');
    await runtime.shutdown();
    for(const seat of seats){
      const store=new AiStore(join(config.storeDirectory,agentStoreKey(seat)+'.sqlite'));
      try{const state=store.load(seat.roomId,seat.lobbySeat)!;assert.equal(state.memory.strategy,`Private memory for ${seat.id}`);assert.equal(state.calls,0);assert.equal(state.enabled,false);}
      finally{store.close();}
    }
    runtime=new AgentRuntime(config,provider,env);await runtime.tick();
    assert.ok(runtime.status().every(s=>!s.enabled&&s.calls===0));
    assert.equal([...calls.values()].reduce((sum,n)=>sum+n,0),seats.length*4);
  }finally{await runtime?.shutdown();await Promise.all(fixtures.map(f=>f.close()));}
});
test('default runtime shares seven automatic calls across seats and reserves a discussion slot',async()=>{
 const f=await fixture();let r:AgentRuntime|undefined,override:AgentRuntime|undefined;let release!:()=>void;
 const hold=new Promise<void>(resolve=>{release=resolve;});const pending:Promise<void>[]=[];let sent=0;
 try{
  r=new AgentRuntime(parseAgentConfig({storeDirectory:join(f.dir,'queue-default'),seats:[]}),fake,{});
  assert.equal(r.modelQueue.limit,8);
  for(let i=0;i<16;i++)pending.push(r.modelQueue.run(new AbortController().signal,async()=>{sent++;await hold;},{fairnessKey:String(Math.floor(i/2))}));
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(sent,7);assert.deepEqual(r.modelQueue.status,{limit:8,active:7,waiting:9});
  let discussed=false;await r.modelQueue.run(new AbortController().signal,async()=>{discussed=true;},{interactive:true});
  assert.equal(discussed,true);assert.equal(sent,7);
  release();await Promise.all(pending);assert.equal(sent,16);
  override=new AgentRuntime(parseAgentConfig({storeDirectory:join(f.dir,'queue-override'),seats:[]}),fake,{AI_MODEL_CONCURRENCY:'9'});
  assert.equal(override.modelQueue.limit,9);
 }finally{release();await Promise.allSettled(pending);await r?.shutdown();await override?.shutdown();await f.close();}
});

test('empty console runtime adds paused live seats using one real history store',async()=>{
  const f=await fixture();let r:AgentRuntime|undefined;
  try{
    r=new AgentRuntime(parseAgentConfig({storeDirectory:join(f.dir,'dynamic'),seats:[]}),fake,{});
    r.addSeat(f.seats[0]!,f.env.TOKEN_0!);
    assert.equal(r.status()[0]!.mode,'live');assert.equal(r.status()[0]!.enabled,false);
    await r.start('seat0');assert.throws(()=>r!.removeSeat('seat0'),/pause/i);assert.throws(()=>r!.configureProvider('seat0',{kind:'offline'}),/pause/i);
    await r.pause('seat0');await r.runOne('seat0');assert.equal(r.status()[0]!.calls,0);
    r.removeSeat('seat0');assert.equal(r.status().length,0);assert.equal(readdirSync(join(f.dir,'dynamic')).filter(p=>p.endsWith('.sqlite')).length,1);
    assert.throws(()=>parseAgentConfig({...f.config(),live:false}));
  }finally{await r?.shutdown();await f.close();}
});

test('dynamic capacity counts all paused instances atomically and frees capacity on removal',async()=>{
  const f=await fixture();let r:AgentRuntime|undefined;
  try{
    const directory=join(f.dir,'dynamic-cap');r=new AgentRuntime(parseAgentConfig({storeDirectory:directory,seats:[]}),fake,{});
    const configs=Array.from({length:9},(_,i)=>({...f.seats[0]!,id:`dynamic${i}`,roomId:`synthetic-room-${i}`}));
    for(const c of configs.slice(0,8))r.addSeat(c,f.env.TOKEN_0!);
    assert.throws(()=>r!.addSeat(configs[8]!,f.env.TOKEN_0!),/At most 8/);
    assert.equal(r.status().length,8);assert.equal(readdirSync(directory).filter(p=>p.endsWith('.sqlite')).length,8);
    r.removeSeat('dynamic0');r.addSeat(configs[8]!,f.env.TOKEN_0!);assert.equal(r.status().length,8);
  }finally{await r?.shutdown();await f.close();}
});
test('session provider keys are per-seat, retained only at same endpoint, cleared explicitly, and never persisted',async()=>{
  const f=await fixture();let r:AgentRuntime|undefined;const received:string[]=[],receivedModels:string[]=[],key0='synthetic-provider-secret-zero',key1='synthetic-provider-secret-one';
  const model=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));receivedModels.push(JSON.parse(Buffer.concat(chunks).toString()).model);received.push(String(req.headers.authorization));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({request:{tool:'finish',arguments:{}},summary:'Synthetic model finish'})}}]}));});
  model.listen(0,'127.0.0.1');await once(model,'listening');const address=model.address();if(!address||typeof address==='string')throw Error();const baseUrl=`http://127.0.0.1:${address.port}/v1`;
  try{
    const config=f.config();r=new ProductAgentRuntime(config,fake,f.env);
    for(const [i,key]of [key0,key1].entries())r.configureProvider(`seat${i}`,{kind:'openai-compatible',model:'synthetic-model',baseUrl,apiStyle:'chat',apiKey:key});
    r.configureProvider('seat0',{kind:'openai-compatible',model:'updated-model',baseUrl,apiStyle:'chat'});
    r.updateSettings('seat0',{...r.consoleConfig().seats[0]!.settings,model:'settings-model'});assert.equal(r.consoleConfig().seats[0]!.providerConfig.model,'settings-model');
    const before=JSON.stringify(r.consoleConfig());assert.throws(()=>r!.configureProvider('seat0',{kind:'openai-compatible',model:'model',baseUrl:baseUrl+'/other'}));assert.equal(JSON.stringify(r.consoleConfig()),before);
    await Promise.all(['seat0','seat1'].map(id=>r!.runOne(id)));assert.deepEqual(received.sort(),[`Bearer ${key0}`,`Bearer ${key1}`].sort());assert.deepEqual(receivedModels.sort(),['settings-model','synthetic-model']);
    assert.ok(r.status().every(s=>!s.error));assert.ok(!JSON.stringify(r.consoleConfig()).includes(key0));assert.ok(!JSON.stringify(r.consoleConfig()).includes(key1));
    r.configureProvider('seat0',{kind:'openai-compatible',model:'model',baseUrl,apiStyle:'chat',apiKey:''});assert.equal(r.consoleConfig().seats[0]!.providerConfig.hasKey,false);
    await r.runOne('seat0');assert.equal(received.length,2);assert.equal(r.status()[0]!.error,null);
    await r.shutdown();
    for(const file of readdirSync(config.storeDirectory)){const bytes=readFileSync(join(config.storeDirectory,file));assert.equal(bytes.includes(Buffer.from(key0)),false);assert.equal(bytes.includes(Buffer.from(key1)),false);}
  }finally{await r?.shutdown();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await f.close();}
});
test('real SeatRunner breakpoint pause settles its pending tool without sending or calling provider again',async()=>{
  const f=await fixture();let runtime:AgentRuntime|undefined,calls=0;
  const provider:AgentProvider={step:async()=>{calls++;return {reply:{tool:'order',arguments:{action:{kind:'set-shields',outpostId:f.name('蓝方工厂'),enabled:false}},summary:'Held synthetic write'},tokens:0};}};
  try{runtime=new AgentRuntime(f.config(),provider,f.env);runtime.setDebug('seat0',{breakBeforeWrite:true,ttlMs:10000});const turn=runtime.runOne('seat0');
    const until=Date.now()+2000;while(!runtime.debugStatus('seat0').pending&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
    assert.ok(runtime.debugStatus('seat0').pending);assert.equal(f.commandCount(),0);
    await runtime.pause('seat0');await turn;assert.equal(f.commandCount(),0);assert.equal(calls,1);assert.equal(runtime.status()[0]!.enabled,false);
  }finally{await runtime?.shutdown();await f.close();}
});
test('recent calls retain redacted bodies and mandatory metrics without exposing executor credentials',async()=>{
  const f=await fixture();let runtime:AgentRuntime|undefined;
  const provider:AgentProvider={step:async()=>({reply:{tool:'finish',arguments:{},summary:`Synthetic echo ${f.env.TOKEN_1!}`},tokens:0,usageKnown:{provenance:'synthetic',input:false,output:false,cached:false}})};
  try{const config=f.config();config.seats[0]!.settings.model='capture-test';runtime=new ProductAgentRuntime(config,provider,f.env);await runtime.runOne('seat0');
    const old=runtime.debugRead('seat0','calls') as {entries:{callRef:number;prompt:{available:boolean}}[]};assert.equal(old.entries[0]!.prompt.available,true);assert.throws(()=>runtime!.setDebug('seat0',{captureCalls:false}),/always enabled/);
    await runtime.runOne('seat0');
    const calls=runtime.debugRead('seat0','calls') as {entries:{callRef:number;prompt:{available:boolean};usage:{inputTokens:number|null}}[]};assert.equal(calls.entries[0]!.prompt.available,true);assert.equal(calls.entries[0]!.usage.inputTokens,null);
    const reply=runtime.debugRead('seat0','content',{ref:String(calls.entries[0]!.callRef),kind:'reply'}) as {available:boolean;text:string|null};assert.equal(reply.available,true);assert.equal(typeof reply.text,'string');assert.ok(!reply.text!.includes(f.env.TOKEN_1!));assert.ok(!JSON.stringify(calls).includes(f.env.TOKEN_1!));
  }finally{await runtime?.shutdown();await f.close();}
});


test('model discovery previews an unsaved API connection without changing provider, history or game control',async()=>{
  const f=await fixture();let runtime:AgentRuntime|undefined;const paths:string[]=[];const key='synthetic-model-preview-key';
  const model=createServer((req,res)=>{paths.push(req.url!);assert.equal(req.headers.authorization,`Bearer ${key}`);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'available-model'}]}));});
  model.listen(0,'127.0.0.1');await once(model,'listening');const address=model.address();if(!address||typeof address==='string')throw Error();
  try{
    runtime=new AgentRuntime(f.config(),fake,f.env);const before=runtime.consoleConfig();
    const result=await runtime.listProviderModels('seat0',{kind:'openai-compatible',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:key,model:'model-list'});
    assert.deepEqual(result,{models:['available-model']});assert.deepEqual(paths,['/v1/models']);
    assert.deepEqual(runtime.consoleConfig(),before);assert.equal(runtime.status()[0]!.calls,0);assert.equal(runtime.status()[0]!.owned,false);assert.equal(f.requests.length,0);
    await runtime.shutdown();
    for(const file of readdirSync(f.config().storeDirectory))assert.equal(readFileSync(join(f.config().storeDirectory,file)).includes(Buffer.from(key)),false);
  }finally{await runtime?.shutdown();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await f.close();}
});


test('fixed controller has eight permanent profiles and binds only selected authenticated players',async()=>{
 const {controllerSynchronizer}=await import('../packages/ai/src/application/controller-sync.js');
 const {saveControllerBindings,validateControllerBindings}=await import('../packages/server/src/controller-bindings.js');
 const {writeFileSync}=await import('node:fs');
 const f=await fixture();let r:AgentRuntime|undefined;
 const directory=join(f.dir,'fixed-slots'),profilesPath=join(directory,'controller-slots.json');
 try{
  const config=parseAgentConfig({storeDirectory:directory,seats:[]});r=new AgentRuntime(config,fake,{}, {fixedSlots:true,profilesPath});
  assert.equal(r.status().length,8);assert.ok(r.status().every(s=>s.bound===false));
  assert.throws(()=>r!.removeSeat('ai-01'),/cannot be deleted/);await assert.rejects(r.start('ai-01'));assert.equal(f.requests.length,0);
  r.configureSeat('ai-01',{kind:'codex',model:'saved-model'},{model:'',personality:'merchant'});
  const roomId=f.seats[0]!.roomId;
  writeFileSync(join(f.dir,'player-access.json'),JSON.stringify(f.accessFile));
  const sync=controllerSynchronizer(r,f.dir,Number(new URL(f.seats[0]!.serverUrl).port));
  await saveControllerBindings(f.dir,roomId,[{seat:0,slot:3},{seat:1,slot:0}]);await sync();
  assert.equal(r.status().filter(s=>s.bound).length,2);assert.equal(r.status().find(s=>s.id==='ai-04')!.lobbySeat,0);assert.equal(r.status().find(s=>s.id==='ai-01')!.lobbySeat,1);
  assert.equal(r.consoleConfig().seats[0]!.settings.model,'saved-model');assert.equal(r.consoleConfig().seats[0]!.settings.personality,'merchant');
  await r.runOne('ai-04');assert.equal(f.commandCount(),0);
  assert.throws(()=>validateControllerBindings([{seat:0,slot:2},{seat:1,slot:2}],2));
  await saveControllerBindings(f.dir,roomId,[]);await sync();assert.ok(r.status().every(s=>!s.bound));assert.equal(r.status().length,8);
  await r.shutdown();r=new AgentRuntime(config,fake,{}, {fixedSlots:true,profilesPath});assert.equal(r.consoleConfig().seats[0]!.settings.model,'saved-model');assert.ok(r.status().every(s=>!s.bound));
 }finally{await r?.shutdown();await f.close();}
});


test('configuration entry points leave settings and live provider unchanged when persistence fails',async t=>{
 const f=await fixture();let runtime:ProductAgentRuntime|undefined;
 try{
  runtime=new ProductAgentRuntime(f.config(),fake,f.env);
  const entry=(runtime as any).entries.get('seat0');
  const before=JSON.stringify(runtime.consoleConfig()),settings=entry.runner.state.settings,configSettings=entry.config.settings,adapter=entry.provider.current;
  const failure=Error('synthetic configuration storage failure');
  const save=t.mock.method(entry.store,'save',()=>{throw failure;});
  const provider={kind:'codex',model:'new-model'};
  for(const action of [
   ()=>runtime!.configureProvider('seat0',provider),
   ()=>runtime!.configureSeat('seat0',provider,{...settings,personality:'merchant'}),
   ()=>runtime!.updateSettings('seat0',{...settings,model:'new-model'}),
  ]){
   assert.throws(action,error=>error===failure);
   assert.equal(JSON.stringify(runtime.consoleConfig()),before);
   assert.equal(entry.runner.state.settings,settings);assert.equal(entry.config.settings,configSettings);
   assert.equal(entry.provider.current,adapter);
  }
  save.mock.restore();
  runtime.updateSettings('seat0',{...settings,model:'inherited-model'});
  assert.equal(entry.runner.state.settings.model,'inherited-model');
  assert.deepEqual(runtime.consoleConfig().seats[0]!.providerConfig,{kind:'inherited',hasKey:false});
  runtime.configureSeat('seat0',provider,{...settings,personality:'merchant'});
  assert.equal(entry.runner.state.settings.personality,'merchant');
  assert.equal(entry.runner.state.settings.model,'new-model');
  assert.equal(entry.store.load(entry.config.roomId,entry.config.lobbySeat).settings.model,'new-model');
 }finally{await runtime?.shutdown();await f.close();}
});
