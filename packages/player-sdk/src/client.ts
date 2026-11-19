import {parseManualCommandView,parseManualCommandReceiptPage} from './manual-commands.js';
import {createHash,randomUUID} from 'node:crypto';
import {
  PLAYER_PROTOCOL_LIMITS,PLAYER_PROTOCOL_VERSION,canonicalProtocolJson,compareProtocolCounters,
  parseProtocolCommand,parseProtocolCommander,parseProtocolCheckpointAcknowledgement,parseStrictProtocolJson,protocolCommandIntent,protocolCounter,protocolIdentifier,protocolInteger,protocolObject,protocolString,
  type ProtocolCheckpointAcknowledgement,type ProtocolCommandRequest,type ProtocolCommanderRequest,type ProtocolMutationRequest,type ProtocolControlOperationReceipt,type ProtocolErrorBody,type ProtocolEvent,type ProtocolEventPage,
  type ProtocolSync,type ProtocolHelloResponse,type ProtocolLease,type ProtocolLookup,type ProtocolReceipt,type ProtocolScope,type ProtocolSnapshotPage,
} from '../../contracts/src/protocol-index.js';
import {parseCheckpointStatus,checkpointAckMatches,type ProtocolCheckpointStatus} from './checkpoints.js';
import type {OutboxEntry,ProtocolClientState,ProtocolClientStore} from './store.js';

