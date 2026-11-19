import {AsyncLocalStorage} from 'node:async_hooks';
import {OwnerDelegation,type OwnerDelegationStore} from './owner-delegation.js';
import {errorDiagnostic} from '../../../../contracts/src/index.js';
import {manualVersion} from '../execution/manual-coordination.js';
import {ActivityFacts,type FactBaseline} from '../observation/activity-facts.js';
import {resolveWriteOutbox,type PendingWriteRequest} from '../execution/write-reconciliation.js';
import {createHash,randomUUID} from 'node:crypto';
import timers from 'node:timers/promises';
import {BatchTransportError} from '../execution/batch-outcome.js';
import {actionBasisMaterial,PLAYER_NAMES,type PlayerObservation,type ChatMessage,type PlayerNotification,type CommanderThread,type ProtocolReceipt} from '../../../../contracts/src/index.js';
import {MemoryProtocolClientStore,PlayerProtocolClient,PlayerProtocolClientError,type PlayerProtocolClientOptions,type ProtocolClientStore} from '../../../../player-sdk/src/index.js';
import {attackRoutes,compareKnownObservations,type KnownPredictionDraft} from '../../../../prediction/src/index.js';
import type {AgentSeatConfig} from '../contracts/agent-config.js';
import type {AiSnapshot,GameGateway} from '../contracts/types.js';
import {GameRequestError,GameTransportError,isReadOnlyRequest,transportFailure,type GameRequestDiagnostic} from './gateway.js';
import {WriteBreakpointGate,DebugStopError,type WriteContext} from '../execution/agent-debug.js';

