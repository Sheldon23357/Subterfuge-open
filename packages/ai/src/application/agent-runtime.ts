import {createSeatModelHost,createDiscussionModelHost} from './model-host.js';
import {RuntimeCheckpoints} from './runtime-checkpoints.js';
import {compactModelCall} from '../controller/storage/diagnostic-retention.js';
import type {ConsoleService} from './console-service.js';
import {BotModeRegistry} from '../controller/contracts/mode-registry.js';
import type {BotModeResolver} from '../controller/contracts/bot-mode.js';
import {resumeSeatState} from '../controller/runtime/seat-lifecycle.js';
import {toolNamesWhere} from '../controller/contracts/tool-metadata.js';
import {ProviderError} from '../controller/contracts/provider-error.js';
import {ProtocolCheckpointParticipant} from '../controller/transport/protocol-checkpoint.js';
import {ModelAdmissionStale,ModelCallQueue} from '../controller/runtime/model-queue.js';
import {CommanderWorker} from '../controller/runtime/commander-worker.js';
import {notebookContextMemory} from '../controller/diagnostics/notebook-context.js';
import {AgentDiagnostics} from '../controller/diagnostics/agent-diagnostics.js';
import {errorDiagnostic,PLAYER_NAMES} from '../../../contracts/src/index.js';
import {createDiagnosticRedactor} from './agent-redactor.js';
import {DebugStopError} from '../controller/execution/agent-debug.js';
import {randomUUID} from 'node:crypto';
import {mkdirSync,openSync,closeSync,unlinkSync,chmodSync,writeFileSync,readFileSync,existsSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {AiStore} from '../controller/storage/store.js';
import {SeatRunner} from './seat-runner.js';
import {ProtocolPlayerGateway} from '../controller/transport/protocol-gateway.js';
import {SqliteProtocolClientStore} from '../controller/transport/protocol-store.js';
import {GameRequestError,GameTransportError} from '../controller/transport/gateway.js';
import {initialState,validateSettings,type AgentProvider} from '../controller/contracts/types.js';
import {createSessionProvider,listSessionProviderModels,type SessionProvider} from './agent-provider.js';
import {MAX_AGENT_INSTANCES,parseAgentConfig,type AgentRuntimeConfig,type AgentSeatConfig} from '../controller/contracts/agent-config.js';

import {agentStoreKey,type RuntimeEntry as Entry} from './runtime-entry.js';
export {agentStoreKey} from './runtime-entry.js';
export class AgentRuntime implements ConsoleService {
  private readonly checkpoints=new RuntimeCheckpoints({entries:()=>[...this.entries.values()],entry:id=>this.entry(id),profile:id=>this.profile(id),closing:()=>this.closing,storeDirectory:()=>this.config.storeDirectory,profilesPath:()=>this.profilesPath,halt:(entry,error,operation)=>this.halt(entry,error,operation)});
  private get checkpointLocked(){return this.checkpoints?.locked??false;}
  private get checkpointSettled(){return this.checkpoints?.settled??false;}
  get checkpointActive(){return this.checkpoints?.checkpointActive??[...this.entries.values()].some(e=>!!e.checkpoint?.checkpointId);}
  private assertCheckpointIdle(){if(this.checkpointActive)throw Error('联动存档进行中，请稍后操作');}
  private beginCheckpointDrain(entries:Entry[]){this.checkpoints.beginCheckpointDrain(entries);}
  private freezeCheckpointEntry(entry:Entry){return this.checkpoints.freezeCheckpointEntry(entry);}
  private resumeCheckpointEntry(entry:Entry){return this.checkpoints.resumeCheckpointEntry(entry);}
  prepareCheckpoint(...args:Parameters<RuntimeCheckpoints['prepareCheckpoint']>){return this.checkpoints.prepareCheckpoint(...args);}
  releaseCheckpoint(){return this.checkpoints.releaseCheckpoint();}
  private entries=new Map<string,Entry>();
  readonly fixedController:boolean;
  private profiles=new Map<string,{settings:import('../controller/contracts/types.js').AiSettings;provider:SessionProvider;slot:number}>();
  private profilesPath:string|undefined;
  private profile(id:string){const p=this.profiles.get(id);if(!p)throw Error('Unknown controller slot');return p;}
  private saveProfiles(){
    if(!this.profilesPath)return;
    const slots=[...this.profiles].map(([id,p])=>{const {hasKey,keySource,...provider}=p.provider.summary;return {id,slot:p.slot,settings:p.settings,provider};});
    writeFileSync(this.profilesPath+'.tmp',JSON.stringify({format:'controller-slots/1',slots}),{mode:0o600});renameSync(this.profilesPath+'.tmp',this.profilesPath);
  }
  async unbindControllerSlot(slot:number){
    this.assertCheckpointIdle();
    const id=`ai-${String(slot+1).padStart(2,'0')}`;this.profile(id);const e=this.entries.get(id);if(!e)return;
    await this.pause(id);await e.checkpoint?.close();await e.commander.close();if(e.gateway instanceof ProtocolPlayerGateway)e.gateway.close();e.store.close();unlinkSync(e.lock);this.entries.delete(id);this.config.seats=this.config.seats.filter(c=>c.id!==id);
  }
  async bindControllerSlot(slot:number,config:AgentSeatConfig,token:string){
    this.assertCheckpointIdle();
    if(!this.fixedController)throw Error('Controller slots unavailable');
    const id=`ai-${String(slot+1).padStart(2,'0')}`,p=this.profile(id),old=this.entries.get(id);
    if(old&&old.config.serverUrl===config.serverUrl&&old.config.roomId===config.roomId&&old.config.lobbySeat===config.lobbySeat&&old.token===token&&old.config.ownerCredential===config.ownerCredential)return;
    await this.unbindControllerSlot(slot);
    this.addSeat({...config,id,settings:p.settings},token);
  }
  private secrets=new Set<string>();
  private redact=createDiagnosticRedactor(()=>[...this.secrets]);
  private rememberSecret(secret:string|undefined){if(!secret)return;if(!this.secrets.has(secret)&&this.secrets.size>=1024)throw Error('Session credential limit reached');this.secrets.add(secret);}
  private timer:ReturnType<typeof setInterval>|null=null;
  private checkpointTimer:ReturnType<typeof setInterval>|null=null;
  /** Independent of gameplay tick, which deliberately stops during remote freeze. */
  async pollCheckpoints(){if(this.closing||this.closed||this.checkpointLocked)return;await Promise.all([...this.entries.values()].map(e=>e.checkpoint?.poll()));}
  private closed=false;
  private closing=false;
  private shutdownTask:Promise<void>|null=null;
  readonly config:AgentRuntimeConfig;
  readonly modelQueue:ModelCallQueue;
  private readonly resolveMode:BotModeResolver;
  private readonly modes:BotModeRegistry;
  private checkedSettings(raw:unknown,restoring=false){const settings=validateSettings(raw);if(!restoring)this.modes.assertAvailable(settings.mode??'hybrid');this.modes.validate(settings);return settings;}
  constructor(config:AgentRuntimeConfig,provider:AgentProvider,env:NodeJS.ProcessEnv=process.env,options:{fixedSlots?:boolean;profilesPath?:string;resolveMode?:BotModeResolver;modes?:BotModeRegistry}={}){
    this.modes=options.modes??new BotModeRegistry();
    this.resolveMode=options.resolveMode??this.modes.resolver();
    // Four automatic calls shared across all seats, plus one discussion slot.
    // A seat's two background tasks do not each reserve global capacity.
    const concurrency=env.AI_MODEL_CONCURRENCY===undefined?8:Number(env.AI_MODEL_CONCURRENCY);
    this.modelQueue=new ModelCallQueue(concurrency,concurrency>1?1:0);
    this.fixedController=options.fixedSlots===true;this.profilesPath=options.profilesPath;
    this.config=parseAgentConfig(config);
    if(this.fixedController){
      mkdirSync(resolve(this.config.storeDirectory),{recursive:true,mode:0o700});
      let saved:{slots:{id:string;slot:number;settings:unknown;provider:unknown}[]}|undefined;
      if(this.profilesPath&&existsSync(this.profilesPath)){const value=JSON.parse(readFileSync(this.profilesPath,'utf8'));if(value.format!=='controller-slots/1'||!Array.isArray(value.slots)||value.slots.length!==MAX_AGENT_INSTANCES)throw Error('Invalid controller profiles');saved=value;}
      for(let slot=0;slot<MAX_AGENT_INSTANCES;slot++){
        const id=`ai-${String(slot+1).padStart(2,'0')}`,stored=saved?.slots[slot];
        if(stored&&(stored.id!==id||stored.slot!==slot))throw Error('Invalid controller slot');
        const settings=this.checkedSettings(stored?.settings??{model:'',personality:'schemer'},true);
        const raw=(stored?.provider??{kind:'offline'}) as Record<string,unknown>;
        let provider:SessionProvider;try{provider=createSessionProvider(raw,undefined,env);}catch{provider=createSessionProvider({...raw,apiKey:''},undefined,env);}
        this.profiles.set(id,{slot,settings,provider});this.rememberSecret(provider.key);
      }
      this.saveProfiles();
    }
    for(const key of ['OPENAI_API_KEY','AI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY'])this.rememberSecret(env[key]);
    try{for(const c of this.config.seats){
      const token=env[c.tokenEnv];if(!token)throw Error(`Missing token environment variable for seat ${c.id}`);
      this.entries.set(c.id,this.createEntry(c,token,c.settings.provider==='offline'||!this.modes.validate(c.settings).capabilities.model?createSessionProvider({kind:'offline'}):{current:provider,summary:{kind:'inherited',hasKey:false}}));
    }}catch(error){for(const e of this.entries.values()){if(e.gateway instanceof ProtocolPlayerGateway)e.gateway.close();e.store.close();unlinkSync(e.lock);}throw error;}
  }
  async validatePluginConnection(id:string){
    if(!this.entries.has(id)){
      if(!this.fixedController||!this.profiles.has(id))throw Error('Unknown seat');
      return [{name:'游戏连接',passed:true,message:'未绑定游戏，连接检查待绑定后执行。'}];
    }
    const e=this.entry(id);this.assertPaused(e);
    try{const identity=await e.gateway.checkIdentity();
      if(identity.roomId!==e.config.roomId||identity.gamePlayer!==e.config.gamePlayer)throw Error('Game identity changed');
      return [{name:'游戏连接与席位身份',passed:true,message:'已通过玩家协议核对；未获取控制权或下达游戏指令。'}];
    }catch(error){return [{name:'游戏连接与席位身份',passed:false,message:error instanceof Error?error.message:'Connection check failed'}];}
  }
  browserIdentity(id:string){
    const e=this.entry(id);
    if(e.config.ownerCredential!==true)throw Error('Only an owner connection can open the player page');
    return {serverUrl:new URL(e.config.serverUrl).origin,roomId:e.config.roomId,playerToken:e.token,...(e.config.roomCode?{code:e.config.roomCode}:{})};
  }
  async tickTimes(id:string,after:number){const gateway=this.entry(id).gateway;const [times,lobby]=await Promise.all([gateway.tickTimes(after),gateway.lobbyPhase()]);return times?{...times,...(lobby?{lobby}:{})}:null;}
  private createEntry(c:AgentSeatConfig,token:string,provider:SessionProvider):Entry {
    this.rememberSecret(token);this.rememberSecret(provider.key);
    const directory=resolve(this.config.storeDirectory);mkdirSync(directory,{recursive:true,mode:0o700});
    const base=join(directory,agentStoreKey(c)),lock=base+'.lock';
    const fd=openSync(lock,'wx',0o600);closeSync(fd);let store:AiStore|undefined,transport:SqliteProtocolClientStore|undefined;
    try{
      writeFileSync(lock,JSON.stringify({pid:process.pid,seat:c.id,createdAt:new Date().toISOString()}));
      store=new AiStore(base+'.sqlite');chmodSync(base+'.sqlite',0o600);
      const binding={serverUrl:c.serverUrl,roomId:c.roomId,lobbySeat:c.lobbySeat,gamePlayer:c.gamePlayer,chatPlayer:c.chatPlayer,live:true};
      const old=store.latest(c.roomId,c.lobbySeat,'agent-binding');
      if(old&&JSON.stringify(old)!==JSON.stringify(binding)){const previous=old as typeof binding;if(!c.lobbyConnection||previous.serverUrl!==binding.serverUrl||previous.roomId!==binding.roomId||previous.lobbySeat!==binding.lobbySeat||previous.chatPlayer!==binding.chatPlayer)throw Error('Private store identity mismatch');}
      const state=store.load(c.roomId,c.lobbySeat)??initialState(c.roomId,c.lobbySeat,c.settings);
      state.settings=c.settings;state.enabled=false;if(state.status!=='ended')state.status='paused';
      store.save(state,'agent-binding',binding);
      const diagnostics=new AgentDiagnostics(store,state,this.redact,observation=>{
        const mode=this.resolveMode(state.settings,state);
        return mode.diagnostics?.({observation,latest:<T>(name:string)=>store!.latest<T>(state.roomId,state.lobbySeat,mode.recordPrefix+'-'+name)??undefined})??{};
      },observation=>notebookContextMemory(store!,state.roomId,state.lobbySeat,observation,gateway.client.state.snapshot,store!.latest(state.roomId,state.lobbySeat,this.resolveMode(state.settings,state).recordPrefix+'-local-plan'))),capture={enabled:true};
      let checkpoint:ProtocolCheckpointParticipant|null=null,entry:Entry,wasRunning=false,interrupted=false;
      const decisionAdmission=async(request:Parameters<AgentProvider['step']>[0],modelCall:boolean)=>{
        const guard=()=>{if(checkpoint?.blocked){interrupted=true;if(modelCall)state.calls=Math.max(0,state.calls-1);runner.pause();store!.save(state,'checkpoint-model-not-sent',{lane:'decision',sent:false});throw new ProviderError('cancelled',undefined,{stage:'checkpoint-admission',outcome:'not-sent'});}};
        await checkpoint?.poll();guard();await request.beforeSend?.();guard();
      };
      const discussionAdmission=async(request:Parameters<AgentProvider['step']>[0])=>{const guard=()=>{if(checkpoint?.blocked)throw new ModelAdmissionStale('coordinated-checkpoint');};await checkpoint?.poll();guard();await request.beforeSend?.();guard();};
      const gateway=new ProtocolPlayerGateway(c,token,transport=new SqliteProtocolClientStore(base+'.sqlite'),{onRequestTiming:timing=>{
        if(!this.checkpointSettled&&!checkpoint?.blocked)store!.recordTiming(state.roomId,state.lobbySeat,'protocol-request-timing',{...timing,sequence:state.sequence});
      }}),runner=new SeatRunner(state,store,gateway,createSeatModelHost({queue:this.modelQueue,session:provider,sessionKey:agentStoreKey(c),fairnessKey:c.id,diagnostics,admit:decisionAdmission}),this.config.pollMs,{mechanicalKeepalive:c.mechanicalKeepalive===true&&c.roomMaintenancePolicy?.roomId===c.roomId&&c.roomMaintenancePolicy.allowMechanicalKeepalive===true,canMaintain:()=>!this.checkpointLocked&&!checkpoint?.blocked&&!this.closing&&gateway.writable&&!!gateway.sessionId&&Date.now()<gateway.expiresAt},this.resolveMode);
      const discussionGateway=gateway.discussionTransport;
      const commander=new CommanderWorker({promptCharacterLimit:()=>this.resolveMode(state.settings,state).commanderContextLimit??240000,reconciliationReceipt:()=>this.resolveMode(state.settings,state).commanderReconciliationReceipt??'具体行动会在正常决策中按新指示复核，文字整理不代表已执行。',buildPrompt:input=>{const mode=this.resolveMode(state.settings,state);return mode.commanderPrompt?.({...input,latest:<T>(name:string)=>store!.latest<T>(state.roomId,state.lobbySeat,mode.recordPrefix+'-'+name)??undefined});},diagnostics,state,get expectedPlayer(){return c.gamePlayer;},roster:()=>{if(!c.roster)throw Error('Missing authenticated player roster');return c.roster.map(r=>{const displayName=PLAYER_NAMES[r.chatPlayer];if(!displayName)throw Error('Missing public player name');return {...r,displayName};});},validateIdentity:()=>gateway.readIdentity(),store,transport:discussionGateway,provider:(_callId,onQueueWait)=>createDiscussionModelHost({queue:this.modelQueue,session:provider,sessionKey:agentStoreKey(c),fairnessKey:c.id,admit:discussionAdmission,onQueueWait}),available:()=>provider.summary.kind!=='offline'&&this.resolveMode(state.settings,state).supportsCommander,onDirectives:()=>runner.requestMemoryReview(),redact:text=>String(this.redact(text))});
      gateway.commanderRefresh=async thread=>{return (await commander.refresh(thread)).directives.version;};
      entry={checkpoint:null,commander,diagnostics,capture,token,provider,config:c,store,runner,gateway,lock,desired:false,active:null,starting:null,renewing:null,stopping:null,error:null};
      if(c.coordinatedCheckpoints===true&&gateway instanceof ProtocolPlayerGateway){
        checkpoint=new ProtocolCheckpointParticipant(gateway.client,transport!,directory,base+'.sqlite',{
          beginDrain:()=>{wasRunning=entry.desired&&state.enabled&&state.status!=='ended';interrupted=false;this.beginCheckpointDrain([entry]);gateway.cancelAcquire();},
          idle:()=>!entry.active&&!entry.starting&&!entry.stopping&&!entry.renewing&&!entry.backgroundObservation&&!commander.busy&&!runner.settling,
          unresolved:()=>store!.latest<{status:string}>(c.roomId,c.lobbySeat,'provider-dispatch-commander')?.status==='pending',
          freeze:()=>this.freezeCheckpointEntry(entry),
          resume:async()=>{try{
            if(wasRunning&&entry.desired&&(state.enabled||interrupted)&&state.status!=='ended'&&state.status!=='error'){
              await this.resumeCheckpointEntry(entry);
              if(interrupted){resumeSeatState(state,null);store!.save(state,'checkpoint-resumed');}
            }
          }catch(error){this.halt(entry,error,'checkpoint-control-acquire');throw error;}finally{commander.releaseCheckpoint();wasRunning=false;interrupted=false;}},
          fail:error=>{commander.releaseCheckpoint();this.halt(entry,error,'checkpoint-recovery');},
        });entry.checkpoint=checkpoint;
      }
      return entry;
    }catch(error){transport?.close();store?.close();unlinkSync(lock);throw error;}
  }
  private assertPaused(e:Entry){
    this.assertCheckpointIdle();
    if(e.checkpoint?.busy||e.checkpoint?.checkpointId)throw Error('Wait for checkpoint coordination before changing configuration');
    if(e.desired||e.active||e.starting||e.stopping||e.renewing||e.runner.settling||e.runner.state.enabled||e.gateway.sessionId)throw Error('Fully pause seat before changing configuration');
  }
  private checkStrategyChange(e:Entry,settings:import('../controller/contracts/types.js').AiSettings){
    const mode=this.modes.validate(settings).capabilities;
    if(!mode.commander&&e.runner.state.commanderDirectives?.text.trim())throw Error('当前模式不支持已确认指挥官指令');
    if(e.runner.state.settings.mode===settings.mode&&JSON.stringify(e.runner.state.settings.strategyConfig)===JSON.stringify(settings.strategyConfig))return;
    if(e.commander.busy)throw Error('Wait for the private discussion before changing strategy');
    const receipts=e.store.latest<import('../controller/execution/receipt-observation.js').ReceiptObservationState>(e.config.roomId,e.config.lobbySeat,'receipt-observation-state');
    if(Object.values(e.gateway.client.state.outbox).some(entry=>entry.state!=='settled')||receipts?.pendingWrites.length||e.store.pendingCommanderCleanup(e.config.roomId,e.config.lobbySeat)||e.store.latest<{status:string}>(e.config.roomId,e.config.lobbySeat,'provider-dispatch-commander')?.status==='pending')throw Error('Resolve pending writes before changing strategy');
  }
  addSeat(config:AgentSeatConfig,token:string){
    this.assertCheckpointIdle();
    if(this.closed||this.closing)throw Error('Runtime is closed');
    if(typeof token!=='string'||!token.trim()||token.length>8192||/[\r\n\0]/.test(token))throw Error('Invalid player token');
    if(JSON.stringify(config).includes(token))throw Error('Player token cannot appear in configuration fields');
    const checked=parseAgentConfig({...this.config,seats:[...this.entries.values()].map(e=>e.config).concat(config)});
    const c=checked.seats[checked.seats.length-1]!;
    const entry=this.createEntry(c,token,this.fixedController?this.profile(c.id).provider:createSessionProvider({kind:'offline'}));
    this.entries.set(c.id,entry);this.config.seats=checked.seats;if(this.timer&&entry.checkpoint)this.serve();
    return this.consoleConfig().seats.find(s=>s.id===c.id)!;
  }
  removeSeat(id:string){
    this.assertCheckpointIdle();
    if(this.fixedController)throw Error('Fixed controller slots cannot be deleted');
    const e=this.entry(id);this.assertPaused(e);if(e.commander.busy)throw Error("Wait for the private discussion before removing this seat");void e.checkpoint?.close();void e.commander.close();if(e.gateway instanceof ProtocolPlayerGateway)e.gateway.close();e.store.close();unlinkSync(e.lock);
    this.entries.delete(id);this.config.seats=this.config.seats.filter(s=>s.id!==id);
  }
  configureProvider(id:string,raw:unknown){
    if(this.fixedController)return this.configureSeat(id,raw,this.profile(id).settings).providerConfig;
    const e=this.entry(id);this.assertPaused(e);
    const next=createSessionProvider(raw,e.provider);this.rememberSecret(next.key);
    const settings=this.checkedSettings({...e.runner.state.settings,model:next.summary.model??'',provider:next.summary.kind});
    if(!this.modes.validate(settings).capabilities.commander&&e.runner.state.commanderDirectives?.text.trim())throw Error('当前 bot 模式无法执行现有自由文本指令，请先处理指挥官指令再切换');
    this.commitConfiguration(e,settings,e.provider,next);
    return {...next.summary};
  }
  configureSeat(id:string,providerConfig:unknown,rawSettings:unknown){
    this.assertCheckpointIdle();
    if(this.closed||this.closing)throw Error('Runtime is closed');
    const e=this.entries.get(id);if(e)this.assertPaused(e);else if(!this.fixedController)throw Error('Unknown seat');
    const profile=this.fixedController?this.profile(id):undefined;
    const current=e?.provider??profile!.provider;
    const requested=this.checkedSettings(rawSettings);
    const next=providerConfig===undefined?current:createSessionProvider(providerConfig,current);
    const settings=this.checkedSettings({...requested,model:next.summary.model??requested.model,...(next.summary.kind==='inherited'?{}:{provider:next.summary.kind})});
    if(!this.modes.validate(settings).capabilities.commander&&e?.runner.state.commanderDirectives?.text.trim())throw Error('当前模式不支持已确认指挥官指令');
    this.rememberSecret(next.key);
    this.commitConfiguration(e,settings,current,next,profile);
    return {settings:{...settings},providerConfig:{...next.summary}};
  }
  /** Commit safe settings before changing the live adapter. Entry points retain
   * their distinct provider/model input rules; persistence and application are shared. */
  private commitConfiguration(e:Entry|undefined,settings:Entry['runner']['state']['settings'],current:SessionProvider,next:SessionProvider,profile?:ReturnType<AgentRuntime['profile']>){
    if(e){
      this.checkStrategyChange(e,settings);
      const changed=e.runner.state.settings.mode!==settings.mode||JSON.stringify(e.runner.state.settings.strategyConfig)!==JSON.stringify(settings.strategyConfig);
      e.store.save({...e.runner.state,settings},'agent-settings');
      e.runner.state.settings=settings;e.config.settings=settings;
      if(changed)e.runner.resetStrategy();
    }
    current.current=next.current;current.summary=next.summary;
    if(next.key!==undefined)current.key=next.key;else delete current.key;
    if(profile){profile.settings=settings;profile.provider=current;this.saveProfiles();}
  }
  private entry(id:string,allowClosing=false){if(this.closed||this.closing&&!allowClosing)throw Error('Runtime is closed');const e=this.entries.get(id);if(!e)throw Error('Unknown configured seat');return e;}
  debugStatus(id:string){const e=this.entry(id),status={...e.gateway.debugGate.status(),captureCalls:e.capture.enabled};return this.redact(status) as typeof status;}
  debugRead(id:string,section:string,query:Record<string,string>={}){return this.entry(id).diagnostics.read(section,query);}
  clearDiagnostics(id:string){
    this.assertCheckpointIdle();
    const e=this.entry(id);e.store.clearDiagnosticCalls(e.config.roomId,e.config.lobbySeat);
    e.runner.state.calls=0;e.runner.state.tokens=0;e.store.save(e.runner.state,'diagnostics-cleared');
    return {cleared:true,calls:e.runner.state.calls,tokens:e.runner.state.tokens};
  }
  setDebug(id:string,raw:unknown){
    const e=this.entry(id);this.assertPaused(e);
    const c=raw as {breakBeforeWrite?:boolean;captureCalls?:boolean;ttlMs?:number};
    if(c?.captureCalls===false)throw Error('Context recording is always enabled');
    if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['breakBeforeWrite','captureCalls','ttlMs'].includes(k))||Object.keys(c).length===0||c.breakBeforeWrite!==undefined&&typeof c.breakBeforeWrite!=='boolean'||c.captureCalls!==undefined&&typeof c.captureCalls!=='boolean'||c.ttlMs!==undefined&&(!Number.isSafeInteger(c.ttlMs)||c.ttlMs<100||c.ttlMs>120000))throw Error('Invalid debug options');
    if(c.breakBeforeWrite!==undefined)e.gateway.debugGate.enabled=c.breakBeforeWrite;if(c.ttlMs!==undefined)e.gateway.debugGate.ttlMs=c.ttlMs;e.capture.enabled=c.captureCalls??e.capture.enabled;return this.debugStatus(id);
  }
  async resumeDebug(id:string,breakpointId:string){
    this.assertCheckpointIdle();
    const e=this.entry(id);
    try{await e.gateway.resumeBreakpoint(breakpointId);return {status:'released'};}
    catch(error){if(error instanceof DebugStopError){await e.active;return {status:'replan-required',reason:error.reason};}throw error;}
  }
  async discardDebug(id:string,breakpointId:string){this.assertCheckpointIdle();const e=this.entry(id);e.gateway.debugGate.discard(breakpointId);await e.active;return {status:'not-sent'};}
  status(){const bound=[...this.entries.values()].map(e=>({id:e.config.id,model:e.provider.summary.kind==='offline'?'自主决策':e.provider.summary.model||e.runner.state.settings.model||'未选择模型',telemetry:this.redact({...e.runner.telemetry,foreground:e.foregroundOperation==='readiness'?'readiness':e.runner.running?(e.runner.telemetry.phase==='tool'?'execution':e.runner.telemetry.phase==='local'?'search':e.runner.telemetry.phase==='model'?'model':'planning-sync'):e.active||e.eventObservation?'observation':'idle'}) as typeof e.runner.telemetry,diagnosticGeneration:e.diagnostics.generation,serverUrl:e.config.serverUrl,protocol:'v2',roomId:e.config.roomId,lobbySeat:e.config.lobbySeat,mode:'live',status:e.runner.state.status,enabled:e.runner.state.enabled,busy:!!e.active,starting:!!e.starting,waitingForGame:e.gateway.waitingForGame,waitingForLeaseUntil:e.gateway.acquireWaitUntil,stopping:!!e.stopping,owned:e.gateway.writable&&Date.now()<e.gateway.expiresAt,...(e.checkpoint?{checkpoint:{blocked:e.checkpoint.blocked,id:e.checkpoint.checkpointId,error:e.checkpoint.error}}:{}),gamePlayer:e.config.gamePlayer,chatPlayer:e.config.chatPlayer,calls:e.runner.state.calls,tokens:e.runner.state.tokens,error:e.error??(e.runner.state.error?(e.runner.recovering?'Retry scheduled; control retained while waiting.':'Runner stopped; inspect private logs before explicit resume.'):null),...(this.fixedController?{controllerSlot:this.profile(e.config.id).slot,bound:true}:{})}));if(!this.fixedController)return bound;return [...this.profiles].map(([id,p])=>bound.find(s=>s.id===id)??{id,serverUrl:'',roomId:'',lobbySeat:p.slot,controllerSlot:p.slot,bound:false,mode:'live',status:'paused',enabled:false,busy:false,starting:false,stopping:false,owned:false,gamePlayer:p.slot,chatPlayer:p.slot,calls:0,tokens:0,error:null});}
  /** Browser-safe projection: no token variable names or filesystem paths. */
  consoleConfig(){const seats=[...this.entries.values()].map(({config:c,runner,provider})=>({id:c.id,serverUrl:new URL(c.serverUrl).origin,protocol:'v2',coordinatedCheckpoints:c.coordinatedCheckpoints===true,roomId:c.roomId,lobbySeat:c.lobbySeat,gamePlayer:c.gamePlayer,chatPlayer:c.chatPlayer,settings:{...runner.state.settings},mode:'live',providerConfig:{...provider.summary},...(this.fixedController?{controllerSlot:this.profile(c.id).slot,bound:true}:{})}));return {strategies:this.modes.list(),seats:this.fixedController?[...this.profiles].map(([id,p])=>seats.find(s=>s.id===id)??{id,serverUrl:'',roomId:'',lobbySeat:p.slot,gamePlayer:p.slot,chatPlayer:p.slot,controllerSlot:p.slot,bound:false,settings:{...p.settings},mode:'live',providerConfig:{...p.provider.summary}}):seats};}

  updateSettings(id:string,raw:unknown){
    if(this.fixedController)return this.configureSeat(id,undefined,raw).settings;
    const e=this.entry(id);this.assertPaused(e);
    const settings=this.checkedSettings(raw),kind=e.provider.summary.kind;
    if(kind!=='inherited'&&settings.provider!==undefined&&settings.provider!==kind)throw Error('Use provider configuration to change the adapter');
    if(e.provider.key&&settings.model.includes(e.provider.key))throw Error('Invalid model');
    if(kind!=='inherited')settings.provider=kind;
    const next=kind==='inherited'?e.provider:{...e.provider,summary:{...e.provider.summary,model:settings.model}};
    this.commitConfiguration(e,settings,e.provider,next);
    return {...settings};
  }
  async listProviderModels(id:string,config?:unknown){
    const e=this.entries.get(id),provider=e?.provider??this.profile(id).provider;
    if(config===undefined)return listSessionProviderModels(provider);
    if(e)this.assertPaused(e);
    const preview=createSessionProvider(config,provider);this.rememberSecret(preview.key);
    return listSessionProviderModels(preview);
  }
  /** Journal pages export bounded summaries; retained bodies use the detail API. */
  consoleLogs(id:string,before?:number){
    const e=this.entry(id),page=e.store.historyPage(e.config.roomId,e.config.lobbySeat,before);
    const modeEvent=(name:string)=>this.resolveMode(e.runner.state.settings,e.runner.state).recordPrefix+'-'+name;
    const allowed=new Set(['agent-started','agent-settings','started','completed','paused','error','runtime-error','usage','call-reserved','call-completed','call-failed','tool-intent','tool-result','tool-rejected','tool-unknown','observation-error','query-progress','write-reconciled','batch-recovered',modeEvent('model-call'),modeEvent('task-dispatched'),modeEvent('task-failed'),modeEvent('task-skipped'),modeEvent('usage')]);
    const tools=new Set(toolNamesWhere(()=>true));
    const actions=new Set(['launch','cancel-launch','return-fleet','toggle-mine','set-shields','check-in','cancel-inactivity-warning']);
    return {entries:page.entries.filter(x=>allowed.has(x.kind)).map(x=>{
      if(x.kind===modeEvent('model-call')){
        const event=compactModelCall(x.payload) as Record<string,unknown>,details:Record<string,unknown>={};
        for(const key of ['callId','callPhase','completion','sequence','task','kind','attempt','status','model','effort','timeoutMs','basis','queuedAt','sentAt','finishedAt','queueWaitMs','durationMs','providerDurationMs','prompt','responseSchema','output','tokens','usage','usageKnown','providerContext','sent','bodyRetention','promptCharacters','promptHash','responseSchemaHash','modelReturned','summary'])details[key]=event[key]??null;
        return {id:x.id,kind:x.kind,payload:this.redact(details) as Record<string,unknown>};
      }
      const payload:Record<string,number|string>={};
      if(x.payload&&typeof x.payload==='object')for(const key of ['sequence','tokens','durationMs','roundElapsedMs','nextReview','attempt','queueWaitMs','providerDurationMs','timeoutMs']){
        const value=(x.payload as Record<string,unknown>)[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0)payload[key]=value;
      }
      if(x.payload&&typeof x.payload==='object'){
        const event=x.payload as Record<string,unknown>;
        if(x.kind===modeEvent('task-failed')){
          if(['queue','provider','validation'].includes(String(event.stage)))payload.stage=String(event.stage);
          if(['timeout','transient','invalid-response','authentication','quota','unavailable','native-tool','cancelled','unknown'].includes(String(event.code)))payload.code=String(event.code);
          if(['provider-call','round-deadline'].includes(String(event.timeoutSource)))payload.timeoutSource=String(event.timeoutSource);
          const diagnostic=event.diagnostic as {httpStatus?:unknown}|undefined;
          if(typeof diagnostic?.httpStatus==='number'&&Number.isInteger(diagnostic.httpStatus)&&diagnostic.httpStatus>=100&&diagnostic.httpStatus<=599)payload.httpStatus=diagnostic.httpStatus;
        }
        if(x.kind==='runtime-error')for(const key of ['at','operation'])if(typeof event[key]==='string')payload[key]=String(event[key]).slice(0,100);
        const p=x.payload as {tool?:unknown;arguments?:{action?:{kind?:unknown}};diagnostic?:{request?:{status?:unknown};provider?:{httpStatus?:unknown}}};
        if(typeof p.tool==='string'&&tools.has(p.tool))payload.tool=p.tool;
        if(['tool-intent','tool-result','tool-rejected','tool-unknown'].includes(x.kind))payload.outcome=x.kind==='tool-intent'?'intent':x.kind==='tool-result'?'result':x.kind==='tool-unknown'?'unknown':'rejected';
        if(['write-reconciled','batch-recovered','query-progress'].includes(x.kind)){
          const result=event.result&&typeof event.result==='object'?event.result as Record<string,unknown>:{};
          const status=x.kind==='write-reconciled'?event.status:result.status;
          if(typeof status==='string'&&['committed','rejected','not-executed','unknown','accepted','partial','pending','budget-exhausted','interrupted'].includes(status))payload.outcome=status;
          for(const key of ['requested','processed'])if(typeof result[key]==='number'&&Number.isSafeInteger(result[key])&&Number(result[key])>=0)payload[key]=Number(result[key]);
        }
        const action=p.arguments?.action?.kind;
        if(typeof action==='string'&&actions.has(action))payload.action=action;
        const status=p.diagnostic?.request?.status??p.diagnostic?.provider?.httpStatus;
        if(typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599)payload.httpStatus=status;
      }
      return {id:x.id,kind:x.kind,payload};
    }),nextCursor:page.nextCursor};
  }
  private recordRuntimeError(e:Entry,error:unknown,operation:string){
    let record:unknown;
    try{record=this.redact({at:new Date().toISOString(),operation,sequence:e.runner.state.sequence,reason:e.error??e.runner.state.error,
      diagnostic:{phase:'runtime',cause:errorDiagnostic(error,true),...(error instanceof GameRequestError?{status:error.status,...(error.code?{code:error.code}:{})}:{}),...((error instanceof GameTransportError||error instanceof GameRequestError)&&error.diagnostic?{request:error.diagnostic}:{})}});}
    catch{record={at:new Date().toISOString(),operation,diagnostic:{phase:'runtime',cause:{name:'DiagnosticUnavailable'}}};}
    let persistence:unknown;
    try{e.store.save(e.runner.state,'runtime-error',record);}catch(error){persistence=this.redact(errorDiagnostic(error,true));}
    // stderr remains a fallback when the private SQLite store itself is unavailable.
    try{console.error(JSON.stringify({kind:'agent-runtime-error',seat:e.config.id,roomId:e.config.roomId,event:record,...(persistence?{persistenceError:persistence}:{})}));}catch{}
  }
  private halt(e:Entry,error?:unknown,operation='runtime'){
    // Lease rejection invalidates the old writer, not the user's run intent.
    // start() must reacquire through identity checks and outbox reconciliation;
    // it never takes over an executor that is still renewing its own lease.
    const authorityFailure=error instanceof GameTransportError?error.diagnostic?.failure:error instanceof GameRequestError?error.code:undefined;
    const retry=e.desired&&!this.closing&&!operation.startsWith('checkpoint-')&&(
      authorityFailure==='FENCE_STALE'||
      error instanceof GameTransportError&&['TRANSPORT_UNCONFIRMED','timeout','connection-reset','connection-refused','connection','dns','accepted-write-followup-failed','UNRESOLVED_OUTBOX','COMMAND_PENDING'].includes(error.diagnostic?.failure??'')||
      error instanceof GameRequestError&&([408,429,500,502,503,504].includes(error.status)||error.code==='TRANSPORT_UNCONFIRMED'||operation.startsWith('control-')&&['CONTROL_RESPONSE_OBSOLETE','CONTROL_OPERATION_PENDING','LEASE_NOT_OWNED'].includes(error.code??'')));
    if(e.recoveryTimer){clearTimeout(e.recoveryTimer);delete e.recoveryTimer;}
    e.gateway.cancelAcquire();e.gateway.debugGate.cancel('paused');e.desired=false;e.gateway.writable=false;
    if(error!==undefined){
      const reason=error instanceof GameTransportError||error instanceof GameRequestError?error.displayReason:errorDiagnostic(error).message??'运行器异常';
      const summary=this.redact(`AI ${operation} 失败：${reason}；已停止，请检查运行时事件后恢复。`) as string;
      e.error=summary;e.runner.state.error=summary;
    }
    try{e.runner.pause();}catch(pauseError){this.recordRuntimeError(e,pauseError,'pause-save');}
    if(retry){
      const delay=Math.min(300000,15000*2**Math.min(e.recoveryAttempts??0,5));e.recoveryAttempts=(e.recoveryAttempts??0)+1;
      e.desired=true;e.runner.state.enabled=true;e.runner.state.status='error';e.error=`连接暂时中断，${delay/1000}秒后自动重连并查账；未确认操作不会重复提交。`;e.runner.state.error=e.error;
      const resume=()=>{if(this.closing||!e.desired)return;if(this.checkpointActive){e.recoveryTimer=setTimeout(resume,1000);return;}delete e.recoveryTimer;e.desired=false;void this.start(e.config.id).catch(()=>{});};
      e.recoveryTimer=setTimeout(resume,delay);e.recoveryTimer.unref();
    }
    if(error!==undefined)this.recordRuntimeError(e,error,operation);
  }
  async start(id:string){
    const settings=this.entries.get(id)?.runner.state.settings??this.profiles.get(id)?.settings;
    if(settings)this.modes.assertAvailable(settings.mode??'hybrid');
    if(this.checkpointLocked)this.assertCheckpointIdle();
    const e=this.entry(id);if(e.checkpoint){await e.checkpoint.poll();if(e.checkpoint.blocked)throw Error('Coordinated checkpoint or recovery is active');}this.assertCheckpointIdle();if(e.stopping)throw Error('Seat is stopping');if(e.starting)return e.starting;if(e.desired)return;if(e.runner.state.status==='ended')throw Error('Seat has ended');
    const resumeNeedsReview=e.runner.state.status==='error'||e.runner.state.error!==null||e.runner.state.nextReview===0;
    e.desired=true;e.error=null;delete e.reportedReadiness;delete e.completedTick;
    e.starting=(async()=>{try{
      await e.gateway.acquire();
      if(e.config.lobbyConnection)e.store.save(e.runner.state,'agent-binding',{serverUrl:e.config.serverUrl,roomId:e.config.roomId,lobbySeat:e.config.lobbySeat,gamePlayer:e.config.gamePlayer,chatPlayer:e.config.chatPlayer,live:true});
      if(!e.desired){await e.gateway.release();return;}
      resumeSeatState(e.runner.state,resumeNeedsReview?0:null);e.recoveryAttempts=0;e.store.save(e.runner.state,'agent-started');
    }catch(error){if(e.desired){this.halt(e,error,'control-acquire');throw error;}this.halt(e);}finally{e.starting=null;}})();
    return e.starting;
  }
  private async poll(e:Entry,force=false,eventCoalesceMs?:number,eventWake=false){
    if(this.checkpointLocked||e.checkpoint?.blocked||!e.desired||e.starting||e.recoveryTimer)return;
    if(eventWake)e.protocolWakeRevision=(e.protocolWakeRevision??0)+1;
    if(e.active){
      if(eventWake&&e.runner.running&&!e.eventObservation){
        e.eventObservation=e.runner.poll(Date.now(),false,true,{observeOnly:true}).catch(error=>{if(e.desired)this.halt(e,error,'event-observation');}).finally(()=>{delete e.eventObservation;});
        await e.eventObservation;
      }
      return;
    }
    if(e.eventObservation)return;
    const protocolRevision=e.protocolWakeRevision??0;
    const protocolChanged=protocolRevision!==(e.observedProtocolWakeRevision??0);
    const backgroundRevision=e.runner.backgroundWakeRevision??0;
    const backgroundChanged=backgroundRevision!==(e.observedBackgroundRevision??0);
    const signature=e.gateway.readinessSignature;
    const readinessPending=this.fixedController&&(!signature||e.reportedReadiness!==signature);
    if(!force&&!protocolChanged&&!readinessPending&&e.watching&&e.completedTick===e.runner.telemetry.tick&&e.runner.state.status==='waiting'&&!e.runner.hasUnresolvedWrites)return;
    // Ready seats wait for protocol events or a newly published local result.
    // Unsettled/coalescing/recovering work retains its normal scheduling.
    if(!force&&!protocolChanged&&!backgroundChanged&&!readinessPending&&e.watching&&!e.runner.hasUnresolvedWrites&&e.runner.advanceReadiness())return;
    let operation='readiness-clear';
    e.foregroundOperation='observation';
    e.active=(async()=>{try{
      operation='observation-poll';
      await e.runner.poll(Date.now(),force,protocolChanged||backgroundChanged||readinessPending,{
        ...(eventCoalesceMs===undefined?{}:{eventCoalesceMs}),oneRoundPerTick:true,
        // Automatic admission cannot reopen a closed tick. Only an explicit run
        // revokes readiness; a previous tick's ready assignment is already stale.
        ...(force?{beforeDecision:async()=>{e.foregroundOperation='readiness';operation='readiness-clear';delete e.reportedReadiness;if(this.fixedController&&e.gateway.writable)await this.reportReadiness(e,{ready:false},'readiness-clear');e.foregroundOperation='observation';operation='observation-poll';}}:{}),
      });
      // A publication during this poll remains pending for the following poll.
      e.observedBackgroundRevision=backgroundRevision;
      // A protocol wake arriving during observation, execution or readiness
      // reporting must survive until a subsequent poll, even if it saw us busy.
      e.observedProtocolWakeRevision=protocolRevision;
      // A concurrent pause or reconnect owns the lifecycle; this old poll only drains.
      if(!e.desired||e.recoveryTimer)return;
      operation='control-release';
      if(e.runner.state.status==='error'&&!e.runner.recovering){
        const failure=e.store.latest<{diagnostic?:{request?:import('../controller/transport/gateway.js').GameRequestDiagnostic}}>(e.config.roomId,e.config.lobbySeat,'error');
        const request=failure?.diagnostic?.request;
        this.halt(e,request?new GameTransportError(request):undefined,'runner');
        if(!e.recoveryTimer)e.error='Runner failed; inspect private logs before explicit resume.';
        await e.gateway.release();
      }
      if(e.runner.state.status==='ended'){e.desired=false;await e.gateway.release();}
      e.foregroundOperation='readiness';operation='readiness-report';
      if(this.fixedController&&e.desired&&e.gateway.writable){const basis=e.runner.advanceReadiness(),signature=e.gateway.readinessSignature;if(basis&&(!signature||e.reportedReadiness!==signature)){e.runner.closeForeground(basis.tick);const result=await this.reportReadiness(e,{ready:true,...basis},'readiness-report') as {ready?:boolean}|undefined;if(signature&&result?.ready===true){e.reportedReadiness=signature;e.completedTick=basis.tick;}}}
    }catch(error){if(e.desired)this.halt(e,error,operation);}finally{delete e.foregroundOperation;e.active=null;}})();
    return e.active;
  }
  private pollBackground(e:Entry){
    if(!e.desired||e.starting||e.recoveryTimer||e.backgroundObservation||this.checkpointLocked||e.checkpoint?.blocked)return;
    const signature=JSON.stringify([e.backgroundEventRevision??0,e.runner.backgroundWakeRevision,e.runner.telemetry.tick]);
    if(e.backgroundReadSignature===signature&&!e.runner.backgroundPending)return;
    e.backgroundReadSignature=signature;
    e.backgroundObservation=e.runner.pollBackground().catch(error=>{
      // A failed discussion/diplomacy read is not a foreground game failure.
      this.recordRuntimeError(e,error,'background-observation');
    }).finally(()=>{delete e.backgroundObservation;});
  }
  private watch(e:Entry){
    if(e.watching||!e.desired||!e.gateway.writable||this.closing||this.checkpointLocked)return;
    e.watching=(async()=>{
      while(e.desired&&!this.closing&&!this.checkpointLocked&&!e.checkpoint?.blocked){
        const changed=await e.gateway.waitForChange();
        if(changed&&e.desired&&!this.closing){
          if(changed.background){e.backgroundEventRevision=(e.backgroundEventRevision??0)+1;this.pollBackground(e);}
          const foreground=changed.control||changed.tick!==null&&changed.tick>=(e.runner.telemetry.tick??-1)+1;
          // Keep synchronization alive while foreground work runs.
          if(foreground)void this.poll(e,false,this.resolveMode(e.config.settings,e.runner.state).automaticEventCoalesceMs,foreground).catch(error=>{if(e.desired)this.halt(e,error,'event-observation');});
        }
      }
    })().catch(error=>{if(e.desired&&!this.closing){
      // A truncated read does not revoke an unexpired lease or the fixed
      // foreground input. The ordinary timer restarts this single sync lane.
      if(error instanceof GameTransportError&&error.diagnostic?.outcome==='read-only'&&error.diagnostic.failure==='TRANSPORT_UNCONFIRMED')this.recordRuntimeError(e,error,'event-wait');
      else this.halt(e,error,'event-wait');
    }}).finally(()=>{delete e.watching;});
  }
  private async reportReadiness(e:Entry,body:{ready:boolean;tick?:number;revision?:string;chatCursor?:number},operation:'readiness-clear'|'readiness-report'){
    // Readiness is an idempotent lease assignment, so retry only transport failures with unknown outcomes.
    const startedAt=Date.now(),endTiming=e.runner.startReadinessTiming(body.ready);
    try{
    const retryableFailures=new Set(['timeout','connection-reset','connection-refused','connection','dns']);
    const delays=[250,500,1000];
    for(let attempt=0;;attempt++){
      try{return await e.gateway.request('/tool/control/ready',body);}
      catch(error){
        // A peer can change decision inputs between the snapshot and admission.
        // The rejected assignment acknowledged nothing: poll the new inputs
        // normally rather than stopping the seat or relabelling the old basis.
        if(error instanceof GameRequestError&&['REVISION_CONFLICT','INSTRUCTIONS_CHANGED'].includes(error.code??'')){
          delete e.reportedReadiness;
          e.store.save(e.runner.state,'readiness-stale',{operation,code:error.code});return;
        }
        const failure=error instanceof GameTransportError?error.diagnostic?.failure:null;
        if(attempt>=delays.length||!failure||!retryableFailures.has(failure)||!e.desired||!e.gateway.writable)throw error;
        const delayMs=delays[attempt]!;
        e.store.save(e.runner.state,'readiness-retry',{operation,attempt:attempt+1,delayMs,failure});
        await new Promise(resolve=>setTimeout(resolve,delayMs));
        if(!e.desired||!e.gateway.writable)throw error;
      }
    }
    }finally{endTiming();e.store.recordTiming(e.runner.state.roomId,e.runner.state.lobbySeat,'runtime-readiness-timing',{startedAt,durationMs:Date.now()-startedAt,operation,tick:e.runner.telemetry.tick});}
  }
  async tick(){
    if(this.checkpointSettled)return;
    const entries=[...this.entries.values()];
    await Promise.all(entries.map(async e=>{
      if(e.checkpoint?.blocked)return;
      if(!this.checkpointLocked)e.commander.tick();
      if(!e.desired||e.starting||e.recoveryTimer)return;
      if(e.gateway.expiresAt-Date.now()<20000&&!e.renewing){
        e.renewing=e.gateway.renew().catch(error=>{if(e.desired)this.halt(e,error,'control-renew');}).finally(()=>{e.renewing=null;});
      }
      // An unexpired lease remains usable while its renewal is in flight. An
      // expired seat waits for its own renewal, without gating other seats.
      if(e.renewing&&e.gateway.expiresAt<=Date.now())await e.renewing;
      if(!e.desired||e.recoveryTimer)return;
      if(this.timer)this.watch(e);
      this.pollBackground(e);
      await this.poll(e,false,this.resolveMode(e.config.settings,e.runner.state).automaticEventCoalesceMs);
    }));
  }
  /** Timer also renews leases while a model turn is running. */
  serve(){if(this.closed||this.closing)throw Error('Runtime is closed');if(!this.timer)this.timer=setInterval(()=>{void this.tick();},Math.min(this.config.pollMs,5000));if(!this.checkpointTimer&&[...this.entries.values()].some(e=>e.checkpoint)){void this.pollCheckpoints();this.checkpointTimer=setInterval(()=>{void this.pollCheckpoints();},500);}}
  async pause(id:string){
    if(!this.closing&&this.checkpointLocked)throw Error('联动存档进行中，请稍后操作');
    const e=this.entry(id,true);if(e.stopping)return e.stopping;this.halt(e);
    e.stopping=(async()=>{
      await e.starting?.catch(()=>{});await e.renewing;
      e.gateway.writable=false;
      try{await e.gateway.release();}catch(error){e.error='Lease release unconfirmed; local writes stopped. Wait for expiry or use manual takeover.';e.runner.state.error=e.error;this.recordRuntimeError(e,error,'control-release');}
      await e.active;await e.watching;await e.eventObservation;await e.backgroundObservation;e.runner.pause();await e.runner.drainBackground();
    })().finally(()=>{e.stopping=null;});
    return e.stopping;
  }
  async runOne(id:string){const e=this.entry(id);if(e.desired||e.active)throw Error('Pause seat before run-one');await this.start(id);this.serve();try{await this.poll(e,true);}finally{await this.pause(id);}}
  async shutdown(){if(this.shutdownTask)return this.shutdownTask;if(this.closed)return;this.closing=true;if(this.timer){clearInterval(this.timer);this.timer=null;}if(this.checkpointTimer){clearInterval(this.checkpointTimer);this.checkpointTimer=null;}this.shutdownTask=(async()=>{await Promise.all([...this.entries.values()].map(e=>e.checkpoint?.close()));await Promise.all([...this.entries.keys()].map(id=>this.pause(id)));await Promise.all([...this.entries.values()].map(e=>e.commander.close()));for(const e of this.entries.values()){if(e.gateway instanceof ProtocolPlayerGateway)e.gateway.close();e.store.close();unlinkSync(e.lock);}this.closed=true;})();return this.shutdownTask;}
}
