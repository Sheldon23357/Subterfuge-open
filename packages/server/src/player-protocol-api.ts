import {createHash} from 'node:crypto';
import {actionBasisMaterial,type PlayerObservation} from '../../contracts/src/index.js';
import {diplomacyReceiptPage} from '../../engine/src/index.js';
import {GAMEPLAY_RULESET_VERSION} from '../../rules/src/index.js';
import {requestDiagnostics,type RequestDiagnostic} from './request-diagnostics.js';
import {DispatchSourceLocked} from './dispatch-guard.js';
import {manualReceiptPage,ManualCommandConflict} from './manual-commands.js';
import {playerActivityPage} from './player-activity-page.js';
import {createServer,type IncomingMessage} from 'node:http';
import {randomUUID} from 'node:crypto';
import {PLAYER_PROTOCOL_VERSION,PLAYER_PROTOCOL_LIMITS,EXECUTOR_SCOPES,PROTOCOL_PLAYER_ACTIONS,ProtocolValidationError,parseStrictProtocolJson,parseProtocolHello,parseProtocolCommand,parseProtocolCommander,parseProtocolCheckpointAcknowledgement,protocolObject,protocolFields,protocolIdentifier,protocolCounter,protocolInteger,type ProtocolCommandRequest,type ProtocolErrorBody,type ProtocolHelloResponse,type ProtocolReceipt,type ProtocolCommanderRequest} from '../../contracts/src/index.js';
import {projectPlayerNotifications} from '../../engine/src/index.js';
import {projectPlayerAnnouncements,fleetMatchOutcome,fleetStandings} from '../../engine/src/index.js';
import type {ChatStore} from './chat.js';
import {DomainValidationError} from './durable-domain-store.js';
import {searchVisibleChat} from './chat-search.js';
import {PlayerProtocolAdmission,PROTOCOL_ADMISSION_LIMITS} from './player-protocol-admission.js';
import {ownerCommanderView} from './player-protocol-owner.js';
import type {CommanderStore} from './commander-store.js';
import {PROFILE_ID} from '../../rules/src/index.js';
import {SerialExecutor} from './player-access.js';
import {PlayerObservationReader} from './player-observation.js';
import {applyProtocolGameCommand,playerCommandId} from './player-commands.js';
import {projectPlayerHistory} from '../../engine/src/index.js';
import {PlayerProtocolError,requireExecutorScope,type ProtocolPrincipal} from './player-protocol-auth.js';
import type {PlayerProtocolRepository} from './player-protocol-store.js';
import type {LabRoom} from './planning.js';
import type {TickTimePage} from '../../contracts/src/index.js';
function validateCommandBasis(request:ProtocolCommandRequest,view:PlayerObservation,room?:LabRoom){
 if(request.kind==='order-batch'){for(const child of request.payload.commands as ProtocolCommandRequest[])validateCommandBasis(child,view,room);return;}
 // Realtime orders execute against current authority. Time passing does not
 // invalidate an intent; legality, control, instructions and manual priority
 // are still checked in the same settlement transaction below.
 if((room?.timing?.mode==='realtime'||view.realtime===true)&&request.kind==='order')return;
 if(request.actionBasis!==undefined){
  const material=request.kind==='order'?actionBasisMaterial(view,request.payload.action as Record<string,unknown>):null;
  if(!material||createHash('sha256').update(material).digest('hex')!==request.actionBasis)throw new PlayerProtocolError('REVISION_CONFLICT',409,'Action dependencies changed; review the current authorized state','replan');
 }else if(view.revision!==request.expectedRevision)throw new PlayerProtocolError('REVISION_CONFLICT',409,'Observation changed; replan with current authorized information','replan');
}
export const CORE_PLAYER_CAPABILITIES=['core/2','state.sync/1','observation.read/1','actions.order/1','actions.batch/1','actions.schedule/1','readiness/1','activity.read/1','actions.scoped-revision/1','manual-commands/1','diplomacy/2'] as const;
export interface PlayerProtocolHost {
 repository:PlayerProtocolRepository;roomId:string;serial:SerialExecutor;publicOrigin?:string;onDiagnostic?:(entry:RequestDiagnostic)=>void;
 checkpoints?:{current(principal:ProtocolPrincipal,checkpointId?:string):unknown;ack(principal:ProtocolPrincipal,input:Record<string,unknown>):unknown};
 ownerIdentity?:(authorization:unknown)=>{roomId:string;player:number}|null;
 canObserve?:(player:number)=>boolean;canControl?:()=>boolean;
 capabilities?:()=>string[];snapshot?:(player:number)=>Record<string,unknown>;
 tickTimes?:(after:number,limit:number)=>TickTimePage;
 chat?:()=>ChatStore;commander?:CommanderStore;
 load:()=>{room:LabRoom;revision:number};
 /** Must commit using the same SQLite connection as repository. Never mutate published host state until after the enclosing transaction succeeds. */
 commit:(room:LabRoom,expectedRevision:number)=>number;
 refresh?:()=>void;sync?:()=>Promise<void>;seconds?:()=>number;
 programmaticAutoAdvance?:()=>boolean;
 onExternalControl?:(roomId:string,player:number)=>void;
 instructionsVersion?:(player:number)=>string;
 assertCommandWindow?:(tick:number)=>void;
 assertMutationAllowed?:(kind:string,stage?:'admit'|'settle')=>void;
 identity?:(player:number)=>{gamePlayer:number;lobbySeat:number;chatPlayer:number;chatCount:number;roster:{chatPlayer:number;gamePlayer:number}[]};
 /** Dependency-injected crash/barrier seam for isolated tests, not an HTTP route. */
 afterAdmission?:(receipt:ProtocolReceipt)=>Promise<void>;
}
async function readBody(req:IncomingMessage){let length=0;const chunks:Buffer[]=[];for await(const chunk of req){length+=chunk.length;if(length>PLAYER_PROTOCOL_LIMITS.requestBytes)throw new PlayerProtocolError('INVALID_REQUEST',413,'Request body exceeds limit');chunks.push(Buffer.from(chunk));}try{return protocolObject(parseStrictProtocolJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch(error){if(error instanceof PlayerProtocolError)throw error;throw new PlayerProtocolError('INVALID_REQUEST',400,'Request must be bounded strict UTF-8 JSON');}}
function exactQuery(url:URL,allowed:string[]){if([...url.searchParams.keys()].some(k=>!allowed.includes(k)||url.searchParams.getAll(k).length!==1))throw new PlayerProtocolError('INVALID_REQUEST',400,'Unknown or duplicate query parameter');}
function diplomacyCollection(room:LabRoom,player:number,query:URLSearchParams){
 try{const parse=(name:string,fallback?:number)=>{const value=query.get(name);return value===null?fallback:Number(protocolCounter(value));};return diplomacyReceiptPage(room.state.diplomacy,player,parse('after',0)!,parse('through'),parse('limit',100)!);}catch{throw new PlayerProtocolError('INVALID_REQUEST',400,'Invalid diplomacy receipt cursor');}
}
function manualCollection(room:LabRoom,player:number,query:URLSearchParams){try{return manualReceiptPage(room,player,query);}catch{throw new PlayerProtocolError('INVALID_REQUEST',400,'Invalid manual command query or cursor');}}
function requestId(req:IncomingMessage){const id=req.headers['x-request-id'];return typeof id==='string'&&/^[a-zA-Z0-9._:-]{1,128}$/.test(id)?id:randomUUID();}
/** Actual HTTP boundary. It deliberately has no admin/debug/import/model endpoints. */
export function createPlayerProtocolApi(host:PlayerProtocolHost){
 const repository=host.repository,admission=new PlayerProtocolAdmission(),observations=new PlayerObservationReader();
 const observation=(room:LabRoom,player:number,roomId:string,seconds?:number)=>observations.read(room,player,roomId,host.load().revision,seconds);
 const capabilities=()=>[...CORE_PLAYER_CAPABILITIES,...(host.tickTimes?['tick-times.read/1']:[]),...(host.capabilities?.()??[])];
 const timing=(url:URL)=>{
  exactQuery(url,['after','limit']);
  if(!host.tickTimes)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Tick timing is not available');
  const after=Number(protocolCounter(url.searchParams.get('after')??'0')),limit=Number(protocolCounter(url.searchParams.get('limit')??'1000'));
  protocolInteger(after,0,Number.MAX_SAFE_INTEGER);protocolInteger(limit,1,1000);
  const {roomId,headTick,ended,serverTimeMs,headElapsedMs,records,nextCursor,hasMore}=host.tickTimes(after,limit);
  return {roomId,headTick,ended,serverTimeMs,headElapsedMs,records,nextCursor,hasMore};
 };
 const refreshObservations=()=>{const {room}=host.load();for(let player=0;player<room.state.economy.players.length;player++)repository.observe(host.roomId,player,observation(room,player,host.roomId,host.seconds?.()).revision,room.state.economy.tick);return room;};
 const identity=(principal:ProtocolPrincipal)=>{const count=host.load().room.state.economy.players.length;return{...repository.scope(principal.roomId,principal.roomEpoch,principal.player),...(host.identity?.(principal.player)??{gamePlayer:principal.player,lobbySeat:principal.player,chatPlayer:principal.player,chatCount:count,roster:Array.from({length:count},(_,player)=>({gamePlayer:player,chatPlayer:player}))})};};
 const applyBatchChild=(principal:ProtocolPrincipal,request:ProtocolCommandRequest)=>{
   host.assertMutationAllowed?.('order','settle');const current=host.load();host.assertCommandWindow?.(current.room.state.economy.tick);
   if((host.instructionsVersion?.(principal.player)??'0')!==request.instructionsVersion)throw new PlayerProtocolError('INSTRUCTIONS_CHANGED',409,'Confirmed instructions changed','replan');
   let next:ReturnType<typeof applyProtocolGameCommand>;try{next=applyProtocolGameCommand(current.room,principal.player,request,host.seconds?.());}
   catch(error){if(error instanceof ManualCommandConflict)throw new PlayerProtocolError('MANUAL_COMMAND_CONFLICT',409,error.message,'replan');if(error instanceof DispatchSourceLocked)throw new PlayerProtocolError(error.code,409,error.message,'replan');throw new PlayerProtocolError('INVALID_REQUEST',400,'Command is not legal for the current authorized player state');}
   host.commit(next.room,current.revision);host.assertCommandWindow?.(current.room.state.economy.tick);return next.effect;
 };
 const server=createServer((req,res)=>{void(async()=>{
  const id=requestId(req),diagnostic=requestDiagnostics(req,res,host.onDiagnostic,id);
  const serial=<T>(job:()=>T|Promise<T>)=>{diagnostic.stage('queue');return host.serial.run(async()=>{diagnostic.stage('handler');await host.sync?.();return job();});};
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Request-Id',id);
  let leave:(()=>void)|undefined;try{diagnostic.stage('authenticate');
   // Native clients send Bearer credentials without Origin. Browser access remains same-origin only.
   if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`&&req.headers.origin!==`https://${req.headers.host}`&&req.headers.origin!==host.publicOrigin)throw new PlayerProtocolError('SCOPE_DENIED',403,'Browser origin is not enabled','authorization');
   const url=new URL(req.url??'/','http://player.local'),prefix='/player/v2',path=url.pathname.slice(prefix.length);
   if(!url.pathname.startsWith(prefix+'/'))throw new PlayerProtocolError('INVALID_REQUEST',404,'Endpoint not found');
   if(path==='/protocol'&&req.method==='GET'){leave=admission.enter('public','read');exactQuery(url,[]);res.end(JSON.stringify({versions:[PLAYER_PROTOCOL_VERSION],capabilities:capabilities(),limits:PLAYER_PROTOCOL_LIMITS,transportBudgets:PROTOCOL_ADMISSION_LIMITS,rulesetId:PROFILE_ID,rulesetVersion:GAMEPLAY_RULESET_VERSION,observationSchema:'player-observation/2',commandSchema:'player-command/2',compatibility:{current:PLAYER_PROTOCOL_VERSION,previous:null,retirements:[]},actionAvailability:{actions:PROTOCOL_PLAYER_ACTIONS,source:'existing-server-rules',uiHidden:['toggle-funding','resign'],internalOnly:['reserve-fleet','release-fleet-reservation','recall-waiting-fleet']}}));return;}
   if(path.startsWith('/owner/')){
    const owner=host.ownerIdentity?.(req.headers.authorization);if(!owner||owner.roomId!==host.roomId)throw new PlayerProtocolError('UNAUTHORIZED',401,'Owner authorization is required','authorization');
    leave=admission.enter('owner:'+owner.roomId+':'+owner.player,req.method==='POST'?'write':'read');exactQuery(url,path==='/owner/tick-times'?['after','limit']:['/owner/diplomacy/receipts','/owner/manual-commands','/owner/notifications','/owner/announcements','/owner/chat','/owner/activity'].includes(path)?['after','through','limit','id']:path==='/owner/chat/search'?['with','text','id','before','limit']:[]);const data=req.method==='POST'?await readBody(req):null;
    const value=await serial(()=>repository.atomic(()=>{if(req.method==='POST')host.assertMutationAllowed?.('owner');const current=host.ownerIdentity?.(req.headers.authorization);if(!current||current.roomId!==owner.roomId||current.player!==owner.player||current.roomId!==host.roomId)throw new PlayerProtocolError('UNAUTHORIZED',401,'Owner authorization changed','authorization');
     if(path!=='/owner/grants'&&host.canObserve&&!host.canObserve(owner.player))throw new PlayerProtocolError('SCOPE_DENIED',403,'This seat cannot currently observe the game','authorization');
     const room=host.load().room,scope=repository.scope(owner.roomId,repository.currentEpoch(owner.roomId),owner.player),seat=host.identity?.(owner.player)??{gamePlayer:owner.player,lobbySeat:owner.player,chatPlayer:owner.player,chatCount:room.state.economy.players.length,roster:room.state.economy.players.map((_,gamePlayer)=>({gamePlayer,chatPlayer:gamePlayer}))};
     if(path==='/owner/diplomacy/receipts'&&req.method==='GET')return{scope,...diplomacyCollection(room,owner.player,url.searchParams)};
     if(path==='/owner/identity'&&req.method==='GET')return{...scope,...seat,serverTime:repository.serverTime()};
     if(path==='/owner/tick-times'&&req.method==='GET')return {scope,...timing(url)};
     if(path==='/owner/observation'&&req.method==='GET')return observation(room,owner.player,owner.roomId,host.seconds?.());
     if(path==='/owner/control'&&req.method==='GET'){const control=repository.ownerStatus(owner.roomId,owner.player,req.headers);return{protocol:'player-control/2',roomId:owner.roomId,player:owner.player,mode:control.mode,controller:control.mode==='agent'?'external':'manual',sessionId:control.sessionId,expiresAt:control.expiresAt,manualCommandsAllowed:control.manualCommandsAllowed};}
     if(path==='/owner/control'&&data){if(data.action==='acquire'&&host.canControl&&!host.canControl())throw new PlayerProtocolError('CONTROL_BUSY',409,'Control requires a started game','ownership');const result=repository.ownerControl(owner.roomId,owner.player,data,req.headers);if(data.action==='takeover'&&data.mode==='manual')host.onExternalControl?.(owner.roomId,owner.player);return result;}
     if(path==='/owner/activity'&&req.method==='GET'){try{return{roomId:owner.roomId,...playerActivityPage(room.state,owner.player,url.searchParams)};}catch{throw new PlayerProtocolError('INVALID_REQUEST',400,'Invalid activity cursor or incomplete retained activity');}}
     if(path==='/owner/manual-commands'&&req.method==='GET')return {scope:repository.scope(owner.roomId,repository.currentEpoch(owner.roomId),owner.player),...manualCollection(host.load().room,owner.player,url.searchParams)};
     if(path==='/owner/notifications'&&req.method==='GET'){const after=protocolInteger(Number(url.searchParams.get('after')??0),0,Number.MAX_SAFE_INTEGER),limit=protocolInteger(Number(url.searchParams.get('limit')??100),1,200),all=projectPlayerNotifications(room.state,owner.player),notifications=all.slice(after,after+limit).map((entry,i)=>({id:after+i,...entry}));if(after>all.length)throw new PlayerProtocolError('INVALID_REQUEST',400,'Notification cursor is outside the authorized collection');return{roomId:owner.roomId,notifications,nextCursor:after+notifications.length,hasMore:after+notifications.length<all.length};}
     if(path==='/owner/announcements'&&req.method==='GET'){const after=protocolInteger(Number(url.searchParams.get('after')??0),0,Number.MAX_SAFE_INTEGER),limit=protocolInteger(Number(url.searchParams.get('limit')??100),1,200),all=projectPlayerAnnouncements(room.state,owner.player),announcements=all.slice(after,after+limit);if(after>all.length)throw new PlayerProtocolError('INVALID_REQUEST',400,'Announcement cursor is outside the authorized collection');return{roomId:owner.roomId,announcements,nextCursor:after+announcements.length,hasMore:after+announcements.length<all.length};}
     if(path==='/owner/standings'&&req.method==='GET')return fleetMatchOutcome(room.state)?{roomId:owner.roomId,...fleetStandings(room.state)}:{roomId:owner.roomId,ended:false};
     if(path==='/owner/chat'&&req.method==='GET'){if(!host.chat)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Chat is not enabled');const after=protocolInteger(Number(url.searchParams.get('after')??0),0,Number.MAX_SAFE_INTEGER),limit=protocolInteger(Number(url.searchParams.get('limit')??100),1,200),messages=host.chat().listForSeat(seat.chatPlayer),page=messages.slice(after,after+limit);if(after>messages.length)throw new PlayerProtocolError('INVALID_REQUEST',400,'Chat cursor is outside the authorized collection');return{roomId:owner.roomId,messages:page,nextCursor:after+page.length,hasMore:after+page.length<messages.length};}
     if(path==='/owner/chat/conversations'&&req.method==='GET'){if(!host.chat)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Chat is not enabled');return{roomId:owner.roomId,conversations:host.chat().conversationsForSeat(seat.chatPlayer)};}
     if(path==='/owner/chat/search'&&req.method==='GET'){if(!host.chat)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Chat is not enabled');try{return{roomId:owner.roomId,...searchVisibleChat(host.chat().listForSeat(seat.chatPlayer),url.searchParams,seat.chatCount)};}catch{throw new PlayerProtocolError('INVALID_REQUEST',400,'Invalid chat search');}}
     if(path==='/owner/chat/seen'&&data){protocolFields(data,['conversation','through']);if(req.headers['x-subterfuge-controller']==='agent')repository.ownerAssertWrite(owner.roomId,owner.player,req.headers);else if(repository.ownerStatus(owner.roomId,owner.player).mode==='agent')throw new PlayerProtocolError('CONTROL_BUSY',409,'Chat is unavailable while an AI executor owns this seat','ownership');if(!host.chat)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Chat is not enabled');host.chat().markSeenFromSeatSync(seat.chatPlayer,data.conversation,data.through);return{roomId:owner.roomId,conversations:host.chat().conversationsForSeat(seat.chatPlayer)};}
     if(path==='/owner/chat'&&data){protocolFields(data,['id','to','text']);if(req.headers['x-subterfuge-controller']==='agent')repository.ownerAssertWrite(owner.roomId,owner.player,req.headers);else if(repository.ownerStatus(owner.roomId,owner.player).mode==='agent')throw new PlayerProtocolError('CONTROL_BUSY',409,'Chat is unavailable while an AI executor owns this seat','ownership');if(!host.chat)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Chat is not enabled');const message=host.chat().sendFromSeatSync(seat.chatPlayer,data as {id:string;to:number|number[]|null;text:string},seat.chatCount,room.state.economy.tick);return{roomId:owner.roomId,message};}
     if(path==='/owner/queries/history'&&data){protocolFields(data,['expectedRevision','payload']);if(typeof data.expectedRevision!=='string'||! /^[a-f0-9]{64}$/.test(data.expectedRevision))throw new PlayerProtocolError('INVALID_REQUEST',400,'Invalid history revision');const baseline=observation(room,owner.player,owner.roomId,host.seconds?.());if(data.expectedRevision!==baseline.revision)throw new PlayerProtocolError('REVISION_CONFLICT',409,'History baseline changed; refresh the current observation','replan','read-only');const payload=protocolObject(data.payload);protocolFields(payload,['tick'],['seconds']);const tick=protocolInteger(payload.tick,room.state.initial.economy.initialTick,room.state.economy.tick),seconds=payload.seconds===undefined?0:protocolInteger(payload.seconds,0,599),presentSeconds=host.seconds?.()??room.state.secondsSinceLastTick??0;if(tick===room.state.economy.tick&&seconds>presentSeconds)throw new PlayerProtocolError('INVALID_REQUEST',400,'History cannot read a future time');try{return{roomId:owner.roomId,revision:baseline.revision,...projectPlayerHistory(room.state,owner.player,tick,seconds,presentSeconds)};}catch(error){if(error instanceof Error&&['Invalid history time','History time is after game end'].includes(error.message))throw new PlayerProtocolError('INVALID_REQUEST',400,'History time is outside this game');throw error;}}
     if(path==='/owner/commands'&&data){
      protocolFields(data,['kind','clientCommandId','expectedRevision','payload'],['issueTick']);
      if(!['order','schedule','cancel-schedule'].includes(String(data.kind))||typeof data.expectedRevision!=='string'||!/^[a-f0-9]{64}$/.test(data.expectedRevision))throw new PlayerProtocolError('INVALID_REQUEST',400,'Invalid owner command');
      if(data.kind==='schedule'&&(!Number.isSafeInteger(data.issueTick)||Number(data.issueTick)<0)||data.kind!=='schedule'&&data.issueTick!==undefined)throw new PlayerProtocolError('INVALID_REQUEST',400,'Invalid schedule issue tick');
      const executor=req.headers['x-subterfuge-controller']==='agent',clientCommandId=protocolIdentifier(data.clientCommandId),payload=protocolObject(data.payload),commandPayload=data.kind==='schedule'?{...payload,issueTick:data.issueTick}:payload,saved=host.load();
      if(executor&&host.canControl&&!host.canControl())throw new PlayerProtocolError('CONTROL_BUSY',409,'Game is not accessible','ownership');
      host.assertCommandWindow?.(saved.room.state.economy.tick);
      if(executor)repository.ownerAssertWrite(owner.roomId,owner.player,req.headers);
      const candidateId=playerCommandId(owner.player,clientCommandId),candidateDuplicate=data.kind==='cancel-schedule'?[...saved.room.scheduled,...(saved.room.scheduledOrders??[])].some(p=>p.id===payload.id&&p.player===owner.player&&p.status==='cancelled'):saved.room.state.commands.some(c=>c.id===candidateId&&c.player===owner.player)||[...saved.room.scheduled,...(saved.room.scheduledOrders??[])].some(p=>p.id===candidateId&&p.player===owner.player);
      if(!candidateDuplicate&&!(saved.room.clock&&data.kind==='order')&&data.expectedRevision!==observation(saved.room,owner.player,owner.roomId,host.seconds?.()).revision)throw new PlayerProtocolError('REVISION_CONFLICT',409,'Observation changed; review the current state','replan');
      let applied:ReturnType<typeof applyProtocolGameCommand>;try{applied=applyProtocolGameCommand(saved.room,owner.player,{kind:data.kind,clientCommandId,payload:commandPayload} as ProtocolCommandRequest,host.seconds?.(),executor?'agent':'manual');}catch(error){if(error instanceof ManualCommandConflict)throw error;if(error instanceof DispatchSourceLocked)throw new PlayerProtocolError(error.code,409,error.message,'replan');if(error instanceof PlayerProtocolError)throw error;throw new PlayerProtocolError('INVALID_REQUEST',400,'Command is not legal for the current authorized player state');}
      const duplicate=candidateDuplicate;
      if(!duplicate){host.commit(applied.room,saved.revision);refreshObservations();host.assertCommandWindow?.(saved.room.state.economy.tick);}
      return observation(duplicate?saved.room:applied.room,owner.player,owner.roomId,host.seconds?.());
     }
     if(path.startsWith('/owner/commander')){if(!host.commander)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Commander is not enabled');const scope=repository.scope(owner.roomId,repository.currentEpoch(owner.roomId),owner.player);if(path==='/owner/commander'&&req.method==='GET')return ownerCommanderView(scope,host.commander.read(owner.roomId,owner.player));try{
      if(path==='/owner/commander/messages'&&data){host.commander.sendSync(owner.roomId,owner.player,data,observation(host.load().room,owner.player,owner.roomId,host.seconds?.()));return ownerCommanderView(scope,host.commander.read(owner.roomId,owner.player));}
      if(path==='/owner/commander/confirm'&&data){protocolFields(data,['roomEpoch','proposalId','baseVersion','contentDigest']);if(protocolIdentifier(data.roomEpoch)!==scope.roomEpoch)throw new PlayerProtocolError('ROOM_EPOCH_CHANGED',409,'Confirmation belongs to an older epoch');const proposalId=protocolIdentifier(data.proposalId),version=protocolCounter(data.baseVersion);if(typeof data.contentDigest!=='string'||!/^[a-f0-9]{64}$/.test(data.contentDigest))throw new PlayerProtocolError('INVALID_REQUEST',400,'Invalid proposal digest');const proposal=ownerCommanderView(scope,host.commander.read(owner.roomId,owner.player)).proposals.find(p=>p.proposalId===proposalId);if(!proposal||proposal.baseVersion!==version||proposal.contentDigest!==data.contentDigest)throw new PlayerProtocolError('INSTRUCTIONS_CHANGED',409,'Proposal content or baseline changed; review it again','replan');host.commander.confirmSync(owner.roomId,owner.player,{proposalId,version:Number(version)},host.load().room.state.economy.tick);return{...ownerCommanderView(scope,host.commander.read(owner.roomId,owner.player)),confirmation:{proposalId,baseVersion:version,contentDigest:proposal.contentDigest,confirmedInstructionsVersion:(BigInt(version)+1n).toString()}};}
     }catch(error){if(error instanceof DomainValidationError)throw new PlayerProtocolError('INVALID_REQUEST',400,'Commander operation is not valid for the current owner thread');throw error;}}
     if(path==='/owner/grants'&&req.method==='GET')return{grants:repository.ownerGrants(owner.roomId,owner.player)};
     if(path==='/owner/grants'&&data){protocolFields(data,['grantId','tokenHash','scopes','expiresAtMs']);const grantId=protocolIdentifier(data.grantId);if(typeof data.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(data.tokenHash)||!Array.isArray(data.scopes)||!data.scopes.length||data.scopes.some(scope=>typeof scope!=='string'||!EXECUTOR_SCOPES.includes(scope as typeof EXECUTOR_SCOPES[number]))||new Set(data.scopes).size!==data.scopes.length)throw new PlayerProtocolError('INVALID_REQUEST',400,'Invalid grant specification');repository.registerGrant({grantId,roomId:owner.roomId,roomEpoch:repository.currentEpoch(owner.roomId),player:owner.player,tokenHash:data.tokenHash,scopes:data.scopes as (typeof EXECUTOR_SCOPES)[number][],expiresAtMs:protocolInteger(data.expiresAtMs,1,Number.MAX_SAFE_INTEGER)});return repository.ownerGrants(owner.roomId,owner.player).find(grant=>grant.grantId===grantId);}
     if(/^\/owner\/grants\/[A-Za-z0-9._:-]+\/revoke$/.test(path)&&data){protocolFields(data,[]);return repository.ownerRevoke(owner.roomId,owner.player,path.split('/')[3]!);}
     throw new PlayerProtocolError('INVALID_REQUEST',404,'Owner endpoint not found');
    }));host.refresh?.();res.end(JSON.stringify(value));return;
   }
   const principal=repository.authenticate(req.headers.authorization);
   if(principal.roomId!==host.roomId)throw new PlayerProtocolError('IDENTITY_MISMATCH',403,'Grant belongs to another room','authorization');
   leave=admission.enter(repository.scope(principal.roomId,principal.roomEpoch,principal.player).playerId,req.method==='POST'?'write':'read');
   const input=req.method==='POST'?await readBody(req):null;
   const scopedSerial=<T>(job:()=>T|Promise<T>)=>serial(()=>{if(principal.roomId!==host.roomId)throw new PlayerProtocolError('ROOM_EPOCH_CHANGED',409,'The active room changed','ownership');if(host.canObserve&&!host.canObserve(principal.player))throw new PlayerProtocolError('SCOPE_DENIED',403,'This seat cannot currently observe the game','authorization');return job();});
   let result:unknown;
   if((path==='/checkpoints/current'||/^\/checkpoints\/[A-Za-z0-9._:-]+$/.test(path))&&req.method==='GET'){exactQuery(url,path==='/checkpoints/current'?['checkpointId']:[]);if(!host.checkpoints)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Coordinated checkpoints are not enabled');const checkpointId=path==='/checkpoints/current'?url.searchParams.get('checkpointId')??undefined:path.split('/')[2];result=await scopedSerial(()=>host.checkpoints!.current(principal,checkpointId===undefined?undefined:protocolIdentifier(checkpointId)));
   }else if(path==='/checkpoints/ack'&&input){exactQuery(url,[]);if(!host.checkpoints)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Coordinated checkpoints are not enabled');const acknowledgement=parseProtocolCheckpointAcknowledgement(input);result=await scopedSerial(()=>host.checkpoints!.ack(principal,{...acknowledgement}));
   }else if(path==='/sessions/hello'&&input){exactQuery(url,[]);const hello=parseProtocolHello(input);if(!hello.supportedVersions.some(v=>v.major===2&&v.minor===0)||hello.requiredCapabilities.some(cap=>!capabilities().includes(cap)))throw new PlayerProtocolError('PROTOCOL_INCOMPATIBLE',409,'No compatible protocol or required capability');
    result=await scopedSerial(()=>{requireExecutorScope(principal,'observe');const negotiated=capabilities().filter(cap=>cap==='core/2'||hello.requiredCapabilities.includes(cap)||hello.optionalCapabilities.includes(cap));const sessionId=repository.createSession(principal,hello.executorInstanceId,[...negotiated]);const value:ProtocolHelloResponse={scope:repository.scope(principal.roomId,principal.roomEpoch,principal.player),identity:identity(principal),sessionId,version:PLAYER_PROTOCOL_VERSION,capabilities:[...negotiated],authorizationVersion:principal.authorizationVersion,serverTime:repository.serverTime(),limits:PLAYER_PROTOCOL_LIMITS,rulesetId:PROFILE_ID,rulesetVersion:GAMEPLAY_RULESET_VERSION,observationSchema:'player-observation/2',commandSchema:'player-command/2'};return value;});
   }else if(path==='/diplomacy/receipts'&&req.method==='GET'){
    exactQuery(url,['after','through','limit']);result=await scopedSerial(()=>{requireExecutorScope(principal,'observe');return {scope:repository.scope(principal.roomId,principal.roomEpoch,principal.player),...diplomacyCollection(host.load().room,principal.player,url.searchParams)};});
   }else if(path==='/activity'&&req.method==='GET'){
    exactQuery(url,['after','through','limit']);result=await scopedSerial(()=>{requireExecutorScope(principal,'observe');try{return {scope:repository.scope(principal.roomId,principal.roomEpoch,principal.player),...playerActivityPage(host.load().room.state,principal.player,url.searchParams)};}catch{throw new PlayerProtocolError('INVALID_REQUEST',400,'Invalid activity cursor or incomplete retained activity');}});
   }else if(path==='/tick-times'&&req.method==='GET'){
    exactQuery(url,['after','limit']);result=await scopedSerial(()=>{requireExecutorScope(principal,'observe');return {scope:repository.scope(principal.roomId,principal.roomEpoch,principal.player),...timing(url)};});
   }else if(path==='/manual-commands'&&req.method==='GET'){
    exactQuery(url,['after','limit','id']);result=await scopedSerial(()=>{requireExecutorScope(principal,'observe');return {scope:repository.scope(principal.roomId,principal.roomEpoch,principal.player),...manualCollection(host.load().room,principal.player,url.searchParams)};});
   }else if(path==='/observation'&&req.method==='GET'){
    exactQuery(url,[]);result=await scopedSerial(()=>{requireExecutorScope(principal,'observe');return {scope:repository.scope(principal.roomId,principal.roomEpoch,principal.player),observation:observation(host.load().room,principal.player,host.roomId,host.seconds?.())};});
   }else if(path==='/commander'&&req.method==='GET'){
    exactQuery(url,[]);result=await scopedSerial(()=>{requireExecutorScope(principal,'observe');if(!host.commander)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Commander is not enabled');return {scope:repository.scope(principal.roomId,principal.roomEpoch,principal.player),thread:host.commander.read(principal.roomId,principal.player)};});
   }else if(path==='/snapshot'&&req.method==='GET'){
    exactQuery(url,['snapshotId','pageToken']);if(url.searchParams.has('pageToken')&&!url.searchParams.has('snapshotId'))throw new PlayerProtocolError('INVALID_REQUEST',400,'Snapshot continuation requires snapshotId');result=await scopedSerial(()=>repository.atomic(()=>{if(url.searchParams.has('snapshotId'))return repository.readSnapshot(principal,protocolIdentifier(url.searchParams.get('snapshotId')),url.searchParams.get('pageToken')??undefined);const room=refreshObservations();return repository.snapshot(principal,host.snapshot?.(principal.player)??{observation:observation(room,principal.player,host.roomId,host.seconds?.()),instructionsVersion:host.instructionsVersion?.(principal.player)??'0',coverage:{observation:'complete',chat:'not-supported',notifications:'not-supported'}});}));
   }else if(/^\/snapshot\/[A-Za-z0-9._:-]+\/complete$/.test(path)&&input){exactQuery(url,[]);protocolFields(input,[]);result=await scopedSerial(()=>repository.completeSnapshot(principal,path.split('/')[2]!));
   }else if(path==='/sync'&&req.method==='GET'){
    exactQuery(url,['after','waitMs','sessionId']);const sessionId=url.searchParams.get('sessionId')??undefined,after=url.searchParams.get('after'),waitMs=protocolInteger(Number(url.searchParams.get('waitMs')??0),0,1000);
    const read=()=>scopedSerial(()=>repository.atomic(()=>{
      requireExecutorScope(principal,'observe');requireExecutorScope(principal,'events.read');
      if(sessionId)repository.assertReadSession(principal,{roomEpoch:principal.roomEpoch,sessionId:protocolIdentifier(sessionId),authorizationVersion:principal.authorizationVersion});
      const {room}=host.load();repository.observe(host.roomId,principal.player,observation(room,principal.player,host.roomId,host.seconds?.()).revision,room.state.economy.tick);
      // A full cut needs no retained replay history. An old cursor simply refreshes it.
      if(after)protocolIdentifier(after);
      const control=repository.control(principal,sessionId),stream=repository.stream(principal),document=after===stream.cursor?null:host.snapshot?.(principal.player)??{observation:observation(room,principal.player,host.roomId,host.seconds?.()),instructionsVersion:host.instructionsVersion?.(principal.player)??'0',coverage:{observation:'complete',chat:'not-supported',notifications:'not-supported'}};
      if(document&&Buffer.byteLength(JSON.stringify(document))>PLAYER_PROTOCOL_LIMITS.snapshotBytes)throw new PlayerProtocolError('INVALID_REQUEST',413,'Live document exceeds snapshot limit');
      return {scope:repository.scope(principal.roomId,principal.roomEpoch,principal.player),...stream,document,control};
    }));
    let cut=await read();
    if(!cut.document&&after&&waitMs){
      const abort=new AbortController(),closed=()=>abort.abort();res.once('close',closed);if(res.destroyed)abort.abort();
      try{await repository.waitForEvents(principal,after,waitMs,abort.signal);}finally{res.removeListener('close',closed);}
      cut=await read();
    }
    result=cut;
   }else if(path==='/events'&&req.method==='GET'){
    exactQuery(url,['after','limit','waitMs']);const after=url.searchParams.get('after');if(!after)throw new PlayerProtocolError('INVALID_REQUEST',400,'An exclusive event cursor is required');const limit=Number(url.searchParams.get('limit')??100),waitMs=protocolInteger(Number(url.searchParams.get('waitMs')??0),0,1000);
    let page=await scopedSerial(()=>repository.atomic(()=>{const {room}=host.load();repository.observe(host.roomId,principal.player,observation(room,principal.player,host.roomId,host.seconds?.()).revision,room.state.economy.tick);return repository.events(principal,after,limit);}));
    if(!page.events.length&&waitMs){
      const abort=new AbortController(),closed=()=>abort.abort();res.once('close',closed);if(res.destroyed)abort.abort();
      try{await repository.waitForEvents(principal,after,waitMs,abort.signal);}finally{res.removeListener('close',closed);}
      // Never hold the room's serial executor or a transaction while waiting.
      page=await scopedSerial(()=>repository.events(principal,after,limit));
    }
    result=page;
   }else if(path==='/chat/search'&&req.method==='GET'){result=await scopedSerial(()=>repository.atomic(()=>{repository.stream(principal);requireExecutorScope(principal,'observe');if(!host.chat)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Chat is not enabled');const seat=identity(principal),scope=repository.scope(principal.roomId,principal.roomEpoch,principal.player);try{const result=searchVisibleChat(host.chat().listForSeat(seat.chatPlayer),url.searchParams,seat.chatCount);return{scope,...result,nextBefore:result.nextBefore===null?null:String(result.nextBefore)};}catch{throw new PlayerProtocolError('INVALID_REQUEST',400,'Invalid authorized chat search');}}));
   }else if(['/chat','/notifications'].includes(path)&&req.method==='GET'){
    exactQuery(url,['after','limit']);result=await scopedSerial(()=>repository.atomic(()=>{repository.stream(principal);requireExecutorScope(principal,'observe');const scope=repository.scope(principal.roomId,principal.roomEpoch,principal.player),room=host.load().room,afterText=protocolCounter(url.searchParams.get('after')??'0'),limit=protocolInteger(Number(url.searchParams.get('limit')??100),1,200);let rows:unknown[],extra:Record<string,unknown>={},name:string;
     if(path==='/chat'){if(!host.chat)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Chat is not enabled');rows=host.chat().listForSeat(identity(principal).chatPlayer);name='messages';}
     else{rows=projectPlayerNotifications(room.state,principal.player).map((notice,id)=>({...notice,id}));name='notifications';}
     if(BigInt(afterText)>BigInt(rows.length))throw new PlayerProtocolError('RESYNC_REQUIRED',409,'Collection cursor is outside retained scope','resync');const after=Number(afterText),page:unknown[]=[];let bytes=2048+Buffer.byteLength(JSON.stringify(extra));for(const row of rows.slice(after,after+limit)){const size=Buffer.byteLength(JSON.stringify(row))+1;if(bytes+size>PLAYER_PROTOCOL_LIMITS.responsePageBytes)break;page.push(row);bytes+=size;}return{scope,...extra,[name]:page,nextCursor:String(after+page.length),hasMore:after+page.length<rows.length,coverage:{fromExclusive:afterText,toInclusive:String(after+page.length),retained:'complete'}};
    }));
   }else if(path==='/control'&&req.method==='GET'){exactQuery(url,['sessionId']);requireExecutorScope(principal,'observe');result=await scopedSerial(()=>({...repository.control(principal,url.searchParams.get('sessionId')??undefined),...(host.programmaticAutoAdvance?{programmaticAutoAdvance:host.programmaticAutoAdvance()}:{} )}));
   }else if(/^\/control\/(acquire|renew|release)$/.test(path)&&input){exactQuery(url,[]);const action=path.split('/')[2] as 'acquire'|'renew'|'release';protocolFields(input,['roomEpoch','sessionId','idempotencyKey',...(action==='acquire'?[]:['fence'])],action==='release'?[]:['ttlMs']);const controlInput={roomEpoch:protocolIdentifier(input.roomEpoch),sessionId:protocolIdentifier(input.sessionId),idempotencyKey:protocolIdentifier(input.idempotencyKey),...(action==='acquire'?{}:{fence:protocolCounter(input.fence)}),...(input.ttlMs===undefined?{}:{ttlMs:input.ttlMs as number})};result=await scopedSerial(()=>repository.atomic(()=>{if(host.canControl&&!host.canControl())throw new PlayerProtocolError('CONTROL_BUSY',409,'Control requires a started game','ownership');host.assertMutationAllowed?.('control-'+action,'admit');return{operationResult:repository.controlOperation(principal,action,controlInput),current:repository.control(principal,controlInput.sessionId)};}));
   }else if(path==='/commander/worker'&&input){exactQuery(url,[]);const command=parseProtocolCommander(input);if(!host.commander)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Commander is not enabled');const accepted=await scopedSerial(()=>{host.assertMutationAllowed?.(command.kind,'admit');return repository.acceptCommand(principal,command);});if(accepted.state==='accepted'){await host.afterAdmission?.(accepted);result=await scopedSerial(()=>{host.assertMutationAllowed?.(command.kind,'settle');return repository.settleCommand<ProtocolCommanderRequest>(principal,accepted.commandId,request=>{host.assertMutationAllowed?.(request.kind,'settle');if((host.instructionsVersion?.(principal.player)??'0')!==request.instructionsVersion)throw new PlayerProtocolError('INSTRUCTIONS_CHANGED',409,'Confirmed instructions changed','replan');try{host.commander!.workerSync(principal.roomId,principal.player,request.payload,host.load().room.state.economy.tick);}catch(error){if(error instanceof DomainValidationError)throw new PlayerProtocolError('INVALID_REQUEST',400,'Discussion mutation is not valid for the current authorized thread');throw error;}return{state:'applied',effects:{instructionsVersion:host.instructionsVersion?.(principal.player)??'0'}};});});}else result=accepted;
   }else if(path==='/commands/batch'&&input){
    exactQuery(url,[]);const command=parseProtocolCommand(input);if(command.kind!=='order-batch')throw new PlayerProtocolError('INVALID_REQUEST',400,'Expected an order batch');
    const accepted=await scopedSerial(()=>{requireExecutorScope(principal,'observe');host.assertMutationAllowed?.('order-batch','admit');repository.assertSessionCapability(principal,command.sessionId,'actions.batch/1');return repository.acceptCommand(principal,command);});
    let receipt=accepted;
    if(accepted.state==='accepted'){
      await host.afterAdmission?.(accepted);
      try{receipt=await scopedSerial(()=>repository.settleCommand(principal,accepted.commandId,request=>{
        host.assertMutationAllowed?.('order-batch','settle');const current=host.load();validateCommandBasis(request,observation(current.room,principal.player,host.roomId,host.seconds?.()),current.room);
        if((host.instructionsVersion?.(principal.player)??'0')!==request.instructionsVersion)throw new PlayerProtocolError('INSTRUCTIONS_CHANGED',409,'Confirmed instructions changed','replan');
        const batchReceipts:ProtocolReceipt[]=[];let stopped=false;
        for(const child of request.payload.commands as ProtocolCommandRequest[]){
          const admission=repository.acceptCommand(principal,child);
          const result=admission.state==='accepted'?repository.settleCommand(principal,admission.commandId,current=>{if(stopped)throw new PlayerProtocolError('BATCH_NOT_EXECUTED',409,'A prior batch item failed');return applyBatchChild(principal,current);}):admission;
          batchReceipts.push(result);if(!result.effectCommitted)stopped=true;
        }
        refreshObservations();return {state:'applied',effects:{batchReceipts}};
      }));}finally{host.refresh?.();}
    }
    const snapshot=await scopedSerial(()=>repository.atomic(()=>{const room=refreshObservations();return repository.snapshot(principal,host.snapshot?.(principal.player)??{observation:observation(room,principal.player,host.roomId,host.seconds?.()),instructionsVersion:host.instructionsVersion?.(principal.player)??'0',coverage:{observation:'complete',chat:'not-supported',notifications:'not-supported'}});}));
    result={receipt,snapshot};
   }else if(path==='/commands'&&input){exactQuery(url,[]);const command=parseProtocolCommand(input);if(command.kind==='order-batch')throw new PlayerProtocolError('INVALID_REQUEST',400,'Order batches require the batch endpoint');const accepted=await scopedSerial(()=>{host.assertMutationAllowed?.(command.kind,'admit');return repository.acceptCommand(principal,command,command.actionBasis===undefined?undefined:()=>{const current=host.load();validateCommandBasis(command,observation(current.room,principal.player,host.roomId,host.seconds?.()),current.room);});});
    if(accepted.state==='accepted'){
     await host.afterAdmission?.(accepted);
     try{result=await scopedSerial(()=>{host.assertMutationAllowed?.(command.kind,'settle');return repository.settleCommand(principal,accepted.commandId,request=>{
       host.assertMutationAllowed?.(request.kind,'settle');const current=host.load(),view=observation(current.room,principal.player,host.roomId,host.seconds?.());
       if(request.kind!=='readiness')host.assertCommandWindow?.(current.room.state.economy.tick);
       if(request.kind!=='readiness')validateCommandBasis(request,view,current.room);
       if(request.kind!=='readiness'&&(host.instructionsVersion?.(principal.player)??'0')!==request.instructionsVersion)throw new PlayerProtocolError('INSTRUCTIONS_CHANGED',409,'Confirmed instructions changed','replan');
       if(request.kind==='readiness'){refreshObservations();return repository.setReadiness(principal,request,current.room.state.economy.tick);}
       if(request.kind==='chat-send'||request.kind==='chat-seen'){if(!host.chat)throw new PlayerProtocolError('UNSUPPORTED_OPERATION',404,'Chat is not enabled');const seat=identity(principal);try{if(request.kind==='chat-send'){const message=host.chat().sendFromSeatSync(seat.chatPlayer,request.payload as {id:string;to:number|number[]|null;text:string},seat.chatCount,current.room.state.economy.tick);host.assertCommandWindow?.(current.room.state.economy.tick);return{state:'applied',effects:{messageId:message.id}};}host.chat().markSeenFromSeatSync(seat.chatPlayer,request.payload.conversation,request.payload.through);host.assertCommandWindow?.(current.room.state.economy.tick);return{state:'applied'};}catch(error){if(error instanceof DomainValidationError)throw new PlayerProtocolError('INVALID_REQUEST',400,'Chat mutation is not valid for the current authorized conversation');throw error;}}
       let next:ReturnType<typeof applyProtocolGameCommand>;try{next=applyProtocolGameCommand(current.room,principal.player,request,host.seconds?.());}catch(error){if(error instanceof ManualCommandConflict)throw new PlayerProtocolError('MANUAL_COMMAND_CONFLICT',409,error.message,'replan');if(error instanceof DispatchSourceLocked)throw new PlayerProtocolError(error.code,409,error.message,'replan');throw new PlayerProtocolError('INVALID_REQUEST',400,'Command is not legal for the current authorized player state');}
       host.commit(next.room,current.revision);refreshObservations();host.assertCommandWindow?.(current.room.state.economy.tick);return next.effect;
     });});}finally{host.refresh?.();}
    }else result=accepted;
   }else if(path==='/commands/lookup'&&input){exactQuery(url,[]);protocolFields(input,['roomEpoch','idempotencyKeys']);if(!Array.isArray(input.idempotencyKeys)||!input.idempotencyKeys.length||input.idempotencyKeys.length>PLAYER_PROTOCOL_LIMITS.lookupBatchSize)throw new PlayerProtocolError('INVALID_REQUEST',400,'Invalid lookup batch');const keys=input.idempotencyKeys.map(key=>protocolIdentifier(key)),epoch=protocolIdentifier(input.roomEpoch);result=await scopedSerial(()=>({scope:{...repository.scope(principal.roomId,principal.roomEpoch,principal.player),roomEpoch:epoch},results:repository.lookup(principal,epoch,keys)}));
   }else throw new PlayerProtocolError('INVALID_REQUEST',404,'Endpoint not found');
   res.end(JSON.stringify(result));
  }catch(rawError){if(rawError instanceof ManualCommandConflict){res.writeHead(409).end(JSON.stringify({code:rawError.code,category:'replan',outcome:'rejected',safeMessage:rawError.message,requestId:id,...(rawError.cancelledScheduleIds?{cancelledScheduleIds:rawError.cancelledScheduleIds,cancellationToken:rawError.cancellationToken,cancelledSchedules:rawError.cancelledSchedules}:{})}));return;}const error=rawError instanceof ProtocolValidationError||rawError instanceof DomainValidationError?new PlayerProtocolError('INVALID_REQUEST',400,'Request does not match the protocol schema'):rawError;const known=error instanceof PlayerProtocolError;if(!known||rawError instanceof ProtocolValidationError||error.status>=500)diagnostic.fail(rawError,known?error.status:503);const body:ProtocolErrorBody={code:known?error.code:'STORAGE_UNAVAILABLE',category:known?error.category:'transient',outcome:known?error.outcome:req.method==='GET'?'read-only':'unknown',safeMessage:known?error.message:'Request could not be completed; reconcile any pending command',requestId:id};res.writeHead(known?error.status:503).end(JSON.stringify(body));}finally{leave?.();}
 })().catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});const close=server.close.bind(server);server.close=(callback?: (error?:Error)=>void)=>{return close(callback);};server.maxConnections=256;server.requestTimeout=15_000;server.headersTimeout=10_000;return server;
}
