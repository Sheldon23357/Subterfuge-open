import {PlayerProtocolRepository,type ProtocolClocks} from './player-protocol-store.js';
import {saveNotificationCheckpoint,restoreNotificationCheckpoint} from '../../engine/src/index.js';
import {sqliteTransaction} from './sqlite-transaction.js';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import type {TickTimeAnchor,TickTimePage} from '../../contracts/src/index.js';
import {fleetMatchOutcome,submitFleetOrder} from '../../engine/src/index.js';
import {restoreWaitingLobby,saveWaitingLobby,type WaitingLobby} from './waiting-lobby.js';
import {prepareLobbyStart,restoreLobbyStart,type StoredLobbyStart} from './lobby-start.js';
import {saveRoom,restoreRoom,advanceRoom,type LabRoom} from './planning.js';
import {createLobbyRuntime,advanceLobbyRuntime,saveLobbyRuntime,restoreLobbyRuntime,type LobbyRuntime} from './lobby-runtime.js';
import {recallWaitingFleets} from './waiting-recall.js';
import {realtimeSeconds} from './realtime.js';
import {freezeSnapshot,inheritRoomJournals} from './immutable-room.js';
const APPLICATION_ID=1398096456;
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
interface LobbySnapshot {
 revision:number;lobby:WaitingLobby;waitingRoom?:LabRoom;start?:StoredLobbyStart;runtime?:LobbyRuntime;
}
/** Separate development database: does not migrate or touch the active game DB. */
export class LobbyStore {
 recoveredFromCheckpoint=false;
 private checkpointTick=-1;
 private checkpointRevision=-1;
 private checkpointAttempted=false;
 private timingSession=randomUUID();
 private wallNow:()=>number;
 private elapsedNow:()=>number;
 private protocolValue:PlayerProtocolRepository|undefined;
 get protocol(){if(!this.protocolValue)throw Error('Read-only audit has no protocol authority');return this.protocolValue;}
 private commitObservers=new Set<(snapshot:NonNullable<ReturnType<LobbyStore["load"]>>)=>void>();
 onCommit(observer:(snapshot:NonNullable<ReturnType<LobbyStore["load"]>>)=>void){this.commitObservers.add(observer);return()=>this.commitObservers.delete(observer);}
 private notifyCommitted(){this.checkpoint();if(this.commitObservers.size){const snapshot=this.current()!;for(const observer of this.commitObservers)observer(snapshot);}}
 private db:DatabaseSync;
 private generation=0;
 private currentCache:{head:string;dataVersion:number;value:LobbySnapshot}|null=null;
 private startCache:{payload:string;value:StoredLobbyStart}|null=null;
 private waitingCache:{payload:string;value:LabRoom}|null=null;
 private runtimeCache:{payload:string;roomPayload:string;start:StoredLobbyStart;revision:number;value:LobbyRuntime}|null=null;
 constructor(path:string,protocolClocks:ProtocolClocks={},private recovery?:{buildId:string;auditOnly?:boolean}){
  this.wallNow=protocolClocks.wallNow??Date.now;
  this.elapsedNow=protocolClocks.elapsedNow??(()=>performance.now());
  this.db=new DatabaseSync(path,{readOnly:recovery?.auditOnly??false});
  try{
   const app=Number(this.db.prepare('PRAGMA application_id').get()!.application_id),version=Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
   if(app!==0&&app!==APPLICATION_ID||app===APPLICATION_ID&&version!==4||app===0&&version!==0)throw Error('Unsupported lobby database');
   if(app===0&&this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length)throw Error('Unrecognized lobby database');
   if(recovery?.auditOnly){
    if(app!==APPLICATION_ID)throw Error('Audit requires an initialized lobby database');
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
   }else{
   this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS lobby_recovery_checkpoint(slot INTEGER PRIMARY KEY CHECK(slot=1),build_id TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lobby_turn_ready(player INTEGER PRIMARY KEY,tick INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lobby_hub_claims(claim_hash TEXT PRIMARY KEY,seat INTEGER NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS lobby_tick_times(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,from_tick INTEGER,tick INTEGER NOT NULL UNIQUE,wall_ms INTEGER NOT NULL,monotonic_ms REAL NOT NULL,session_id TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lobby_bot_links(seat INTEGER PRIMARY KEY,link_id TEXT NOT NULL,name TEXT NOT NULL,model TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lobby_head(slot INTEGER PRIMARY KEY CHECK(slot=1),revision INTEGER NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lobby_start(slot INTEGER PRIMARY KEY CHECK(slot=1),payload TEXT NOT NULL,digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lobby_runtime(slot INTEGER PRIMARY KEY CHECK(slot=1),payload TEXT NOT NULL,digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lobby_waiting_world(slot INTEGER PRIMARY KEY CHECK(slot=1),payload TEXT NOT NULL,digest TEXT NOT NULL);
    PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=4; COMMIT;`);
   this.protocolValue=new PlayerProtocolRepository(this.db,protocolClocks);
   }
  }catch(e){this.db.close();throw e;}
 }
 hubClaims(){return this.db.prepare('SELECT claim_hash,seat FROM lobby_hub_claims').all().map(row=>({hash:String(row.claim_hash),seat:Number(row.seat)}));}
 claimHubSeat(hash:string,seat:number){this.db.prepare('INSERT INTO lobby_hub_claims(claim_hash,seat) VALUES(?,?)').run(hash,seat);}
 hubBotLinks(now=Date.now()):import('../../contracts/src/index.js').HubBotLink[]{return this.db.prepare('SELECT seat,name,model,expires_at FROM lobby_bot_links WHERE expires_at>?').all(now).map(row=>({seat:Number(row.seat),name:String(row.name),model:String(row.model),expiresAt:Number(row.expires_at)}));}
 linkHubBot(seat:number,id:string,name:string,now=Date.now(),model='未提供模型'){
  const result=this.db.prepare('INSERT INTO lobby_bot_links(seat,link_id,name,model,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(seat) DO UPDATE SET link_id=excluded.link_id,name=excluded.name,model=excluded.model,expires_at=excluded.expires_at WHERE lobby_bot_links.link_id=excluded.link_id OR lobby_bot_links.expires_at<=?').run(seat,id,name,model,now+30000,now);
  if(result.changes!==1)throw Error('该席位已连接另一个 bot，请先断开。');
 }
 unlinkHubBot(seat:number,id:string){this.db.prepare('DELETE FROM lobby_bot_links WHERE seat=? AND link_id=?').run(seat,id);}
 /** Share a verified immutable cut. A local write counter survives rollback;
  * external writes invalidate through data_version, without reading large rows. */
 current():LobbySnapshot|null{
  return sqliteTransaction(this.db,()=>{
   const row=this.db.prepare('SELECT revision FROM lobby_head WHERE slot=1').get();
   if(!row)return null;
   const dataVersion=Number(this.db.prepare('PRAGMA data_version').get()!.data_version),head=JSON.stringify([row.revision,this.generation]);
   if(this.currentCache?.head!==head||this.currentCache.dataVersion!==dataVersion){
    if(this.currentCache&&this.currentCache.dataVersion!==dataVersion)this.runtimeCache=null;
    const value=this.readVerified()!;
    this.currentCache={head,dataVersion,value:freezeSnapshot(value)};
   }
   return this.currentCache.value;
  },'read');
 }
 /** Preserve the mutable load contract without exposing cached identities. */
 load():LobbySnapshot|null{
  const value=this.current();if(!value)return null;
  const copy=structuredClone(value);
  inheritRoomJournals(value.waitingRoom,copy.waitingRoom);
  inheritRoomJournals(value.start?.prepared.room,copy.start?.prepared.room);
  inheritRoomJournals(value.runtime?.room,copy.runtime?.room);
  return copy;
 }
 /** Explicit audit always rechecks stored snapshots, independently of caches. */
 verify(){return sqliteTransaction(this.db,()=>{
  const checks=this.db.prepare('PRAGMA integrity_check').all();
  if(checks.length!==1||checks[0]!.integrity_check!=='ok'||this.db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Lobby database integrity check failed');
  return this.readVerified(true);
 },'read');}
 private readVerified(audit=false):LobbySnapshot|null{
  const row=this.db.prepare('SELECT h.revision,h.payload,h.digest,s.payload AS start_payload,s.digest AS start_digest,r.payload AS runtime_payload,r.digest AS runtime_digest,w.payload AS waiting_payload,w.digest AS waiting_digest FROM lobby_head h LEFT JOIN lobby_start s ON s.slot=h.slot LEFT JOIN lobby_runtime r ON r.slot=h.slot LEFT JOIN lobby_waiting_world w ON w.slot=h.slot WHERE h.slot=1').get();if(!row)return null;
  if(typeof row.payload!=='string'||digest(row.payload)!==row.digest)throw Error('Lobby checksum mismatch');
  if(!Number.isSafeInteger(Number(row.revision))||Number(row.revision)<1)throw Error('Invalid stored lobby revision');
  if(!audit&&!this.checkpointAttempted){this.checkpointAttempted=true;this.restoreCheckpoint(row);}
  const lobby=restoreWaitingLobby(row.payload);let start:StoredLobbyStart|undefined;
  if(row.start_payload!==null){
   if(typeof row.start_payload!=='string'||digest(row.start_payload)!==row.start_digest)throw Error('Lobby start checksum mismatch');
   if(!audit&&this.startCache?.payload===row.start_payload)start=this.startCache.value;
   else{start=freezeSnapshot(restoreLobbyStart(row.start_payload));this.startCache={payload:row.start_payload,value:start};}
   if(start.prepared.sourceLobby!==row.payload)throw Error('Start membership mismatch');
  }
  let runtime:LobbyRuntime|undefined;
  if(start){
   if(typeof row.runtime_payload!=='string'||digest(row.runtime_payload)!==row.runtime_digest)throw Error('Lobby runtime checksum mismatch');
   if(!audit&&this.runtimeCache?.payload===row.runtime_payload&&this.runtimeCache.start===start)runtime=this.runtimeCache.value;
   else{
    const prior=!audit&&this.runtimeCache?.start===start&&Number(row.revision)>this.runtimeCache.revision?this.runtimeCache:undefined;
    runtime=freezeSnapshot(restoreLobbyRuntime(row.runtime_payload,start,prior?{verifiedReplayBase:prior.value.room.state,verifiedRoom:{payload:prior.roomPayload,room:prior.value.room}}:{}));
    this.runtimeCache={payload:row.runtime_payload,roomPayload:String(JSON.parse(row.runtime_payload).room),start,revision:Number(row.revision),value:runtime};
   }
  }else if(row.runtime_payload!==null)throw Error('Runtime without lobby start');
  let waitingRoom:LabRoom|undefined;
  if(row.waiting_payload!==null){
   if(typeof row.waiting_payload!=='string'||digest(row.waiting_payload)!==row.waiting_digest)throw Error('Waiting world checksum mismatch');
   if(!audit&&this.waitingCache?.payload===row.waiting_payload)waitingRoom=this.waitingCache.value;
   else{waitingRoom=freezeSnapshot(restoreRoom(row.waiting_payload,{trustedLocalStorage:true}));this.waitingCache={payload:row.waiting_payload,value:waitingRoom};}
   if(waitingRoom.playerRoomId!==lobby.access.roomId||waitingRoom.state.economy.players.length!==lobby.seats.length||waitingRoom.clock||waitingRoom.state.economy.tick!==0)throw Error('Waiting world identity mismatch');
   if(start&&start.sourceRoom!==row.waiting_payload)throw Error('Start waiting world mismatch');
  }
  return{revision:Number(row.revision),lobby,...(waitingRoom?{waitingRoom}:{}),...(start?{start,runtime:runtime!}:{})};
 }
 commit(lobby:WaitingLobby,expectedRevision:number,waitingRoom?:LabRoom){
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision===Number.MAX_SAFE_INTEGER)throw Error('Invalid lobby revision');
  const payload=saveWaitingLobby(lobby);restoreWaitingLobby(payload);
  return sqliteTransaction(this.db,()=>{
   const previous=this.current();if((previous?.revision??0)!==expectedRevision)throw Error('Stale lobby revision');
   if(previous?.start)throw Error('Lobby has already started');
   if(waitingRoom&&previous)throw Error('Waiting world is already initialized');
   if(previous&&(JSON.stringify(previous.lobby.access)!==JSON.stringify(lobby.access)||previous.lobby.commands.length>lobby.commands.length||previous.lobby.commands.some((c,i)=>JSON.stringify(c)!==JSON.stringify(lobby.commands[i]))))throw Error('Lobby identity or history changed');
   if(previous?.waitingRoom){
    let world=previous.waitingRoom;
    for(const command of lobby.commands.slice(previous.lobby.commands.length))if(command.kind==='leave')world=recallWaitingFleets(world,command.player,command.id);
    if(world!==previous.waitingRoom){const data=saveRoom(world,{trustedLocalStorage:true});this.db.prepare('UPDATE lobby_waiting_world SET payload=?,digest=? WHERE slot=1').run(data,digest(data));}
   }
   const revision=expectedRevision+1;
   this.db.prepare('INSERT INTO lobby_head(slot,revision,payload,digest) VALUES(1,?,?,?) ON CONFLICT(slot) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,digest=excluded.digest').run(revision,payload,digest(payload));
   if(waitingRoom){
    const world=saveRoom(waitingRoom,{trustedLocalStorage:true});
    this.db.prepare('INSERT INTO lobby_waiting_world(slot,payload,digest) VALUES(1,?,?)').run(world,digest(world));
   }
   this.generation++;
   this.current();
   this.notifyCommitted();return revision;
  });
 }
 /** All start artifacts and the membership revision commit in one SQLite tx.
  * The waiting world supplied by the host is captured and validated privately.
  * A caller must never publish prepared credentials before this returns.
  */
 commitStart(room:LabRoom,command:{id:string;player:number;seed:number;startedAtMs:number},expectedRevision:number){
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision===Number.MAX_SAFE_INTEGER||command.player!==0||typeof command.id!=='string'||!command.id.length||command.id.length>128||!Number.isSafeInteger(command.startedAtMs)||command.startedAtMs<0)throw Error('Invalid start command');
  const sourceRoom=saveRoom(room,{trustedLocalStorage:true});
  return sqliteTransaction(this.db,()=>{
   const current=this.current();if(!current)throw Error('Lobby unavailable');
   if(current.waitingRoom&&saveRoom(current.waitingRoom,{trustedLocalStorage:true})!==sourceRoom)throw Error('Waiting world changed');
   if(current.start){
    if(current.start.id!==command.id||current.start.seed!==command.seed||current.start.sourceRoom!==sourceRoom)throw Error('Lobby has already started');
    return current.revision;
   }
   if(current.revision!==expectedRevision)throw Error('Stale lobby revision');
   const prepared=prepareLobbyStart(current.lobby,command.player,command.seed,room);
   const record:StoredLobbyStart={format:'stored-lobby-start/1',id:command.id,seed:command.seed,startedAtMs:command.startedAtMs,sourceRoom,prepared};
   const payload=JSON.stringify(record);restoreLobbyStart(payload);
   this.db.prepare('INSERT INTO lobby_start(slot,payload,digest) VALUES(1,?,?)').run(payload,digest(payload));
   const runtime=saveLobbyRuntime(createLobbyRuntime(record));
   this.db.prepare('INSERT INTO lobby_runtime(slot,payload,digest) VALUES(1,?,?)').run(runtime,digest(runtime));
   this.db.prepare('UPDATE lobby_head SET revision=? WHERE slot=1').run(current.revision+1);
   this.generation++;
   this.notifyCommitted();return current.revision+1;
  });
 }
 /** Advance outside the write transaction; CAS prevents a yielded catch-up
  * from overwriting a concurrent command/time commit. Caller may retry fresh.
  */
 async sync(now:number,expectedRevision:number){
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision===Number.MAX_SAFE_INTEGER)throw Error('Invalid lobby revision');
  const current=this.current();if(!current?.start||!current.runtime)throw Error('Lobby has not started');
  if(current.revision!==expectedRevision)throw Error('Stale lobby revision');
  const next=await advanceLobbyRuntime(current.start,current.runtime,now);
  const prior=this.runtimeCache?.value.room===current.runtime.room?{payload:this.runtimeCache.roomPayload,room:current.runtime.room}:undefined;
  const payload=next===current.runtime?null:saveLobbyRuntime(next,prior);
  const verified=payload===null?null:freezeSnapshot(restoreLobbyRuntime(payload,current.start,{verifiedReplayBase:current.runtime.room.state,...(prior?{verifiedRoom:prior}:{})}));
  return sqliteTransaction(this.db,()=>{
   const revision=Number(this.db.prepare('SELECT revision FROM lobby_head WHERE slot=1').get()!.revision);
   if(revision!==expectedRevision)throw Error('Stale lobby revision');
   if(payload===null){return revision;}
   this.db.prepare('UPDATE lobby_runtime SET payload=?,digest=? WHERE slot=1').run(payload,digest(payload));
   this.db.prepare('UPDATE lobby_head SET revision=? WHERE slot=1').run(revision+1);
   this.recordTick(verified!,revision+1,verified!.room.timing?.mode==='turn-based'?'automatic':'realtime');
   this.generation++;
   this.runtimeCache={payload,roomPayload:String(JSON.parse(payload).room),start:current.start!,revision:revision+1,value:verified!};
   this.notifyCommitted();return revision+1;
  });
 }
 turnPlayers(){
  const current=this.current();if(!current?.runtime||current.runtime.room.timing?.mode!=='turn-based')throw Error('Not a turn-based game');
  const room=current.runtime.room,tick=room.state.economy.tick,agents=this.protocol.readyPlayers(current.lobby.access.roomId,tick);
  const manual=new Set(this.db.prepare('SELECT player FROM lobby_turn_ready WHERE tick=?').all(tick).map(row=>Number(row.player)));
  return {tick,players:room.state.economy.players.flatMap((seat,player)=>{if(!seat.active)return [];const bot=agents.find(a=>a.player===player);return [{player,automated:bot?.controlled??false,ready:bot?.controlled?bot.ready:manual.has(player)}];})};
 }
 setTurnReady(player:number,tick:number,ready:boolean){return sqliteTransaction(this.db,()=>{
  const current=this.current();if(!current?.runtime||current.runtime.status!=='in-progress'||current.runtime.room.timing?.mode!=='turn-based'||current.runtime.room.state.economy.tick!==tick||!Number.isInteger(player)||!current.runtime.room.state.economy.players[player]?.active)throw Error('Invalid turn readiness');
  if(this.turnPlayers().players.find(p=>p.player===player)?.automated)throw Error('AI controls this seat');
  if(ready)this.db.prepare('INSERT INTO lobby_turn_ready(player,tick) VALUES(?,?) ON CONFLICT(player) DO UPDATE SET tick=excluded.tick').run(player,tick);
  else this.db.prepare('DELETE FROM lobby_turn_ready WHERE player=?').run(player);
 });}
 advanceTurn(now:number){if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid wall time');return sqliteTransaction(this.db,()=>{
  const current=this.current();if(!current?.runtime||!current.start||current.runtime.status!=='in-progress'||current.runtime.room.timing?.mode!=='turn-based')return false;
  const {tick,players}=this.turnPlayers();if(!players.length||players.some(p=>!p.ready))return false;
  let room=current.runtime.room;
  for(const {player}of players)if(room.state.activity)room={...room,state:submitFleetOrder(room.state,{id:`turn-checkin-${tick}-${player}`,player,action:{kind:'check-in'}}).state};
  room=advanceRoom(room,tick+1);
  const runtime:LobbyRuntime={...current.runtime,room,status:fleetMatchOutcome(room.state)?'ended':'in-progress',syncedAtMs:Math.max(current.runtime.syncedAtMs,current.start.startedAtMs+Math.floor((now-current.start.startedAtMs)/1000)*1000)};
  const payload=saveLobbyRuntime(runtime),verified=freezeSnapshot(restoreLobbyRuntime(payload,current.start,{verifiedReplayBase:current.runtime.room.state}));
  this.db.prepare('UPDATE lobby_runtime SET payload=?,digest=? WHERE slot=1').run(payload,digest(payload));this.db.prepare('UPDATE lobby_head SET revision=? WHERE slot=1').run(current.revision+1);this.db.exec('DELETE FROM lobby_turn_ready');
  this.recordTick(verified,current.revision+1,'automatic');this.generation++;this.runtimeCache={payload,roomPayload:String(JSON.parse(payload).room),start:current.start,revision:current.revision+1,value:verified};this.notifyCommitted();return true;
 });}
 /** Commit a player API result at the already-synchronized logical time. */
 commitRoom(room:LabRoom,expectedRevision:number){
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision===Number.MAX_SAFE_INTEGER)throw Error('Invalid lobby revision');
  return sqliteTransaction(this.db,()=>{
   const current=this.current();if(!current||current.revision!==expectedRevision)throw Error('Stale lobby revision');
   if(!current.start){
    const previous=current.waitingRoom;if(!previous||current.lobby.status!=='waiting'||room.clock||room.state.economy.tick!==0||(room.state.secondsSinceLastTick??0)!==0)throw Error('Invalid waiting command');
    if(room.playerRoomId!==previous.playerRoomId||JSON.stringify(room.state.initial)!==JSON.stringify(previous.state.initial)||JSON.stringify(room.map)!==JSON.stringify(previous.map))throw Error('Waiting identity changed');
    if(room.state.commands.length<previous.state.commands.length||previous.state.commands.some((c,i)=>JSON.stringify(c)!==JSON.stringify(room.state.commands[i])))throw Error('Command history changed');
    const payload=saveRoom(room,{trustedLocalStorage:true});restoreRoom(payload,{trustedLocalStorage:true});
    this.db.prepare('UPDATE lobby_waiting_world SET payload=?,digest=? WHERE slot=1').run(payload,digest(payload));
    this.db.prepare('UPDATE lobby_head SET revision=? WHERE slot=1').run(expectedRevision+1);
    this.generation++;
    this.notifyCommitted();return expectedRevision+1;
   }
   if(!current.runtime)throw Error('Missing runtime');
   const previous=current.runtime.room;
   if(JSON.stringify(room.timing)!==JSON.stringify(previous.timing))throw Error('Room timing changed');
   if(current.runtime.status==='ended'||room.state.economy.tick!==previous.state.economy.tick)throw Error('Game is not accepting commands');
   if(room.state.commands.length<previous.state.commands.length||previous.state.commands.some((c,i)=>JSON.stringify(c)!==JSON.stringify(room.state.commands[i])))throw Error('Command history changed');
   const phase=current.runtime.status==='starting'?0:realtimeSeconds(previous,current.runtime.syncedAtMs);
   if((room.state.secondsSinceLastTick??0)>phase)throw Error('Command time exceeds synchronized time');
   for(const command of room.state.commands.slice(previous.state.commands.length))if(!['check-in','cancel-inactivity-warning'].includes(command.action.kind))this.db.prepare('DELETE FROM lobby_turn_ready WHERE player=?').run(command.player);
   const next:LobbyRuntime={...current.runtime,status:current.runtime.status==='starting'?'starting':fleetMatchOutcome(room.state)?'ended':'in-progress',room};
   if(next.status==='ended'&&room.timing?.mode==='turn-based')next.syncedAtMs=Math.max(next.syncedAtMs,current.start.startedAtMs+Math.floor((this.wallNow()-current.start.startedAtMs)/1000)*1000);
   const payload=saveLobbyRuntime(next),verified=freezeSnapshot(restoreLobbyRuntime(payload,current.start,{verifiedReplayBase:current.runtime.room.state}));
   this.db.prepare('UPDATE lobby_runtime SET payload=?,digest=? WHERE slot=1').run(payload,digest(payload));
   this.db.prepare('UPDATE lobby_head SET revision=? WHERE slot=1').run(expectedRevision+1);
   this.generation++;
   this.runtimeCache={payload,roomPayload:String(JSON.parse(payload).room),start:current.start,revision:expectedRevision+1,value:verified};
   this.notifyCommitted();return expectedRevision+1;
  });
 }
 private recordTick(runtime:LobbyRuntime,revision:number,source:'realtime'|'startup'|'automatic'){
  if(runtime.status==='starting')return;
  const tick=runtime.room.state.economy.tick;
  if(this.db.prepare('SELECT id FROM lobby_tick_times WHERE tick=?').get(tick))return;
  const prior=this.db.prepare('SELECT tick FROM lobby_tick_times ORDER BY id DESC LIMIT 1').get();
  const from=prior?Number(prior.tick):null,kind=from===null?'observed':tick===from+1?'advance':'batch';
  const wall=this.wallNow(),mono=this.elapsedNow();
  if(!Number.isSafeInteger(wall)||wall<0||!Number.isFinite(mono)||mono<0)throw Error('Invalid tick timing clock');
  this.db.prepare('INSERT INTO lobby_tick_times(revision,from_tick,tick,wall_ms,monotonic_ms,session_id,kind,source) VALUES(?,?,?,?,?,?,?,?)').run(revision,from,tick,wall,mono,this.timingSession,kind,source);
 }
 observeTick(){return sqliteTransaction(this.db,()=>{const current=this.current();if(current?.runtime)this.recordTick(current.runtime,current.revision,'startup');});}
 tickTimes(after=0,limit=1000):TickTimePage{
  if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>1000)throw Error('Invalid tick time cursor');
  return sqliteTransaction(this.db,()=>{
   const current=this.current();if(!current)throw Error('Lobby unavailable');
   const rows=this.db.prepare('SELECT * FROM lobby_tick_times WHERE id>? ORDER BY id LIMIT ?').all(after,limit+1);
   const records:TickTimeAnchor[]=rows.slice(0,limit).map(r=>({id:Number(r.id),revision:Number(r.revision),fromTick:r.from_tick===null?null:Number(r.from_tick),tick:Number(r.tick),wallTimeMs:Number(r.wall_ms),monotonicMs:Number(r.monotonic_ms),sessionId:String(r.session_id),kind:r.kind as TickTimeAnchor['kind'],source:r.source as TickTimeAnchor['source']}));
   const last=this.db.prepare('SELECT * FROM lobby_tick_times ORDER BY id DESC LIMIT 1').get();
   const now=this.wallNow(),elapsed=!last||last.kind==='observed'?null:last.session_id===this.timingSession?this.elapsedNow()-Number(last.monotonic_ms):now-Number(last.wall_ms);
   return {roomId:current.lobby.access.roomId,headTick:current.runtime?.room.state.economy.tick??0,ended:current.runtime?.status==='ended',serverTimeMs:now,headElapsedMs:elapsed!==null&&elapsed>=0?elapsed:null,records,nextCursor:records.at(-1)?.id??after,hasMore:rows.length>limit};
  });
 }
 /** Persist only an already verified immutable cut. Runtime writes between cuts replay from this prefix. */
 checkpoint(force=false){
  if(!this.recovery||this.recovery.auditOnly)return;
  const value=this.current();if(!value||value.revision===this.checkpointRevision)return;
  const tick=value.runtime?.room.state.economy.tick??0;
  if(!force&&value.runtime?.status==='in-progress'&&this.checkpointTick>=0&&tick-this.checkpointTick<60)return;
  const row=this.db.prepare('SELECT h.digest AS head,s.digest AS start,w.digest AS waiting,r.digest AS runtime FROM lobby_head h LEFT JOIN lobby_start s ON s.slot=h.slot LEFT JOIN lobby_waiting_world w ON w.slot=h.slot LEFT JOIN lobby_runtime r ON r.slot=h.slot WHERE h.slot=1').get()!;
  const journal=(room:LabRoom|undefined)=>room?saveNotificationCheckpoint(room.state):null;
  const payload=JSON.stringify({format:'lobby-recovery/1',source:row,value,journals:{waiting:journal(value.waitingRoom),start:journal(value.start?.prepared.room),runtime:journal(value.runtime?.room)}});
  this.db.prepare('INSERT INTO lobby_recovery_checkpoint(slot,build_id,payload,digest) VALUES(1,?,?,?) ON CONFLICT(slot) DO UPDATE SET build_id=excluded.build_id,payload=excluded.payload,digest=excluded.digest').run(this.recovery.buildId,payload,digest(payload));
  this.checkpointTick=tick;this.checkpointRevision=value.revision;
 }
 private restoreCheckpoint(row:Record<string,unknown>){
  if(!this.recovery)return;
  const checkpoint=this.db.prepare('SELECT * FROM lobby_recovery_checkpoint WHERE slot=1').get();
  if(!checkpoint||checkpoint.build_id!==this.recovery.buildId||typeof checkpoint.payload!=='string'||digest(checkpoint.payload)!==checkpoint.digest)return;
  try{
   const raw=JSON.parse(checkpoint.payload),value=raw.value as LobbySnapshot;
   if(raw.format!=='lobby-recovery/1'||raw.source.head!==row.digest||raw.source.start!==row.start_digest||raw.source.waiting!==row.waiting_digest||value.revision>Number(row.revision))return;
   if(digest(saveWaitingLobby(value.lobby))!==raw.source.head||value.start&&digest(JSON.stringify(value.start))!==raw.source.start||value.waitingRoom&&digest(saveRoom(value.waitingRoom,{trustedLocalStorage:true}))!==raw.source.waiting)throw Error('Recovery source checksum mismatch');
   const attach=(room:LabRoom|undefined,journal:ReturnType<typeof saveNotificationCheckpoint>|null)=>{if(room){if(!journal)throw Error('Missing recovery journal');restoreNotificationCheckpoint(room.state,journal);}};
   attach(value.waitingRoom,raw.journals.waiting);attach(value.start?.prepared.room,raw.journals.start);attach(value.runtime?.room,raw.journals.runtime);
   if(value.start){if(typeof row.start_payload!=='string')return;this.startCache={payload:row.start_payload,value:freezeSnapshot(value.start)};}
   if(value.waitingRoom){if(typeof row.waiting_payload!=='string')return;this.waitingCache={payload:row.waiting_payload,value:freezeSnapshot(value.waitingRoom)};}
   if(value.runtime&&value.start){
    const payload=saveLobbyRuntime(value.runtime);if(digest(payload)!==raw.source.runtime)throw Error('Recovery runtime checksum mismatch');
    this.runtimeCache={payload,roomPayload:String(JSON.parse(payload).room),start:this.startCache!.value,revision:value.revision,value:freezeSnapshot(value.runtime)};
   }
   this.checkpointTick=value.runtime?.room.state.economy.tick??0;this.checkpointRevision=value.revision;this.recoveredFromCheckpoint=true;
  }catch{this.startCache=null;this.waitingCache=null;this.runtimeCache=null;}
 }
 close(checkpoint=true){try{if(checkpoint)this.checkpoint(true);}finally{this.db.close();}}
}