export class PlayerProtocolClientError extends Error {
  constructor(readonly code:string,readonly outcome:'read-only'|'rejected'|'unknown',readonly status=0,readonly requestId?:string){super(code);}
}
export interface PlayerProtocolClientOptions {
  serverUrl:string;token:string;store:ProtocolClientStore;
  expectedIdentity:{roomId:string;gamePlayer:number;lobbySeat?:number;chatPlayer?:number;chatCount?:number;roster?:{gamePlayer:number;chatPlayer:number}[]};
  executorInstanceId?:string;requiredCapabilities?:string[];optionalCapabilities?:string[];
  fetch?:typeof fetch;timeoutMs?:number;monotonicNow?:()=>number;
  onRequestTiming?:(event:{path:string;method:string;durationMs:number;startedAt:number;status:number|null})=>void;
}
export interface CommandIntent {idempotencyKey:string;clientCommandId:string;expectedRevision:string;actionBasis?:string;instructionsVersion:string;kind:ProtocolCommandRequest['kind'];payload:Record<string,unknown>}
const digest=(value:unknown)=>createHash('sha256').update(canonicalProtocolJson(value)).digest('hex');
const sameScope=(a:ProtocolScope,b:ProtocolScope)=>a.serverId===b.serverId&&a.roomId===b.roomId&&a.roomEpoch===b.roomEpoch&&a.playerId===b.playerId;
const keyFor=(epoch:string,key:string)=>JSON.stringify([epoch,key]);
const KNOWN_EVENTS=new Set(['observation.changed','command.status.changed','control.changed','readiness.changed','chat.added','chat.changed','notification.added','notifications.changed','instructions.confirmed','instructions.changed','commander.work.available','commander.changed','room.lifecycle.changed','turn.deadline.changed','resync.required']);
function scope(value:unknown):ProtocolScope {const v=protocolObject(value);return {serverId:protocolIdentifier(v.serverId),roomId:protocolIdentifier(v.roomId),roomEpoch:protocolIdentifier(v.roomEpoch),playerId:protocolIdentifier(v.playerId)};}
function receipt(value:unknown):ProtocolReceipt {
  const v=protocolObject(value);scope(v.scope);for(const name of ['commandId','idempotencyKey','clientCommandId'])protocolIdentifier(v[name]);protocolCounter(v.receiptVersion);
  if(!['accepted','applied','scheduled','rejected','cancelled'].includes(String(v.state))||typeof v.effectCommitted!=='boolean'||typeof v.intentDigest!=='string'||v.intentDigest.length!==64||!/^[a-f0-9]{64}$/.test(v.intentDigest))throw Error('Invalid command receipt');
  if(v.effectCommitted!==['applied','scheduled','cancelled'].includes(String(v.state)))throw Error('Invalid receipt commitment');
  return v as unknown as ProtocolReceipt;
}
function mergeReceipt(state:ProtocolClientState,incoming:ProtocolReceipt):void {
  const entry=state.outbox[keyFor(incoming.scope.roomEpoch,incoming.idempotencyKey)];
  // Other executors' valid receipts need not become this executor's outbox.
  if(!entry)return;
  if(!sameScope(entry.scope,incoming.scope)||entry.intentDigest!==incoming.intentDigest||entry.request.clientCommandId!==incoming.clientCommandId)throw Error('Receipt intent or identity mismatch');
  if(entry.request.kind==='order-batch'&&(!incoming.effectCommitted&&incoming.effects?.batchReceipts!==undefined||incoming.effectCommitted&&incoming.state!=='applied'))throw Error('Batch receipt commitment mismatch');
  if(entry.request.kind==='order-batch'&&incoming.effectCommitted){
    const commands=entry.request.payload.commands as ProtocolCommandRequest[],children=incoming.effects?.batchReceipts;
    if(!Array.isArray(children)||children.length!==commands.length)throw Error('Incomplete batch receipts');
    for(let index=0;index<commands.length;index++){
      const child=receipt(children[index]),request=commands[index]!;
      if(!sameScope(child.scope,entry.scope)||child.idempotencyKey!==request.idempotencyKey||child.clientCommandId!==request.clientCommandId||child.intentDigest!==digest(protocolCommandIntent(entry.scope,request))||!['applied','rejected'].includes(child.state))throw Error('Batch child receipt mismatch');
    }
  }
  if(entry.receipt){
    if(entry.receipt.commandId!==incoming.commandId)throw Error('Command ID changed');
    const order=compareProtocolCounters(incoming.receiptVersion,entry.receipt.receiptVersion);
    if(order<0)return;
    if(order===0){if(canonicalProtocolJson(incoming)!==canonicalProtocolJson(entry.receipt))throw Error('Conflicting receipt at the same version');return;}
    if(entry.receipt.state!=='accepted'&&incoming.state!==entry.receipt.state)throw Error('Receipt state regressed');
  }
  entry.receipt=incoming;entry.state=incoming.state==='accepted'?'accepted':'settled';entry.reason=null;
}
/** Core transport. The caller owns policy, model use, private memory, and explicitly starting play. */
export class PlayerProtocolClient {
  private helloValue:ProtocolHelloResponse|null=null;
  private leaseValue:ProtocolLease|null=null;
  private deadline=0;
  private active=false;
  private lifecycleGeneration=0;
  private controlSequence=0;
  private pendingControls=new Map<number,number>();
  private batchSnapshots=new Map<string,unknown>();
  private readonly now:()=>number;
  private readonly origin:string;
  private readonly fetcher:typeof fetch;
  private readonly instanceId:string;
  private connecting:Promise<ProtocolHelloResponse>|null=null;
  constructor(private readonly options:PlayerProtocolClientOptions){
    const url=new URL(options.serverUrl);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Expected an explicit server origin');
    if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Remote executor credentials require HTTPS');
    if(!options.token||/[\r\n\0]/.test(options.token))throw Error('Invalid executor credential');
    this.origin=url.origin;this.fetcher=options.fetch??fetch;this.now=options.monotonicNow??(()=>performance.now());this.instanceId=options.executorInstanceId??randomUUID();
  }
  get hello(){return this.helloValue?structuredClone(this.helloValue):null;}
  get sessionId(){return this.helloValue?.sessionId??null;}
  /** Pending command settlement blocks gameplay writes, not lease maintenance. */
  get leaseActive(){return this.active&&this.now()<this.deadline;}
  get writable(){if(!this.leaseActive)return false;const stop=this.options.store.readSafetyStop?this.options.store.readSafetyStop():this.state.safetyStop;return!stop&&!this.outboxEntries(['unknown','accepted','blocked']).length;}
  get remainingLeaseMs(){return this.leaseActive?Math.max(0,this.deadline-this.now()):0;}
  get state(){return this.options.store.load();}
  get hasUnresolvedCommands(){return this.outboxEntries(['prepared','unknown','accepted','blocked']).length>0;}
  private outboxEntries(states:readonly OutboxEntry['state'][],includeScheduled=false){
    return this.options.store.outboxEntries?.(states,includeScheduled)??Object.values(this.state.outbox).filter(entry=>states.includes(entry.state)||includeScheduled&&entry.receipt?.state==='scheduled');
  }
  private outboxEntry(key:string){return this.options.store.outboxEntry?this.options.store.outboxEntry(key):this.state.outbox[key];}
  /** Null means unnegotiated, unbootstrapped, or stale. It never means "no protected orders". */
  get manualCommands(){
    const state=this.state;
    if(!this.hasCapability('manual-commands/1')||state.needsSnapshot||!state.snapshot)return null;
    const observation=protocolObject(state.snapshot.observation);
    if(observation.manualCommands===undefined)return null;
    return parseManualCommandView(observation.manualCommands,this.options.expectedIdentity.gamePlayer);
  }
  hasCapability(capability:string){return this.helloValue?.capabilities.includes(capability)??false;}
  pause(){this.lifecycleGeneration++;this.active=false;this.deadline=0;}
  private stop(reason:string){this.pause();this.options.store.transaction(s=>{s.safetyStop=reason;});}
  private resyncRequired():never{this.stop('resync-required');throw new PlayerProtocolClientError('RESYNC_REQUIRED','read-only');}
  private assertScope(value:unknown,expected=this.helloValue?.scope):ProtocolScope {
    const actual=scope(value);if(!expected||!sameScope(actual,expected))throw new PlayerProtocolClientError('IDENTITY_OR_EPOCH_MISMATCH','rejected');return actual;
  }
  private async request(path:string,body?:unknown,readOnly=body===undefined):Promise<unknown>{
    if(!path.startsWith('/player/v2/')||path.includes('#'))throw Error('Only v2 protocol paths are permitted');
    const requestId=randomUUID();let response:Response;
    const started=performance.now(),startedAt=Date.now();let status:number|null=null;
    // Abort is a cancellation request, not a bound on a fetch/body promise.
    // Settle the caller at the deadline even if transport cleanup never settles.
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
      reject(new PlayerProtocolClientError('TRANSPORT_UNCONFIRMED',readOnly?'read-only':'unknown',status??0,requestId));abort.abort();
    },this.options.timeoutMs??15000);});
    try{
    return await Promise.race([timeout,(async()=>{
    try{
      response=await this.fetcher(new URL(path,this.origin),{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${this.options.token}`,'Content-Type':'application/json','X-Request-Id':requestId},...(body===undefined?{}:{body:canonicalProtocolJson(body)}),signal:abort.signal,redirect:'error'});
      if(abort.signal.aborted){void response.body?.cancel().catch(()=>{});abort.signal.throwIfAborted();}
    }catch{throw new PlayerProtocolClientError('TRANSPORT_UNCONFIRMED',readOnly?'read-only':'unknown',0,requestId);}
    status=response.status;
    return await this.jsonResponse(response,readOnly,requestId,['/player/v2/observation','/player/v2/commander','/player/v2/sync'].includes(path.split('?')[0]!)?PLAYER_PROTOCOL_LIMITS.snapshotBytes+32768:PLAYER_PROTOCOL_LIMITS.responsePageBytes+32768,abort.signal);
    })()]);
    }finally{clearTimeout(timer);try{this.options.onRequestTiming?.({path:path.split('?')[0]!,method:body===undefined?'GET':'POST',durationMs:performance.now()-started,startedAt,status});}catch{/* Diagnostics must not change transport outcomes. */}}
  }
  private async jsonResponse(response:Response,readOnly:boolean,requestId:string,maximum:number,signal:AbortSignal):Promise<unknown>{
    let value:unknown,length=0,limited=false;const chunks:Uint8Array[]=[];
    // Headers do not confirm a complete response. A deadline or broken stream
    // during body reading is a transport failure, not malformed protocol JSON.
    const reader=response.body?.getReader(),cancel=()=>{void reader?.cancel().catch(()=>{});};
    signal.addEventListener('abort',cancel,{once:true});
    try{
      if(reader)while(true){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;length+=next.value.byteLength;if(length>maximum){limited=true;cancel();throw Error('Response limit');}chunks.push(next.value);}
      signal.throwIfAborted();
    }catch{throw new PlayerProtocolClientError(limited?'INVALID_RESPONSE':'TRANSPORT_UNCONFIRMED',readOnly?'read-only':'unknown',response.status,requestId);}
    finally{signal.removeEventListener('abort',cancel);}
    try{const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      value=parseStrictProtocolJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes),maximum);}
    catch{throw new PlayerProtocolClientError('INVALID_RESPONSE',readOnly?'read-only':'unknown',response.status,requestId);}
    if(!response.ok){const error=protocolObject(value) as unknown as ProtocolErrorBody;const outcome=readOnly?'read-only':error.outcome==='rejected'?'rejected':'unknown';if(['UNAUTHORIZED','SCOPE_DENIED','ROOM_EPOCH_CHANGED','FENCE_STALE','LEASE_LOST'].includes(error.code))this.pause();if(error.code==='LEASE_LOST'){this.helloValue=null;this.leaseValue=null;}if(error.code==='RESYNC_REQUIRED')this.stop('resync-required');if(['REVISION_CONFLICT','MANUAL_COMMAND_CONFLICT','MANUAL_INTENT_CHANGED','DISPATCH_SOURCE_LOCKED'].includes(error.code))this.options.store.transaction(state=>{state.needsSnapshot=true;});throw new PlayerProtocolClientError(typeof error.code==='string'?error.code:'HTTP_ERROR',outcome,response.status,requestId);}
    return value;
  }
  async connect():Promise<ProtocolHelloResponse>{
    if(this.helloValue)return structuredClone(this.helloValue);
    if(this.connecting)return this.connecting;
    this.connecting=this.handshake().finally(()=>{this.connecting=null;});return this.connecting;
  }
  private async handshake():Promise<ProtocolHelloResponse>{
    const required=['core/2',...(this.options.requiredCapabilities??[])],optional=this.options.optionalCapabilities??[];
    const raw=protocolObject(await this.request('/player/v2/sessions/hello',{supportedVersions:[PLAYER_PROTOCOL_VERSION],requiredCapabilities:[...new Set(required)],optionalCapabilities:[...new Set(optional)],executorInstanceId:this.instanceId}));
    const hello=raw as unknown as ProtocolHelloResponse,identity=protocolObject(raw.identity),expected=this.options.expectedIdentity;
    const bound=scope(raw.scope);if(bound.roomId!==expected.roomId||!sameScope(scope(identity),bound)||identity.gamePlayer!==expected.gamePlayer)throw new PlayerProtocolClientError('IDENTITY_MISMATCH','rejected');
    for(const field of ['lobbySeat','chatPlayer','chatCount'] as const)if(expected[field]!==undefined&&identity[field]!==expected[field])throw new PlayerProtocolClientError('IDENTITY_MISMATCH','rejected');
    if(!Array.isArray(identity.roster)||!identity.roster.some(row=>{const r=protocolObject(row);return r.gamePlayer===identity.gamePlayer&&r.chatPlayer===identity.chatPlayer;}))throw Error('Invalid authenticated roster');
    if(expected.roster&&canonicalProtocolJson(identity.roster)!==canonicalProtocolJson(expected.roster))throw Error('Authenticated roster mismatch');
    if(hello.version?.major!==2||hello.version.minor!==0||!Array.isArray(hello.capabilities)||required.some(cap=>!hello.capabilities.includes(cap)))throw new PlayerProtocolClientError('PROTOCOL_INCOMPATIBLE','rejected');
    protocolIdentifier(hello.sessionId);protocolCounter(hello.authorizationVersion);
    const matched=this.options.store.transaction(state=>{
      if(state.scope&&!sameScope(state.scope,bound)){state.safetyStop='identity-or-room-epoch-changed';return false;}
      state.scope=bound;return true;
    });
    if(!matched)throw new PlayerProtocolClientError('identity-or-room-epoch-changed','rejected');
    this.helloValue=hello;
    return structuredClone(hello);
  }
  private async session(){await this.connect();return this.helloValue!;}
  private validateLease(value:unknown):ProtocolLease {
    const v=protocolObject(value);this.assertScope(v.scope);protocolCounter(v.generation);
    if(!['agent','manual'].includes(String(v.mode))||v.sessionId!==null&&typeof v.sessionId!=='string')throw Error('Invalid control response');
    protocolInteger(v.remainingTtlMs,0,PLAYER_PROTOCOL_LIMITS.leaseMaxMs);return v as unknown as ProtocolLease;
  }
  async control():Promise<ProtocolLease>{const hello=await this.session();return this.validateLease(await this.request('/player/v2/control?sessionId='+encodeURIComponent(hello.sessionId)));}
  async acquire(ttlMs:number=PLAYER_PROTOCOL_LIMITS.leaseDefaultMs):Promise<ProtocolLease>{
    const requestedGeneration=this.lifecycleGeneration,hello=await this.session();await this.reconcile();
    if(requestedGeneration!==this.lifecycleGeneration)throw new PlayerProtocolClientError('CONTROL_RESPONSE_OBSOLETE','rejected');
    if(this.hasUnresolvedCommands)throw new PlayerProtocolClientError('UNRESOLVED_OUTBOX','rejected');
    if(this.state.safetyStop)throw new PlayerProtocolClientError(this.state.safetyStop!,'rejected');
    return this.controlOperation('acquire',hello,ttlMs);
  }
  private async controlOperation(action:'acquire'|'renew'|'release',hello:ProtocolHelloResponse,ttlMs?:number):Promise<ProtocolLease>{
    if(action!=='release'&&[...this.pendingControls.values()].includes(this.lifecycleGeneration))throw new PlayerProtocolClientError('CONTROL_OPERATION_PENDING','rejected');
    if(action==='renew'&&!this.leaseActive)throw new PlayerProtocolClientError('LEASE_NOT_OWNED','rejected');
    if(action==='acquire')this.pause();
    const started=this.now(),lease=this.leaseValue,originalDeadline=this.deadline,generation=this.lifecycleGeneration,operationSequence=++this.controlSequence;
    if(action!=='acquire'&&!lease)throw new PlayerProtocolClientError('LEASE_NOT_OWNED','rejected');
    const data={roomEpoch:hello.scope.roomEpoch,sessionId:hello.sessionId,idempotencyKey:randomUUID(),...(action==='acquire'?{}:{fence:lease!.generation}),...(ttlMs===undefined?{}:{ttlMs})};
    this.pendingControls.set(operationSequence,generation);
    try{
      const result=protocolObject(await this.request('/player/v2/control/'+action,data)) as unknown as ProtocolControlOperationReceipt;
      const operation=this.validateLease(result.operationResult),current=this.validateLease(result.current);
      if(action==='release'){if(this.leaseValue===lease)this.leaseValue=null;return current;}
      if(generation!==this.lifecycleGeneration||operationSequence!==this.controlSequence||action==='renew'&&(this.now()>=originalDeadline||this.leaseValue!==lease))throw new PlayerProtocolClientError('CONTROL_RESPONSE_OBSOLETE','rejected');
      if(current.mode!=='agent'||current.sessionId!==hello.sessionId||operation.generation!==current.generation||current.remainingTtlMs<=0)throw Error('Lease acquisition was not confirmed');
      this.leaseValue=current;this.deadline=started+Math.min(current.remainingTtlMs,ttlMs??PLAYER_PROTOCOL_LIMITS.leaseDefaultMs)-100;
      this.active=this.now()<this.deadline;if(!this.active)throw Error('Lease response arrived after safe deadline');return current;
    }catch(error){if(generation===this.lifecycleGeneration&&operationSequence===this.controlSequence)this.pause();throw error;}finally{this.pendingControls.delete(operationSequence);}
  }
  async renew(ttlMs:number=PLAYER_PROTOCOL_LIMITS.leaseDefaultMs){if(!this.leaseActive)throw new PlayerProtocolClientError('LEASE_NOT_OWNED','rejected');return this.controlOperation('renew',await this.session(),ttlMs);}
  async release(){this.pause();const lease=this.leaseValue;if(!lease)return;try{const hello=await this.session();if(this.leaseValue!==lease)return;await this.controlOperation('release',hello);}finally{if(this.leaseValue===lease)this.leaseValue=null;}}
  /** Install a full authorized cut without replay pins, pagination, or completion acknowledgements. */
  async sync(waitMs=0,refresh=false):Promise<ProtocolSync>{
    await this.session();if(!this.hasCapability('state.sync/1'))throw new PlayerProtocolClientError('CAPABILITY_NOT_AVAILABLE','read-only');
    protocolInteger(waitMs,0,1000);const before=this.state,generation=this.lifecycleGeneration,controlSequence=this.controlSequence;
    const raw=protocolObject(await this.request('/player/v2/sync?sessionId='+encodeURIComponent(this.sessionId!)+'&waitMs='+waitMs+(before.cursor&&!before.needsSnapshot&&!refresh?'&after='+encodeURIComponent(before.cursor):''))) as unknown as ProtocolSync;
    this.assertScope(raw.scope);this.validateLease(raw.control);protocolIdentifier(raw.streamEpoch);protocolString(raw.cursor,1024);protocolCounter(raw.highWatermark);protocolIdentifier(raw.decisionInputVersion);
    if(raw.document!==null){
      const document=protocolObject(raw.document),observation=protocolObject(document.observation);protocolCounter(document.instructionsVersion);
      if(observation.roomId!==this.options.expectedIdentity.roomId||protocolObject(observation.view).player!==this.options.expectedIdentity.gamePlayer)throw new PlayerProtocolClientError('IDENTITY_OR_EPOCH_MISMATCH','read-only');
      if(this.hasCapability('manual-commands/1'))observation.manualCommands=parseManualCommandView(observation.manualCommands,this.options.expectedIdentity.gamePlayer);
      this.options.store.transaction(state=>{
        // A concurrent command snapshot may already be newer; never roll it back.
        if(state.streamEpoch!==before.streamEpoch&&state.streamEpoch!==raw.streamEpoch)return;
        if(state.streamEpoch===raw.streamEpoch&&compareProtocolCounters(raw.highWatermark,state.sequence)<0)return;
        if(state.safetyStop&&state.safetyStop!=='resync-required')return;
        const prior=state.snapshot?.observation as Record<string,unknown>|undefined;
        if(this.hasCapability('manual-commands/1')&&prior?.manualCommands!==undefined&&parseManualCommandView(observation.manualCommands).version<parseManualCommandView(prior.manualCommands).version)throw Error('Manual command version regressed');
        state.snapshot=document;state.cursor=raw.cursor;state.sequence=raw.highWatermark;state.streamEpoch=raw.streamEpoch;state.decisionInputVersion=raw.decisionInputVersion;state.needsSnapshot=false;state.safetyStop=null;
      });
    }else if(before.cursor!==raw.cursor||before.sequence!==raw.highWatermark||before.streamEpoch!==raw.streamEpoch||before.decisionInputVersion!==raw.decisionInputVersion)throw new PlayerProtocolClientError('INVALID_SYNC_CUT','read-only');
    if(this.active&&generation===this.lifecycleGeneration&&controlSequence===this.controlSequence&&(raw.control.sessionId!==this.sessionId||raw.control.generation!==this.leaseValue?.generation))this.pause();
    return raw;
  }
  async snapshot():Promise<Record<string,unknown>>{return this.installSnapshot();}
  private async installSnapshot(initialPage?:unknown):Promise<Record<string,unknown>>{
    await this.session();const snapshotBefore=this.state;let first:ProtocolSnapshotPage|null=null,token:string|null=null,document='',index=0;
    do{
      const path=first?'/player/v2/snapshot?snapshotId='+encodeURIComponent(first.snapshotId)+'&pageToken='+encodeURIComponent(token!):'/player/v2/snapshot';
      const page=protocolObject(index===0&&initialPage!==undefined?initialPage:await this.request(path)) as unknown as ProtocolSnapshotPage;this.assertScope(page.scope);protocolCounter(page.highWatermark);protocolString(page.cursor,1024);protocolIdentifier(page.streamEpoch);
      if(!page.page||page.page.encoding!=='json-text/1'||page.page.index!==index||!Number.isSafeInteger(page.page.count)||page.page.count<1||page.page.count>1024||typeof page.page.text!=='string')throw Error('Invalid snapshot page');
      if(first){const {page:_,...head}=first,{page:__,...next}=page;if(canonicalProtocolJson(head)!==canonicalProtocolJson(next))throw Error('Snapshot cut changed during pagination');}else first=page;
      document+=page.page.text;if(Buffer.byteLength(document)>PLAYER_PROTOCOL_LIMITS.snapshotBytes)throw Error('Snapshot too large');
      token=page.page.nextPageToken;index++;if(index>page.page.count||Boolean(token)!==(index<page.page.count))throw Error('Snapshot pagination mismatch');
    }while(token!==null);
    if(createHash('sha256').update(document).digest('hex')!==first!.snapshotDigest)throw Error('Snapshot digest mismatch');
    const payload=protocolObject(parseStrictProtocolJson(document,PLAYER_PROTOCOL_LIMITS.snapshotBytes));
    if(this.hasCapability('manual-commands/1')){
      const observation=protocolObject(payload.observation);
      observation.manualCommands=parseManualCommandView(observation.manualCommands,this.options.expectedIdentity.gamePlayer);
    }
    this.options.store.transaction(state=>{
      // The pinned command cut remains valid even if live synchronization finished first.
      if(state.streamEpoch!==snapshotBefore.streamEpoch&&state.streamEpoch!==first!.streamEpoch)return;
      if(state.streamEpoch===first!.streamEpoch&&compareProtocolCounters(first!.highWatermark,state.sequence)<0)return;
      const observation=protocolObject(payload.observation),prior=state.snapshot?.observation as Record<string,unknown>|undefined;
      if(this.hasCapability('manual-commands/1')&&prior?.manualCommands!==undefined&&parseManualCommandView(observation.manualCommands).version<parseManualCommandView(prior.manualCommands).version)throw Error('Manual command version regressed');
      if(state.safetyStop==='resync-required')state.safetyStop=null;state.snapshot=payload;state.cursor=first!.cursor;state.sequence=first!.highWatermark;state.streamEpoch=first!.streamEpoch;state.decisionInputVersion=first!.decisionInputVersion;state.needsSnapshot=false;});
    // The local snapshot/cursor commit precedes releasing the server replay pin.
    await this.request('/player/v2/snapshot/'+encodeURIComponent(first!.snapshotId)+'/complete',{});
    return structuredClone(payload);
  }
  async events(apply?:(event:ProtocolEvent,application:Record<string,unknown>)=>void,limit=100):Promise<ProtocolEventPage>{
    await this.session();const before=this.state;if(!before.cursor||!before.streamEpoch)throw new PlayerProtocolClientError('SNAPSHOT_REQUIRED','read-only');
    const page=protocolObject(await this.request('/player/v2/events?after='+encodeURIComponent(before.cursor)+'&limit='+limit)) as unknown as ProtocolEventPage;
    return this.applyEventPage(page,before,apply);
  }
  /** Independent wake hint; never installs a cursor or acknowledges decision inputs. */
  async waitForEvents(after:string,waitMs=1000):Promise<ProtocolEventPage>{
    await this.session();if(!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>1000)throw Error('Invalid event wait');
    const page=protocolObject(await this.request('/player/v2/events?after='+encodeURIComponent(after)+'&waitMs='+waitMs)) as unknown as ProtocolEventPage;
    this.assertScope(page.scope);if(page.inputCursor!==after||!Array.isArray(page.events)||typeof page.hasMore!=='boolean')throw new PlayerProtocolClientError('INVALID_RESPONSE','read-only');
    protocolString(page.nextCursor,1024);return page;
  }
  private async applyEventPage(page:ProtocolEventPage,before:ProtocolClientState,apply?:((event:ProtocolEvent,application:Record<string,unknown>)=>void)):Promise<ProtocolEventPage>{
    this.assertScope(page.scope);if(page.streamEpoch!==before.streamEpoch||page.inputCursor!==before.cursor||page.coverage?.fromExclusive!==before.sequence||!Array.isArray(page.events)||typeof page.hasMore!=='boolean')this.resyncRequired();
    let sequence=BigInt(before.sequence),last=before.cursor;
    for(const event of page.events){this.assertScope(event.scope);if(event.streamEpoch!==before.streamEpoch||BigInt(protocolCounter(event.seq))!==++sequence||event.schemaVersion!==1||typeof event.required!=='boolean'||typeof event.type!=='string')this.resyncRequired();protocolString(event.cursor,1024);protocolObject(event.payload);last=event.cursor;
      if(event.required&&!KNOWN_EVENTS.has(event.type)){this.stop('unsupported-required-event');throw new PlayerProtocolClientError('UNSUPPORTED_REQUIRED_EVENT','read-only');}
    }
    if(page.coverage.toInclusive!==String(sequence)||page.nextCursor!==last||page.hasMore&&!page.events.length)this.resyncRequired();
    this.options.store.transaction(state=>{
      if(state.cursor!==before.cursor||state.streamEpoch!==before.streamEpoch)throw Error('Concurrent cursor update');
      for(const event of page.events){
        if(!KNOWN_EVENTS.has(event.type))continue;
        if(event.type==='command.status.changed')mergeReceipt(state,receipt(event.payload.receipt));
        if(['observation.changed','chat.added','chat.changed','notification.added','notifications.changed','instructions.confirmed','instructions.changed','commander.work.available','commander.changed','room.lifecycle.changed','turn.deadline.changed','resync.required'].includes(event.type))state.needsSnapshot=true;
        if(event.type==='resync.required')state.safetyStop='resync-required';
        const applied:unknown=apply?.(event,state.application);if(applied instanceof Promise)throw Error('Event reducers must be synchronous');
      }
      state.cursor=page.nextCursor;state.sequence=page.coverage.toInclusive;
    });
    if(page.events.some(event=>event.type==='resync.required'))this.pause();
    if(this.active&&page.events.some(event=>event.type==='control.changed')){
      const lease=this.leaseValue,generation=this.lifecycleGeneration,current=await this.control();
      if(generation===this.lifecycleGeneration&&this.leaseValue===lease&&(current.sessionId!==this.sessionId||current.generation!==lease?.generation))this.pause();
    }
    return page;
  }
  async command(intent:CommandIntent):Promise<ProtocolReceipt>{
    if(intent.kind==='order-batch'&&!this.hasCapability('actions.batch/1'))throw new PlayerProtocolClientError('CAPABILITY_NOT_AVAILABLE','rejected');
    if(intent.actionBasis!==undefined&&!this.hasCapability('actions.scoped-revision/1'))throw new PlayerProtocolClientError('CAPABILITY_NOT_AVAILABLE','rejected');
    const hello=await this.session();if(!this.writable||!this.leaseValue)throw new PlayerProtocolClientError('WRITE_PAUSED','rejected');
    const request=parseProtocolCommand({...intent,roomEpoch:hello.scope.roomEpoch,sessionId:hello.sessionId,fence:this.leaseValue.generation,authorizationVersion:hello.authorizationVersion});
    return this.enqueue(request,hello);
  }
  async commandBatch(intent:Omit<CommandIntent,'kind'|'payload'|'actionBasis'>&{commands:Omit<CommandIntent,'kind'>[]}):Promise<{receipt:ProtocolReceipt;snapshot:Record<string,unknown>}>{
    const hello=await this.session();if(!this.leaseValue||!this.writable)throw new PlayerProtocolClientError('WRITE_PAUSED','rejected');
    const commands=intent.commands.map(child=>({...child,kind:'order',roomEpoch:hello.scope.roomEpoch,sessionId:hello.sessionId,fence:this.leaseValue!.generation,authorizationVersion:hello.authorizationVersion}));
    const {commands:_,...base}=intent,receipt=await this.command({...base,kind:'order-batch',payload:{commands}});
    if(receipt.state==='accepted')throw new PlayerProtocolClientError('COMMAND_PENDING','unknown');
    const page=this.batchSnapshots.get(receipt.idempotencyKey);this.batchSnapshots.delete(receipt.idempotencyKey);
    return {receipt,snapshot:await this.installSnapshot(page)};
  }
  async workerCommand(intent:{idempotencyKey:string;clientCommandId:string;instructionsVersion:string;payload:Record<string,unknown>}):Promise<ProtocolReceipt>{
    const hello=await this.session();if(!this.hasCapability('commander.worker/1'))throw new PlayerProtocolClientError('UNSUPPORTED_CAPABILITY','rejected');
    if(this.state.safetyStop)throw new PlayerProtocolClientError(this.state.safetyStop,'rejected');
    return this.enqueue(parseProtocolCommander({...intent,roomEpoch:hello.scope.roomEpoch,sessionId:hello.sessionId,authorizationVersion:hello.authorizationVersion,kind:'commander-worker'}),hello);
  }
  private async enqueue(request:ProtocolMutationRequest,hello:ProtocolHelloResponse):Promise<ProtocolReceipt>{
    const intentDigest=digest(protocolCommandIntent(hello.scope,request)),key=keyFor(request.roomEpoch,request.idempotencyKey);
    this.options.store.transaction(state=>{
      const old=state.outbox[key];if(old){if(old.intentDigest!==intentDigest)throw new PlayerProtocolClientError('IDEMPOTENCY_CONFLICT','rejected');return;}
      state.outbox[key]={scope:hello.scope,request,intentDigest,attempts:0,state:'prepared',receipt:null,reason:null};
    });
    const existing=this.outboxEntry(key)!;if(existing.receipt)return existing.receipt;
    if(existing.state==='settled')throw new PlayerProtocolClientError(existing.reason??'COMMAND_REJECTED','rejected');
    if(existing.state!=='prepared')throw new PlayerProtocolClientError('RECONCILE_REQUIRED','unknown');
    return this.dispatch(key);
  }
  private async dispatch(key:string,recoveryDeadline?:number):Promise<ProtocolReceipt>{
    const entry=this.outboxEntry(key)!;
    if(entry.request.sessionId!==this.sessionId||this.state.safetyStop||entry.request.kind!=='commander-worker'&&!(recoveryDeadline!==undefined&&this.now()<recoveryDeadline)&&(!this.writable||entry.request.fence!==this.leaseValue?.generation))throw new PlayerProtocolClientError('ORIGINAL_FENCE_NOT_OWNED','rejected');
    // Persist unknown before I/O, so a crash cannot silently lose an accepted command.
    this.options.store.transaction(state=>{state.outbox[key]!.state='unknown';state.outbox[key]!.attempts=(state.outbox[key]!.attempts??1)+1;});
    try{
      const raw=await this.request(entry.request.kind==='commander-worker'?'/player/v2/commander/worker':entry.request.kind==='order-batch'?'/player/v2/commands/batch':'/player/v2/commands',entry.request);
      const envelope=entry.request.kind==='order-batch'?protocolObject(raw):null,result=receipt(envelope?envelope.receipt:raw);
      if(result.idempotencyKey!==entry.request.idempotencyKey)throw Error('Command receipt key mismatch');
      this.options.store.transaction(state=>{mergeReceipt(state,result);if(result.effectCommitted&&entry.request.kind!=='readiness'||result.code&&['REVISION_CONFLICT','MANUAL_COMMAND_CONFLICT','MANUAL_INTENT_CHANGED','DISPATCH_SOURCE_LOCKED'].includes(result.code))state.needsSnapshot=true;});
      if(envelope&&envelope.snapshot!==undefined){while(this.batchSnapshots.size>=PLAYER_PROTOCOL_LIMITS.snapshotsPerPlayer)this.batchSnapshots.delete(this.batchSnapshots.keys().next().value!);this.batchSnapshots.set(result.idempotencyKey,envelope.snapshot);}
      if(result.state==='accepted')this.pause();return this.outboxEntry(key)!.receipt!;
    }
    catch(error){
      if(error instanceof PlayerProtocolClientError&&error.outcome==='rejected'&&(this.outboxEntry(key)!.attempts??1)===1)this.options.store.transaction(state=>{const row=state.outbox[key]!;row.state='settled';row.reason=error.code;});
      else this.pause();
      throw error;
    }
  }
  /** Lookup is always first. No retry with a new key, epoch, session, fence, or revision. */
  async reconcile(options:{retryAbsent?:boolean}={}):Promise<OutboxEntry[]>{
    await this.session();const pending=this.outboxEntries(['prepared','unknown','accepted','blocked'],true);
    const epochs=[...new Set(pending.map(row=>row.scope.roomEpoch))];
    for(const epoch of epochs){const entries=pending.filter(row=>row.scope.roomEpoch===epoch);for(let at=0;at<entries.length;at+=PLAYER_PROTOCOL_LIMITS.lookupBatchSize){
      const batch=entries.slice(at,at+PLAYER_PROTOCOL_LIMITS.lookupBatchSize),raw=protocolObject(await this.request('/player/v2/commands/lookup',{roomEpoch:epoch,idempotencyKeys:batch.map(row=>row.request.idempotencyKey)},true));
      this.assertScope(raw.scope,{...this.helloValue!.scope,roomEpoch:epoch});if(!Array.isArray(raw.results)||raw.results.length!==batch.length)throw Error('Incomplete lookup result');
      for(let index=0;index<batch.length;index++){
        const old=batch[index]!,result=protocolObject(raw.results[index]) as unknown as ProtocolLookup,key=keyFor(epoch,old.request.idempotencyKey);
        if(result.coverage?.roomEpoch!==epoch)throw Error('Lookup coverage epoch mismatch');
        if(result.status==='found'){const found=receipt(result.receipt);if(found.idempotencyKey!==old.request.idempotencyKey)throw Error('Lookup key mismatch');this.options.store.transaction(state=>mergeReceipt(state,found));continue;}
        if(result.idempotencyKey!==old.request.idempotencyKey)throw Error('Lookup key mismatch');
        const complete=result.status==='absent_within_retained_scope'&&result.coverage.authoritative&&result.coverage.retained==='complete';
        let retired=false,recoveryDeadline:number|undefined;
        if(complete&&!old.receipt&&old.request.kind!=='commander-worker'&&old.scope.roomEpoch===this.helloValue!.scope.roomEpoch){
          const controlStarted=this.now(),control=await this.control();
          retired=compareProtocolCounters(control.generation,old.request.fence)>0;
          if(control.sessionId===old.request.sessionId&&old.request.sessionId===this.sessionId&&control.generation===old.request.fence&&control.remainingTtlMs>100)recoveryDeadline=controlStarted+control.remainingTtlMs-100;
        }
        if(complete&&retired&&!old.receipt){
          // Retirement precedes this second lookup. A packet that won the race
          // between the first absence and retirement must now have a receipt.
          const verified=protocolObject(await this.request('/player/v2/commands/lookup',{roomEpoch:epoch,idempotencyKeys:[old.request.idempotencyKey]},true));
          this.assertScope(verified.scope,{...this.helloValue!.scope,roomEpoch:epoch});
          if(!Array.isArray(verified.results)||verified.results.length!==1)throw Error('Incomplete retirement lookup');
          const final=protocolObject(verified.results[0]) as unknown as ProtocolLookup;
          if(final.status==='found'){const found=receipt(final.receipt);if(found.idempotencyKey!==old.request.idempotencyKey)throw Error('Lookup key mismatch');this.options.store.transaction(state=>mergeReceipt(state,found));continue;}
          retired=final.idempotencyKey===old.request.idempotencyKey&&final.status==='absent_within_retained_scope'&&final.coverage.roomEpoch===epoch&&final.coverage.authoritative&&final.coverage.retained==='complete';
        }
        const safeUnsent=(old.attempts??1)===0;
        this.options.store.transaction(state=>{const row=state.outbox[key]!;
          if(row.receipt){row.state=row.receipt.state==='accepted'?'accepted':'settled';return;}
          if(complete&&(retired||safeUnsent)){row.state='settled';row.reason=retired?'absent-after-authority-retired':'never-dispatched';}
          else if(complete&&!row.receipt){row.state='unknown';row.reason='absent-with-original-authority-unresolved';}
          else{row.state='blocked';row.reason='ledger-history-unavailable';}
        });
        if(complete&&!retired&&!old.receipt&&options.retryAbsent&&!this.state.safetyStop&&(recoveryDeadline!==undefined||old.request.kind==='commander-worker'&&old.request.sessionId===this.sessionId))await this.dispatch(key,recoveryDeadline);
      }
    }}
    return Object.values(this.state.outbox);
  }
  private async checkpointRead(id?:string):Promise<ProtocolCheckpointStatus|null>{
    const hello=await this.session();if(!this.hasCapability('checkpoints.coordinated/1'))throw new PlayerProtocolClientError('UNSUPPORTED_CAPABILITY','read-only');
    const value=parseCheckpointStatus(await this.request('/player/v2/checkpoints/'+(id===undefined?'current':encodeURIComponent(protocolIdentifier(id)))));
    if(value&&(value.roomEpoch!==hello.scope.roomEpoch||id!==undefined&&value.checkpointId!==id))throw new PlayerProtocolClientError('IDENTITY_OR_EPOCH_MISMATCH','read-only');
    if(value)this.options.store.transaction(state=>{for(const row of Object.values(state.checkpointOutbox??{})){if(row.request.checkpointId!==value.checkpointId||!sameScope(row.scope,hello.scope))continue;if(checkpointAckMatches(value,row.request)){row.state='confirmed';row.reason=null;}else if(['completed','aborted'].includes(value.phase)){row.state='closed';row.reason='authoritative-terminal-without-ack';}}});
    return value;
  }
  checkpointCurrent(){return this.checkpointRead();}
  checkpointHistory(id:string){return this.checkpointRead(id);}
  /** The server's checkpoint/session/phase tuple is its idempotency key. Never invent a replacement receipt. */
  async checkpointAck(input:{checkpointId:string;phase:ProtocolCheckpointAcknowledgement['phase'];receiptId?:string;sha256?:string}):Promise<ProtocolCheckpointStatus>{
    const hello=await this.session();if(!this.hasCapability('checkpoints.coordinated/1'))throw new PlayerProtocolClientError('UNSUPPORTED_CAPABILITY','rejected');
    const proposed=parseProtocolCheckpointAcknowledgement({...input,roomEpoch:hello.scope.roomEpoch,sessionId:hello.sessionId,authorizationVersion:hello.authorizationVersion}),key=JSON.stringify([hello.scope.roomEpoch,input.checkpointId,input.phase]);
    this.options.store.transaction(state=>{const outbox=state.checkpointOutbox??= {},existing=outbox[key];if(existing){if(canonicalProtocolJson(existing.request)!==canonicalProtocolJson(proposed))throw new PlayerProtocolClientError('CHECKPOINT_INTENT_CONFLICT','rejected');}else outbox[key]={scope:hello.scope,request:proposed,attempts:0,state:'prepared',reason:null};});
    const prior=await this.checkpointHistory(input.checkpointId);if(!prior)throw Error('Missing checkpoint');
    if(prior.participant?.sessionId!==hello.sessionId)throw new PlayerProtocolClientError('CHECKPOINT_SESSION_NOT_SELECTED','rejected');
    if(checkpointAckMatches(prior,proposed))return prior;
    if(['completed','aborted'].includes(prior.phase))throw new PlayerProtocolClientError('CHECKPOINT_ALREADY_TERMINAL','rejected');
    this.options.store.transaction(state=>{const row=state.checkpointOutbox![key]!;row.attempts++;row.state='unknown';});
    const response=parseCheckpointStatus(await this.request('/player/v2/checkpoints/ack',proposed));
    if(!response||!checkpointAckMatches(response,proposed))throw new PlayerProtocolClientError('CHECKPOINT_ACK_UNCONFIRMED','unknown');
    this.options.store.transaction(state=>{const row=state.checkpointOutbox![key]!;row.state='confirmed';row.reason=null;});return response;
  }
  /** Extensions remain negotiated and v2-only. This API cannot reach owner/admin or v1 endpoints. */
  async extensionRequest(capability:string,path:string,data?:unknown,readOnly=data===undefined):Promise<unknown>{
    await this.session();if(!this.hasCapability(capability))throw new PlayerProtocolClientError('UNSUPPORTED_CAPABILITY','rejected');
    if(!/^\/(?:observation|commander|chat(?:\/search)?|diplomacy\/receipts|notifications|activity|manual-commands|tick-times)(?:\?[^#]*)?$/.test(path))throw Error('Not a negotiated extension endpoint');
    if(/^\/observation(?:\?|$)/.test(path)&&capability!=='observation.read/1'||/^\/commander(?:\?|$)/.test(path)&&capability!=='commander.read/1')throw new PlayerProtocolClientError('UNSUPPORTED_CAPABILITY','read-only');
    if(/^\/manual-commands(?:\?|$)/.test(path)&&capability!=='manual-commands/1')throw new PlayerProtocolClientError('UNSUPPORTED_CAPABILITY','read-only');
    if(/^\/diplomacy\/receipts(?:\?|$)/.test(path)&&capability!=='diplomacy/2')throw new PlayerProtocolClientError('UNSUPPORTED_CAPABILITY','read-only');
    if(/^\/activity(?:\?|$)/.test(path)&&capability!=='activity.read/1')throw new PlayerProtocolClientError('UNSUPPORTED_CAPABILITY','read-only');
    if(/^\/tick-times(?:\?|$)/.test(path)&&capability!=='tick-times.read/1')throw new PlayerProtocolClientError('UNSUPPORTED_CAPABILITY','read-only');
    if(data!==undefined)throw Error('Mutations must use the durable command API');
    const result=await this.request('/player/v2'+path,data,readOnly);
    const envelope=protocolObject(result);if(/^\/activity(?:\?|$)/.test(path))this.assertScope(envelope.scope);if(envelope.scope!==undefined||['/observation','/commander'].includes(path)||/^\/tick-times(?:\?|$)/.test(path))this.assertScope(envelope.scope);if(/^\/manual-commands(?:\?|$)/.test(path)){this.assertScope(envelope.scope);return {...envelope,...parseManualCommandReceiptPage(envelope,this.options.expectedIdentity.gamePlayer)};}return result;
  }
  /** Fencing inputs for negotiated extensions, never an alternate way to acquire control. */
  authority(){if(!this.writable||!this.leaseValue||!this.helloValue)throw new PlayerProtocolClientError('WRITE_PAUSED','rejected');return{roomEpoch:this.helloValue.scope.roomEpoch,sessionId:this.helloValue.sessionId,fence:this.leaseValue.generation,authorizationVersion:this.helloValue.authorizationVersion};}
}