const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected protocol object');return value as Record<string,unknown>;};
const safeCounter=(value:unknown)=>{if(typeof value!=='string'||! /^(0|[1-9][0-9]*)$/.test(value)||BigInt(value)>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Counter cannot be represented by the official runner');return Number(value);};
const stableKey=(kind:string,id:string)=>createHash('sha256').update(JSON.stringify([kind,id])).digest('hex');
const READ_CAPABILITIES=['observation.read/1','chat.read/1','notifications.read/1','commander.read/1','activity.read/1'];
const WRITE_CAPABILITIES=['actions.order/1','chat.send/1','commander.worker/1','readiness/1'];
/** Official-policy adapter: internal tool operation aliases resolve to negotiated v2 calls. */
export class ProtocolPlayerGateway implements GameGateway {
  private facts=new ActivityFacts();
  factBaseline(read:(current:PlayerObservation)=>FactBaseline|undefined){this.facts.baseline=read;}
  readonly client:PlayerProtocolClient;
  readonly debugGate=new WriteBreakpointGate();
  commanderVersion=0;
  commanderRefresh:((thread?:CommanderThread)=>Promise<number>)|null=null;
  acquireWaitUntil:number|null=null;
  programmaticAutoAdvance=false;
  waitingForGame=false;
  private acquireAbort:AbortController|null=null;
  private owned=false;
  private followupPending=false;
  private foregroundContext:WriteContext|null=null;
  private readonly writeContexts=new AsyncLocalStorage<WriteContext>();
  private get context(){return this.writeContexts.getStore()??this.foregroundContext;}
  private latestObservation:PlayerObservation|null=null;
  private readonly actionObservations=new Map<string,PlayerObservation>();
  private snapshotBusy:Promise<Record<string,unknown>>|null=null;
  private batchObservationBarrier:Promise<void>|null=null;
  private discussionVersion=0;
  private readinessBasis:{tick:number;instructionsVersion:number}|null=null;
  private backgroundChatCursor=0;
  /** Private scheduling key, never an authoritative readiness acknowledgement. */
  get readinessSignature(){
    const tick=this.latestObservation?.view.tick;
    return tick===undefined?null:JSON.stringify([this.client.sessionId,tick]);
  }
  async waitForChange(){
    const before=this.client.state.snapshot;
    const cut=await this.translate('/player/v2/sync',false,()=>this.client.sync(1000));
    const payload=this.client.state.snapshot;
    if(!payload||!cut.document)return null;
    const observation=this.validateObservation(payload.observation);
    const old=before?.observation as PlayerObservation|undefined;
    const background=JSON.stringify([before?.chat,before?.commander,before?.instructionsVersion])!==JSON.stringify([payload.chat,payload.commander,payload.instructionsVersion]);
    return {tick:old?.revision===observation.revision?null:observation.view.tick,background,control:!this.client.leaseActive};
  }
  private readonly fetcher:typeof fetch;
  constructor(readonly config:AgentSeatConfig,token:string,private readonly store:ProtocolClientStore&OwnerDelegationStore&{close?:()=>void}=new MemoryProtocolClientStore(),options:Pick<PlayerProtocolClientOptions,'fetch'|'onRequestTiming'>={}){
    this.fetcher=options.fetch??fetch;
    const expectedIdentity={roomId:config.roomId,get gamePlayer(){return config.gamePlayer;},lobbySeat:config.lobbySeat,...(config.lobbyConnection?{}:{chatPlayer:config.chatPlayer,chatCount:config.chatCount,...(config.roster?{roster:config.roster}:{})})};
    const delegation=config.ownerCredential?new OwnerDelegation(config,token,store,this.fetcher):undefined;
    const transportFetch:typeof fetch=async(input,init)=>{const headers=new Headers(init?.headers);headers.set('Authorization','Bearer '+await delegation!.token());return this.fetcher(input,{...init,headers});};
    this.client=new PlayerProtocolClient({serverUrl:config.serverUrl,token,store,expectedIdentity,requiredCapabilities:['core/2','state.sync/1',...READ_CAPABILITIES,...WRITE_CAPABILITIES],optionalCapabilities:['actions.batch/1','tick-times.read/1','actions.scoped-revision/1','diplomacy/2','manual-commands/1',...(config.coordinatedCheckpoints===true?['checkpoints.coordinated/1']:[])],...options,...(delegation?{fetch:transportFetch}:{})});
    this.lobbyToken=token;
  }
  private readonly lobbyToken:string;
  get batchAvailable(){return this.client.hasCapability('actions.batch/1')&&!this.debugGate.enabled;}
  async orderBatch(id:string,actions:readonly Record<string,unknown>[],revision:string){
    if(this.batchObservationBarrier)throw new GameRequestError(409,undefined,'batch-already-running');
    const previous=this.snapshotBusy;let release!:()=>void;
    this.batchObservationBarrier=new Promise<void>(resolve=>{release=resolve;});
    try{await previous;return await this.sendOrderBatch(id,actions,revision);}finally{this.batchObservationBarrier=null;release();}
  }
  private async sendOrderBatch(id:string,actions:readonly Record<string,unknown>[],revision:string){
    if(!this.writable)throw new GameRequestError(403,undefined,'agent-write-blocked');
    if(!this.batchAvailable)throw new GameRequestError(400,undefined,'batch-not-negotiated');
    if(this.context&&(this.context.signal.aborted||Date.now()>=this.context.deadline))throw new DebugStopError('expired');
    const key=stableKey('batch',id),basis=this.actionObservations.get(revision);
    const results=(parent:ProtocolReceipt|undefined)=>actions.map((_,index)=>{
      const child=parent?.effectCommitted?parent.effects?.batchReceipts?.[index]:undefined,base={id:`${id}-item-${index}`,index,tool:'order'};
      if(child?.effectCommitted)return {...base,status:'accepted',protocolReceipt:child,protocolReceiptPlayer:this.config.gamePlayer};
      if(child?.state==='rejected')return {...base,status:child.code==='BATCH_NOT_EXECUTED'?'not-executed':'rejected',error:child.code,protocolReceipt:child,protocolReceiptPlayer:this.config.gamePlayer};
      if(parent?.state==='rejected')return {...base,status:'rejected',error:parent.code};
      return {...base,status:'unknown'};
    });
    try{
      const response=await this.translate('/player/v2/commands/batch',true,()=>this.client.commandBatch({idempotencyKey:key,clientCommandId:key,expectedRevision:revision,instructionsVersion:String(this.context?.instructionsVersion??this.commanderVersion),commands:actions.map((action,index)=>{
        const childKey=stableKey('order',`${id}-item-${index}`),material=basis&&this.client.hasCapability('actions.scoped-revision/1')?actionBasisMaterial(basis,action):null;
        return {idempotencyKey:childKey,clientCommandId:childKey,expectedRevision:revision,instructionsVersion:String(this.context?.instructionsVersion??this.commanderVersion),...(material?{actionBasis:createHash('sha256').update(material).digest('hex')}:{}),payload:{action}};
      })}));
      const payload=response.snapshot,observation=this.validateObservation(payload.observation);
      const hydrated=await this.facts.hydrate(observation,(after,through)=>this.client.extensionRequest('activity.read/1',`/activity?after=${after}&through=${through}&limit=100`),this.client.hasCapability('manual-commands/1')?(after,limit)=>this.client.extensionRequest('manual-commands/1',`/manual-commands?after=${after}&limit=${limit}`):undefined);
      this.validateObservation(hydrated);const children=results(response.receipt);this.followupPending=false;
      return {observation:hydrated,results:children,requested:actions.length,processed:children.filter(r=>r.status!=='not-executed').length,complete:children.every(r=>r.status==='accepted')};
    }catch(error){
      const entry=Object.values(this.client.state.outbox).find(e=>e.request.idempotencyKey===key),parent=entry?.receipt;
      if(error instanceof GameTransportError||parent||entry&&['unknown','accepted','blocked'].includes(entry.state)){
        this.followupPending=!!parent?.effectCommitted;
        const cause=parent?.effectCommitted?this.followupFailure(error):error instanceof GameTransportError?error:new GameTransportError({requestId:'batch-response',method:'POST',path:'/player/v2/commands/batch',origin:this.config.serverUrl,timeoutMs:15000,elapsedMs:0,stage:'validate-response',failure:'invalid-response',outcome:'unknown',cause:errorDiagnostic(error,true)});
        throw new BatchTransportError(cause,{status:'unknown',complete:false,requested:actions.length,processed:parent?actions.length:0,results:results(parent??undefined)},basis??this.latestObservation!);
      }
      throw error;
    }
  }
  async lobbyPhase(){
    if(!this.config.lobbyConnection||this.latestObservation?.realtime===true)return undefined;
    const {response,value}=await this.readLobby(AbortSignal.timeout(10000));
    if(!response.ok||value.roomId!==this.config.roomId||value.player!==this.config.lobbySeat)throw Error('Invalid lobby timing identity');
    if(value.status==='waiting')return {status:'waiting' as const};
    if(value.status==='starting'){
      if(!Number.isSafeInteger(value.secondsRemaining)||Number(value.secondsRemaining)<0)throw Error('Invalid lobby countdown');
      return {status:'starting' as const,secondsRemaining:Number(value.secondsRemaining)};
    }
    return undefined;
  }
  async tickTimes(after:number){
    await this.client.connect();
    if(!this.client.hasCapability('tick-times.read/1'))return null;
    const value=object(await this.client.extensionRequest('tick-times.read/1',`/tick-times?after=${after}&limit=1000`));
    const counter=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
    if(value.roomId!==this.config.roomId||!counter(value.headTick)||typeof value.ended!=='boolean'||!counter(value.serverTimeMs)||value.headElapsedMs!==null&&(typeof value.headElapsedMs!=='number'||!Number.isFinite(value.headElapsedMs)||value.headElapsedMs<0)||!counter(value.nextCursor)||typeof value.hasMore!=='boolean'||!Array.isArray(value.records)||value.records.length>1000)throw Error('Invalid server tick timing page');
    let cursor=after;
    const records=value.records.map(item=>{
      const r=object(item);
      if(!counter(r.id)||Number(r.id)<=cursor||!counter(r.revision)||!counter(r.tick)||r.fromTick!==null&&!counter(r.fromTick)||!counter(r.wallTimeMs)||typeof r.monotonicMs!=='number'||!Number.isFinite(r.monotonicMs)||r.monotonicMs<0||typeof r.sessionId!=='string'||r.sessionId.length>128||!['observed','advance','batch'].includes(String(r.kind))||!['state-write','automatic','manual','realtime','startup','database-trigger'].includes(String(r.source)))throw Error('Invalid server tick timing record');
      cursor=Number(r.id);
      return {id:r.id,revision:r.revision,fromTick:r.fromTick,tick:r.tick,wallTimeMs:r.wallTimeMs,monotonicMs:r.monotonicMs,sessionId:r.sessionId,kind:r.kind,source:r.source} as import('../../../../contracts/src/index.js').TickTimeAnchor;
    });
    if(value.nextCursor!==cursor||value.hasMore&&cursor===after)throw Error('Invalid server tick timing cursor');
    return {roomId:value.roomId,headTick:value.headTick,ended:value.ended,serverTimeMs:value.serverTimeMs,headElapsedMs:value.headElapsedMs,records,nextCursor:value.nextCursor,hasMore:value.hasMore} as import('../../../../contracts/src/index.js').TickTimePage;
  }
  get writable(){return !this.followupPending&&this.owned&&this.client.writable;}
  set writable(value:boolean){if(value)throw Error('Use explicit protocol control acquisition');this.client.pause();}
  get sessionId(){return this.owned?this.client.sessionId:null;}
  get expiresAt(){return this.owned&&this.client.leaseActive?Date.now()+this.client.remainingLeaseMs:0;}
  close(){this.client.pause();this.store.close?.();}
  writeContext(context:WriteContext|null){this.foregroundContext=context;}
  withWriteContext<T>(context:WriteContext,run:()=>Promise<T>):Promise<T>{return this.writeContexts.run(context,run);}
  async authorityCheck(commanderVersion:number,manualBasis:number){
    // One authenticated cut supplies both authority versions. Do not cache across guards.
    const [,payload]=await Promise.all([this.checkIdentity(),this.document(true)]),thread=payload.commander as CommanderThread;
    if(!thread||thread.roomId!==this.config.roomId||thread.player!==this.config.gamePlayer||!Array.isArray(thread.messages)||!thread.directives)throw Error('Commander extension is not available for this player');
    this.discussionVersion=thread.directives.version;
    const latest=this.commanderRefresh?await this.commanderRefresh(thread):thread.directives.version;
    if(latest!==commanderVersion)throw new GameRequestError(409,undefined,'commander-replan-required');
    this.commanderVersion=commanderVersion;
    const observation=this.validateObservation(payload.observation);
    if(manualVersion(observation)!==manualBasis)throw new GameRequestError(409,observation,'manual-replan-required');
  }
  async commanderCheck(version:number){const latest=this.commanderRefresh?await this.commanderRefresh():this.discussionVersion;if(latest!==version)throw new GameRequestError(409,undefined,'commander-replan-required');this.commanderVersion=version;}
  async manualCheck(version:number){const data=object(await this.client.extensionRequest('observation.read/1','/observation')),o=this.checkedObservation(data.observation);if(manualVersion(o)!==version)throw new GameRequestError(409,o,'manual-replan-required');}
  async reconcileWrites(requests:readonly PendingWriteRequest[]){
    return this.translate('/player/v2/commands/lookup',false,async()=>{
      const entries=await this.client.reconcile({retryAbsent:false}),hello=this.client.hello;
      if(!hello)throw Error('Missing protocol scope after reconciliation');
      return requests.map(request=>resolveWriteOutbox(request,entries,this.config.roomId,hello.scope.roomEpoch,hello.scope.playerId,this.config.gamePlayer));
    });
  }
  private async translate<T>(path:string,write:boolean,run:()=>Promise<T>):Promise<T>{
    try{return await run();}catch(error){
      if(!(error instanceof PlayerProtocolClientError))throw error;
      const diagnostic:GameRequestDiagnostic={requestId:error.requestId??'local-v2',method:write?'POST':'GET',path,origin:this.config.serverUrl,timeoutMs:15000,elapsedMs:0,stage:error.status?'http-response':'connect-or-send',failure:error.code,outcome:error.outcome,...(error.status?{status:error.status}:{})};
      if(error.code==='TRANSPORT_UNCONFIRMED'&&error.outcome!=='unknown')throw new GameTransportError(diagnostic);
      if(error.outcome==='unknown'||['UNAUTHORIZED','SCOPE_DENIED','ROOM_EPOCH_CHANGED','FENCE_STALE','LEASE_LOST','UNRESOLVED_OUTBOX','IDENTITY_MISMATCH','IDENTITY_OR_EPOCH_MISMATCH'].includes(error.code)){this.client.pause();throw new GameTransportError(diagnostic);}
      throw new GameRequestError(error.status||400,undefined,error.code,undefined,diagnostic);
    }
  }
  async readIdentity(){const hello=await this.client.connect(),identity=hello.identity;Object.assign(this.config,{gamePlayer:identity.gamePlayer,chatPlayer:identity.chatPlayer,chatCount:identity.chatCount,roster:identity.roster});return identity;}
  async checkIdentity(){return this.translate('/player/v2/sessions/hello',false,async()=>{const identity=await this.readIdentity(),control=await this.client.control();this.programmaticAutoAdvance=control.programmaticAutoAdvance===true;return{protocol:'player-control/2',player:identity.gamePlayer,...identity,mode:control.mode,sessionId:control.sessionId,expiresAt:control.remainingTtlMs>0?Date.now()+control.remainingTtlMs:null};});}
  cancelAcquire(){this.acquireAbort?.abort();}
  private async readLobby(signal:AbortSignal){
    const started=Date.now(),requestSignal=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
    let response:Response,stage:GameRequestDiagnostic['stage']='connect-or-send';
    try{
      response=await this.fetcher(new URL('/lobby/v2',this.config.serverUrl),{headers:{Authorization:`Bearer ${this.lobbyToken}`,Accept:'application/json'},redirect:'error',signal:requestSignal});
      stage='read-response';
      return {response,value:object(await response.json())};
    }catch(error){
      if(signal.aborted)throw error;
      const cause=errorDiagnostic(error,true);
      throw new GameTransportError({requestId:'local-v2-lobby',method:'GET',path:'/lobby/v2',origin:this.config.serverUrl,timeoutMs:15000,elapsedMs:Date.now()-started,stage,
        failure:requestSignal.aborted?'timeout':stage==='read-response'&&!(error instanceof TypeError)?'invalid-response':transportFailure(cause,false),outcome:'read-only',cause});
    }
  }
  private async waitForLobby(signal:AbortSignal){
    if(!this.config.lobbyConnection)return;
    for(;;){
      signal.throwIfAborted();
      const {response,value}=await this.readLobby(signal);
      if(!response.ok||value.roomId!==this.config.roomId||value.player!==this.config.lobbySeat||!Array.isArray(value.occupied)||value.occupied[this.config.lobbySeat]!==true||value.status==='cancelled')throw new GameRequestError(response.status||503,undefined,'lobby-membership-invalid');
      if(value.status==='waiting'){
        this.waitingForGame=true;await timers.setTimeout(500,undefined,{signal});continue;
      }
      if(!Number.isSafeInteger(value.gameSeat)||value.gameSeat===null)throw new GameRequestError(409,undefined,'lobby-seat-unavailable');
      this.config.gamePlayer=value.gameSeat as number;this.waitingForGame=false;return;
    }
  }
  async acquire(){
    const abort=new AbortController();this.acquireAbort=abort;
    try{
      // Gathering players is a normal, unbounded wait. Only individual reads
      // and the subsequent fenced lease acquisition have transport deadlines.
      await this.waitForLobby(abort.signal);abort.signal.throwIfAborted();
      const timeout=AbortSignal.timeout(35000),signal=AbortSignal.any([abort.signal,timeout]),started=Date.now();
      try{await this.translate('/player/v2/control/acquire',true,async()=>{
        await this.checkIdentity();let control=await this.client.control(),initial=control;
        if(control.mode==='agent')this.acquireWaitUntil=Date.now()+control.remainingTtlMs;
        while(control.mode==='agent'){
          signal.throwIfAborted();if(control.generation!==initial.generation||control.sessionId!==initial.sessionId||control.expiresAt!==initial.expiresAt)throw Error('CONTROL_LEASE_RENEWED: another executor is active; no takeover attempted');
          await timers.setTimeout(Math.min(500,Math.max(25,control.remainingTtlMs+25)),undefined,{signal});control=await this.client.control();
        }
        signal.throwIfAborted();await this.client.acquire();this.owned=true;await this.document(true);
        if(signal.aborted){await this.release();signal.throwIfAborted();}
      });}catch(error){
        if(timeout.aborted&&!abort.signal.aborted&&!(error instanceof GameRequestError)&&!(error instanceof GameTransportError))throw new GameTransportError({requestId:'local-v2-control-wait',method:'GET',path:'/player/v2/control',origin:this.config.serverUrl,timeoutMs:35000,elapsedMs:Date.now()-started,stage:'read-response',failure:'timeout',outcome:'read-only',cause:errorDiagnostic(error,true)});
        throw error;
      }
    }finally{this.acquireAbort=null;this.acquireWaitUntil=null;this.waitingForGame=false;}
  }
  async renew(){await this.translate('/player/v2/control/renew',true,()=>this.client.renew());}
  async release(){this.client.pause();try{await this.translate('/player/v2/control/release',true,()=>this.client.release());}finally{this.owned=false;}}
  private checkedObservation(raw:unknown):PlayerObservation {
    const o=raw as PlayerObservation;if(!o||o.roomId!==this.config.roomId||o.view?.player!==this.config.gamePlayer||typeof o.revision!=='string')throw new GameTransportError();return o;
  }
  private validateObservation(raw:unknown):PlayerObservation {
    const observation=this.checkedObservation(raw);this.latestObservation=observation;if(!this.actionObservations.has(observation.revision))this.actionObservations.set(observation.revision,structuredClone(observation));while(this.actionObservations.size>32)this.actionObservations.delete(this.actionObservations.keys().next().value!);return observation;
  }
  private hydrateObservation(raw:unknown){return this.facts.hydrate(this.checkedObservation(raw),(after,through)=>this.client.extensionRequest('activity.read/1',`/activity?after=${after}&through=${through}&limit=100`),this.client.hasCapability('manual-commands/1')?(after,limit)=>this.client.extensionRequest('manual-commands/1',`/manual-commands?after=${after}&limit=${limit}`):undefined);}
  private async backgroundObservation(){const data=object(await this.client.extensionRequest('observation.read/1','/observation'));return this.hydrateObservation(data.observation);}
  private async readCollection<T>(kind:'chat'|'notifications',cursor:number){
    if(!Number.isSafeInteger(cursor)||cursor<0)throw Error('Invalid private cursor');
    const page=object(await this.client.extensionRequest(kind==='chat'?'chat.read/1':'notifications.read/1',`/${kind}?after=${cursor}&limit=100`)),rows=page[kind==='chat'?'messages':'notifications'],next=safeCounter(page.nextCursor);
    if(!Array.isArray(rows)||next!==cursor+rows.length||typeof page.hasMore!=='boolean')throw Error('Invalid collection page');
    if(kind==='chat')this.backgroundChatCursor=Math.max(this.backgroundChatCursor,next);
    return {rows:rows as T[],cursor:next,hasMore:page.hasMore};
  }
  private async document(refresh=false){
    if(this.batchObservationBarrier)await this.batchObservationBarrier;
    // Normal decisions use the locally installed authorized cut. Only bootstrap,
    // explicit execution guards and accepted-write recovery synchronize here.
    if(refresh||this.followupPending||!this.client.state.snapshot||this.client.state.needsSnapshot){
      if(!this.snapshotBusy)this.snapshotBusy=this.client.sync(0,true).then(()=>{
        const payload=this.client.state.snapshot;if(!payload)throw Error('Live synchronization did not install a document');return payload;
      }).finally(()=>{this.snapshotBusy=null;});
      await this.snapshotBusy;
    }
    const payload=this.client.state.snapshot;if(!payload)throw Error('Missing synchronized document');
    this.validateObservation(payload.observation);safeCounter(payload.instructionsVersion);return payload;
  }
  private async collection<T>(kind:'chat'|'notifications',cursor:number,payload:Record<string,unknown>):Promise<{rows:T[];cursor:number;hasMore:boolean}>{
    const tail=object(payload[kind]),upper=safeCounter(tail.cursor),start=safeCounter(tail.fromExclusive),name=kind==='chat'?'messages':'notifications';
    if(!Number.isSafeInteger(cursor)||cursor<0)throw Error('Invalid private cursor');
    if(cursor>upper){
      // The background lane may have consumed an authenticated newer prefix.
      // This fixed foreground cut has nothing further to deliver. Return its
      // own boundary, never relabel the old cut or rewind the shared consumer.
      if(kind==='chat'&&cursor<=this.backgroundChatCursor)return {rows:[],cursor:upper,hasMore:false};
      throw Error('Private message cursor is outside this room epoch');
    }
    let rows:T[],next:number;
    if(cursor>=start){if(!Array.isArray(tail[name]))throw Error('Invalid snapshot collection');rows=(tail[name] as T[]).slice(cursor-start,cursor-start+100);next=cursor+rows.length;}
    else{const limit=Math.min(100,upper-cursor),page=object(await this.client.extensionRequest(kind==='chat'?'chat.read/1':'notifications.read/1',`/${kind}?after=${cursor}&limit=${limit}`));if(!Array.isArray(page[name]))throw Error('Invalid collection page');rows=(page[name] as T[]).slice(0,limit);next=safeCounter(page.nextCursor);if(next!==cursor+rows.length||next>upper)throw Error('Collection moved beyond installed snapshot cut');}
    return {rows,cursor:next,hasMore:next<upper};
  }
  async snapshot(chatCursor:number,notificationCursor:number,backgroundOnly=false):Promise<AiSnapshot>{return this.translate('/player/v2/snapshot',false,async()=>{
    const payload=backgroundOnly?null:await this.document();
    const [observation,chat,notifications]=await Promise.all([
      payload?this.hydrateObservation(payload.observation):this.backgroundObservation(),
      payload?this.collection<ChatMessage>('chat',chatCursor,payload):this.readCollection<ChatMessage>('chat',chatCursor),
      backgroundOnly?Promise.resolve({rows:[] as PlayerNotification[],cursor:notificationCursor,hasMore:false}):this.collection<PlayerNotification>('notifications',notificationCursor,payload!),
    ]);
    if(!backgroundOnly){this.validateObservation(observation);this.readinessBasis=chat.hasMore||notifications.hasMore?null:{tick:observation.view.tick,instructionsVersion:safeCounter(payload!.instructionsVersion)};this.followupPending=false;}
    return {observation,chat:chat.rows,notifications:notifications.rows,chatCursor:chat.cursor,notificationCursor:notifications.cursor,hasMore:chat.hasMore||notifications.hasMore,chatPlayer:this.config.chatPlayer,chatCount:this.config.chatCount,roster:(this.config.roster??this.client.hello!.identity.roster).map(r=>({...r,displayName:PLAYER_NAMES[r.chatPlayer]??`玩家 ${r.chatPlayer+1}`}))};
  }).catch(error=>{if(!backgroundOnly&&this.followupPending)throw this.followupFailure(error);throw error;});}
  async forecastBatch(observation:PlayerObservation,scenarios:{id:string;targetTick:number;drafts:unknown[]}[]){return compareKnownObservations(observation,scenarios.map(s=>({...s,drafts:s.drafts as KnownPredictionDraft[]})));}
  async readActivity(after:number,through:number){return this.translate('/player/v2/activity',false,()=>this.client.extensionRequest('activity.read/1',`/activity?after=${after}&through=${through}&limit=100`));}
  async attackRoutes(observation:PlayerObservation,windows?:{attackTicks:number;localTicks:number;holdTicks:number}){return attackRoutes(observation,windows);}
  async resumeBreakpoint(id:string){await this.debugGate.resume(id,async context=>{if(!this.writable)throw new DebugStopError('control-lost');const control=await this.client.control();if(control.sessionId!==this.client.sessionId)throw new DebugStopError('control-lost');const observation=this.validateObservation((await this.document(true)).observation);if(observation.revision!==context.revision)throw new DebugStopError('stale');});}
  private async accepted(receipt:ProtocolReceipt):Promise<void>{
    if(receipt.state==='accepted')throw new PlayerProtocolClientError('COMMAND_PENDING','unknown');
    if(receipt.state==='rejected'){
      const fresh=['REVISION_CONFLICT','DISPATCH_SOURCE_LOCKED'].includes(receipt.code??'')?this.validateObservation((await this.document(true)).observation):undefined;
      throw new GameRequestError(['REVISION_CONFLICT','INSTRUCTIONS_CHANGED','DISPATCH_SOURCE_LOCKED'].includes(receipt.code??'')?409:400,fresh,receipt.code??'command-rejected');
    }
    if(!receipt.effectCommitted)throw new PlayerProtocolClientError('COMMAND_EFFECT_UNCONFIRMED','unknown');
  }
  private followupFailure(error:unknown){return new GameTransportError({requestId:'durable-v2-receipt',method:'POST',path:'/player/v2/commands',origin:this.config.serverUrl,timeoutMs:15000,elapsedMs:0,stage:'validate-response',failure:'accepted-write-followup-failed',outcome:'unknown',cause:errorDiagnostic(error,true)});}
  private async afterMutationObservation(){try{return this.validateObservation(await this.hydrateObservation((await this.document(true)).observation));}catch(error){this.followupPending=true;throw this.followupFailure(error);}}
  private async mutation(kind:'order'|'chat-send'|'readiness',id:string,revision:string,payload:Record<string,unknown>,instructionsVersion=this.context?.instructionsVersion??this.commanderVersion){
    const basis=this.actionObservations.get(revision),material=kind==='order'&&basis&&this.client.hasCapability('actions.scoped-revision/1')?actionBasisMaterial(basis,payload.action as Record<string,unknown>):null;
    const key=stableKey(kind,id),receipt=await this.client.command({kind,idempotencyKey:key,clientCommandId:key,expectedRevision:revision,...(material?{actionBasis:createHash('sha256').update(material).digest('hex')}:{}),instructionsVersion:String(instructionsVersion),payload});await this.accepted(receipt);return receipt;
  }
  async request(path:string,data?:unknown):Promise<unknown>{
    if(!/^\/tool\/[a-z-]+(?:\/[a-z-]+)*(?:\?[^#]*)?$/.test(path))throw Error('Only supported player tool paths are allowed');
    const pathname=path.split('?')[0]!,write=!isReadOnlyRequest(data===undefined?'GET':'POST',pathname);
    return this.translate('/player/v2'+pathname.slice(5),write,async()=>{
      if(pathname==='/tool/observation'&&data===undefined)return this.validateObservation(await this.hydrateObservation((await this.document(true)).observation));
      if(pathname==='/tool/manual-commands'&&data===undefined)return {...object(await this.client.extensionRequest('manual-commands/1',path.slice(5))),roomId:this.config.roomId};
      if(pathname==='/tool/control'&&data===undefined)return this.checkIdentity();
      if(pathname==='/tool/chat/search'&&data===undefined){const result=object(await this.client.extensionRequest('chat.read/1',path.slice(5)));return{...result,roomId:this.config.roomId,...(typeof result.nextCursor==='string'?{nextCursor:safeCounter(result.nextCursor)}:{}),...(typeof result.nextBefore==='string'?{nextBefore:safeCounter(result.nextBefore)}:{})};}
      if(data===undefined)throw new GameRequestError(400,undefined,'unsupported-v2-tool');
      const body=object(structuredClone(data));
      if(!write){
        throw new GameRequestError(404,undefined,'remote-calculation-removed');
      }
      if(!this.writable)throw new GameRequestError(403,undefined,'agent-write-blocked');
      if(this.debugGate.enabled){const context=this.context&&typeof body.revision==='string'?{...this.context,revision:body.revision}:this.context;await this.debugGate.beforeWrite(path,body,context);if(!context||context.signal.aborted||Date.now()>=context.deadline||!this.writable)throw new DebugStopError('expired');}
      let revision=typeof body.revision==='string'?body.revision:this.context?.revision??this.latestObservation?.revision;
      if(!revision&&pathname==='/tool/control/ready'&&body.ready===false)revision=this.validateObservation((await this.document()).observation).revision;
      if(!revision)throw Error('Mutation has no original observation basis');
      if(pathname==='/tool/order'){
        const order=object(body.order);if(typeof order.id!=='string')throw Error('Order requires stable client identity');
        const protocolReceipt=await this.mutation('order',order.id,revision,{action:order.action});return {...await this.afterMutationObservation(),protocolReceipt,protocolReceiptPlayer:this.config.gamePlayer};
      }
      if(pathname==='/tool/chat'){
        if(typeof body.id!=='string')throw Error('Message requires stable client identity');
        const receipt=await this.mutation('chat-send',body.id,revision,{id:body.id,to:body.to,text:body.text});
        return {roomId:this.config.roomId,accepted:true,status:'sent',requestId:body.id,receipt,
          message:{...(typeof receipt.effects?.messageId==='string'?{id:receipt.effects.messageId}:{}),from:this.config.chatPlayer,to:body.to,text:body.text,acceptedAtUtc:receipt.updatedAt}};
      }
      if(pathname==='/tool/control/ready'){
        // Completion closes this tick; later facts remain inputs for the next one.
        // It grants no authority to submit gameplay under an old revision.
        const basis=this.readinessBasis;
        const ready=body.ready===true&&!!basis;
        const receipt=await this.mutation('readiness',randomUUID(),revision,{ready,...(ready?{tick:body.tick??basis!.tick}:{})},basis?.instructionsVersion??this.commanderVersion);return{roomId:this.config.roomId,ready,receipt};
      }
      throw new GameRequestError(400,undefined,'unsupported-v2-tool');
    });
  }
  /** Discussion has its own scoped durable mutation lane and never acquires gameplay control. */
  readonly discussionTransport={request:async(path:string,data?:unknown):Promise<unknown>=>this.translate('/player/v2/commander',data!==undefined,async()=>{
    if(path==='/tool/observation'&&data===undefined)return this.backgroundObservation();
    if(path!=='/tool/commander/worker')throw Error('Unsupported v2 discussion operation');
    if(data!==undefined){const payload=object(data),identity=payload.op==='reply'?String(payload.messageId):payload.op==='ack'?String(payload.version):String(payload.id),key=stableKey('commander-'+String(payload.op),identity);const receipt=await this.client.workerCommand({idempotencyKey:key,clientCommandId:key,instructionsVersion:String(this.discussionVersion),payload});await this.accepted(receipt);}
    const payload=object(await this.client.extensionRequest('commander.read/1','/commander')),thread=payload.thread as CommanderThread;
    if(!thread||thread.roomId!==this.config.roomId||thread.player!==this.config.gamePlayer||!Array.isArray(thread.messages)||!thread.directives)throw Error('Commander extension is not available for this player');
    this.discussionVersion=thread.directives.version;return thread;
  })};
}
