import {PlayerProtocolRepository,type ProtocolClocks} from './player-protocol-store.js';
import {sqliteTransaction} from './sqlite-transaction.js';
import {link,unlink} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {saveRoom,restoreRoom,type LabRoom} from './planning.js';
import {inheritFleetJournals} from '../../engine/src/index.js';
import type {TickTimeAnchor,TickTimeSource} from './tick-times.js';
import type {RoomClockBasis} from './realtime.js';
export type RoomMetadata=RoomClockBasis&{roomId:string};
const APPLICATION_ID=1398096455;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
/** Clone mutable world state while retaining immutable event-time journals.
 * structuredClone alone drops their WeakMap roots and forces every authorized
 * observation to replay the complete command history. Appends create new heads. */
function cloneRoom(room:LabRoom){const copy=structuredClone(room);inheritFleetJournals(room.state,copy.state);return copy;}
function freezeRoom<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freezeRoom(item);Object.freeze(value);}return value;}
// The fallback also instruments an already-running older server connection.
// It observes only committed head changes, in the very same SQLite transaction.
const tickTimeTriggers=['INSERT','UPDATE'].map(operation=>`
 CREATE TRIGGER IF NOT EXISTS tick_time_head_${operation.toLowerCase()} AFTER ${operation} ON active_room
 WHEN NOT EXISTS(SELECT 1 FROM tick_time_anchors WHERE room_id=NEW.room_id AND tick=json_extract((SELECT json_extract(payload,'$.snapshot') FROM snapshots WHERE room_id=NEW.room_id),'$.expected.economy.tick'))
 BEGIN
  INSERT INTO tick_time_anchors(room_id,revision,from_tick,tick,wall_ms,monotonic_ms,session_id,kind,source)
  SELECT NEW.room_id,NEW.revision,prior_tick,next_tick,CAST(round(unixepoch('subsec')*1000) AS INTEGER),0,'sqlite:'||lower(hex(randomblob(16))),
   CASE WHEN prior_tick IS NULL THEN 'observed' WHEN next_tick=prior_tick+1 THEN 'advance' ELSE 'batch' END,'database-trigger'
  FROM(SELECT json_extract((SELECT json_extract(payload,'$.snapshot') FROM snapshots WHERE room_id=NEW.room_id),'$.expected.economy.tick') AS next_tick,
   (SELECT tick FROM tick_time_anchors WHERE room_id=NEW.room_id ORDER BY id DESC LIMIT 1) AS prior_tick);
 END;`).join('\n');
/** Atomic room head plus append-only command/event journals. Local storage, not game rules. */
export class RoomStore {
 readonly protocol:PlayerProtocolRepository|undefined;
 private commitObservers=new Set<(room:LabRoom,revision:number,reset:boolean)=>void>();
 onCommit(observer:(room:LabRoom,revision:number,reset:boolean)=>void){this.commitObservers.add(observer);return()=>this.commitObservers.delete(observer);}
 private db:DatabaseSync;
 private sessionId=randomUUID();
 private wallNow:()=>number;
 private monotonicNow:()=>number;
 private replayCache:{key:string;payload:string;room:LabRoom}|null=null;
 private metadataCache:{cut:NonNullable<ReturnType<RoomStore['current']>>;value:RoomMetadata}|null=null;
 private generation=0;
 private currentCache:{head:string;dataVersion:number;value:{revision:number;room:LabRoom}}|null=null;
 constructor(path:string,options:{readOnly?:boolean;wallNow?:()=>number;monotonicNow?:()=>number}={}){
  this.protocol=undefined;
  this.wallNow=options.wallNow??Date.now;this.monotonicNow=options.monotonicNow??(()=>performance.now());
  this.db=new DatabaseSync(path,options);
  try{
   this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
   const app=Number(this.db.prepare('PRAGMA application_id').get()!.application_id),version=Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
   if(app!==0&&app!==APPLICATION_ID||version!==0&&version!==1)throw Error('Unsupported room database format');
   if(app===0&&this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length)throw Error('Unrecognized database');
   if(options.readOnly){if(app!==APPLICATION_ID||version!==1)throw Error('Unsupported room database format');return;}
   this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
   this.db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, profile TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots (room_id TEXT PRIMARY KEY REFERENCES rooms(id), payload TEXT NOT NULL, digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS active_room (slot INTEGER PRIMARY KEY CHECK(slot=1), room_id TEXT NOT NULL REFERENCES rooms(id), revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS commands (room_id TEXT NOT NULL REFERENCES rooms(id), ordinal INTEGER NOT NULL, command_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(room_id,ordinal), UNIQUE(room_id,command_id));
    CREATE TABLE IF NOT EXISTS events (room_id TEXT NOT NULL REFERENCES rooms(id), ordinal INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(room_id,ordinal));
    CREATE TABLE IF NOT EXISTS tick_time_anchors (id INTEGER PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id),revision INTEGER NOT NULL,from_tick INTEGER,tick INTEGER NOT NULL,wall_ms INTEGER NOT NULL,monotonic_ms REAL NOT NULL,session_id TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,UNIQUE(room_id,tick));
    CREATE INDEX IF NOT EXISTS tick_time_room ON tick_time_anchors(room_id,id);
    ${tickTimeTriggers}
    PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);
   this.protocol=new PlayerProtocolRepository(this.db,{...(options.wallNow?{wallNow:options.wallNow}:{}),...(options.monotonicNow?{elapsedNow:options.monotonicNow}:{})});
  }catch(error){this.db.close();throw error;}
 }
 /** Stable private browser cache scope, preserved across service restarts. */
 predictionSource(){const head=this.db.prepare('SELECT room_id,digest FROM active_room JOIN snapshots USING(room_id) WHERE slot=1').get();if(!head)throw Error('No active room');return {roomId:String(head.room_id),revision:String(head.digest)};}
 /** Metadata comes only from a fully verified head. Protocol heartbeats do not
  * need another mutable copy of its entire world. External writes invalidate
  * the proof even when they leave the active revision/digest untouched. */
 metadata():RoomMetadata {
  return sqliteTransaction(this.db,()=>{
   const cut=this.current();if(!cut)throw Error('No active room');
   if(this.metadataCache?.cut!==cut){
    const room=cut.room;
    const value:RoomMetadata={roomId:room.playerRoomId??this.predictionSource().roomId,state:{economy:{tick:room.state.economy.tick},...(room.state.secondsSinceLastTick===undefined?{}:{secondsSinceLastTick:room.state.secondsSinceLastTick})},...(room.clock?{clock:{...room.clock}}:{})};
    this.metadataCache={cut,value};
   }
   return structuredClone(this.metadataCache.value);
  },'read');
 }
 load(){
  return sqliteTransaction(this.db,()=>{
   const active=this.db.prepare('SELECT room_id,revision FROM active_room WHERE slot=1').get();
   if(!active)return null;
   const room=this.readRoom(String(active.room_id));
   return {revision:Number(active.revision),room};
  },'read');
 }
 /** Trusted host read. Verify a changed durable head completely, then share a
  * frozen cut across protocol readers. Mutable callers still use load(); verify()
  * always checks the actual database. External writes invalidate via data_version. */
 current(){return sqliteTransaction(this.db,()=>{
  const row=this.db.prepare('SELECT room_id,revision FROM active_room WHERE slot=1').get();
  if(!row)return null;
  const dataVersion=Number(this.db.prepare('PRAGMA data_version').get()!.data_version),head=JSON.stringify([row.room_id,row.revision,this.generation]);
  if(this.currentCache?.head!==head||this.currentCache.dataVersion!==dataVersion){
   this.currentCache={head,dataVersion,value:freezeRoom({revision:Number(row.revision),room:this.readRoom(String(row.room_id))})};
  }
  return this.currentCache.value;
 },'read');}
 private readRoom(key:string){
  const head=this.db.prepare('SELECT payload,digest FROM snapshots WHERE room_id=?').get(key);
  if(!head||typeof head.payload!=='string'||hash(head.payload)!==head.digest)throw Error('Room snapshot checksum mismatch');
  // Protocol/domain reads repeatedly load the same committed head. Reuse only
  // its verified replay, never a caller's mutable object or an unverified head.
  const cached=this.replayCache?.key===key&&this.replayCache.payload===head.payload;
  const room=cached?cloneRoom(this.replayCache!.room):restoreRoom(head.payload,{trustedLocalStorage:true,
   ...(this.replayCache?.key===key?{verifiedReplayBase:this.replayCache.room.state}:{})});
  for(const [table,values] of [['commands',room.state.commands],['events',room.state.events]] as const){
   const rows=this.db.prepare(`SELECT ordinal,payload FROM ${table} WHERE room_id=? ORDER BY ordinal`).all(key);
   if(rows.length!==values.length||rows.some((r,i)=>Number(r.ordinal)!==i||r.payload!==JSON.stringify(values[i])))throw Error('Room journal mismatch');
  }
  if(!cached)this.replayCache={key,payload:head.payload,room:cloneRoom(room)};
  return room;
 }
 verify(){return sqliteTransaction(this.db,()=>{
   const checks=this.db.prepare('PRAGMA integrity_check').all();
   if(checks.length!==1||checks[0]!.integrity_check!=='ok'||this.db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Database integrity check failed');
   const rooms=this.db.prepare('SELECT id,profile FROM rooms ORDER BY id').all();
   const result=rooms.map(row=>{const room=this.readRoom(String(row.id));if(room.state.profile!==row.profile)throw Error('Room profile mismatch');return {id:String(row.id),tick:room.state.economy.tick,commands:room.state.commands.length,events:room.state.events.length};});
   return result;
 },'read');}
 /** Host-only checkpoint reader. undefined means legacy/unmigrated; null means a missing durable document and must not fall back to stale JSON. */
 readProtocolDocument(roomId:string,domain:string,key:string):string|null|undefined{
  if(!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='protocol_epochs'").get())return undefined;
  const epoch=this.db.prepare('SELECT room_epoch FROM protocol_epochs WHERE room_id=? AND active=1').get(roomId);if(!epoch)return undefined;
  const row=this.db.prepare('SELECT payload FROM protocol_domain_documents WHERE room_epoch=? AND domain=? AND document_key=?').get(String(epoch.room_epoch),domain,key);return row?String(row.payload):null;
 }
 /** Produce and verify a consistent SQLite snapshot, then publish without overwriting. */
 async backup(destination:string){
  const target=resolve(destination),temporary=resolve(dirname(target),'.'+basename(target)+'.'+randomUUID()+'.tmp');
  try{
   this.db.prepare('VACUUM INTO ?').run(temporary);
   const check=new RoomStore(temporary,{readOnly:true});let rooms:ReturnType<RoomStore['verify']>;
   try{rooms=check.verify();}finally{check.close();}
   // A same-directory hard link publishes atomically and fails if the target exists.
   await link(temporary,target);return {path:target,rooms};
  }finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 commit(room:LabRoom,expectedRevision:number,reset=false,source:TickTimeSource='state-write'){
  return this.commitRoom(room,expectedRevision,reset,source);
 }
 /** First observation of an already-running room is partial, never backdated.
  * An existing boundary survives process restarts without being overwritten. */
 observeTick(expectedRevision:number){return sqliteTransaction(this.db,()=>{
   const active=this.db.prepare('SELECT room_id,revision FROM active_room WHERE slot=1').get();
   if(!active||Number(active.revision)!==expectedRevision)throw Error('Stale room storage revision');
   const key=String(active.room_id),head=this.db.prepare('SELECT payload,digest FROM snapshots WHERE room_id=?').get(key)!;
   if(typeof head.payload!=='string'||hash(head.payload)!==head.digest)throw Error('Room snapshot checksum mismatch');
   const tick=JSON.parse(JSON.parse(head.payload).snapshot).expected.economy.tick;
   if(!this.db.prepare('SELECT id FROM tick_time_anchors WHERE room_id=? AND tick=?').get(key,tick))this.anchor(key,expectedRevision,null,tick,'startup');
 });}
 tickTimes(after=0,limit=1000){
  if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>5000)throw Error('Invalid tick time cursor');
  return sqliteTransaction(this.db,()=>{
   const active=this.db.prepare('SELECT room_id,revision FROM active_room WHERE slot=1').get();
   if(!active)throw Error('No active room');
   const key=String(active.room_id),head=this.db.prepare('SELECT payload,digest FROM snapshots WHERE room_id=?').get(key)!;
   if(typeof head.payload!=='string'||hash(head.payload)!==head.digest)throw Error('Room snapshot checksum mismatch');
   const room=JSON.parse(head.payload),state=JSON.parse(room.snapshot).expected,headTick=state.economy.tick;
   const rows=this.db.prepare('SELECT * FROM tick_time_anchors WHERE room_id=? AND id>? ORDER BY id LIMIT ?').all(key,after,limit+1);
   const hasMore=rows.length>limit;
   const records:TickTimeAnchor[]=rows.slice(0,limit).map(r=>({id:Number(r.id),revision:Number(r.revision),fromTick:r.from_tick===null?null:Number(r.from_tick),tick:Number(r.tick),wallTimeMs:Number(r.wall_ms),monotonicMs:Number(r.monotonic_ms),sessionId:String(r.session_id),kind:r.kind as TickTimeAnchor['kind'],source:r.source as TickTimeSource}));
   const last=this.db.prepare('SELECT * FROM tick_time_anchors WHERE room_id=? ORDER BY id DESC LIMIT 1').get(key),now=this.wallNow();
   const elapsed=!last||last.kind==='observed'?null:last.session_id===this.sessionId?this.monotonicNow()-Number(last.monotonic_ms):now-Number(last.wall_ms);
   return {roomId:room.playerRoomId??key,headTick,ended:state.events.some((event:{kind:string})=>event.kind==='game-ended'),serverTimeMs:now,headElapsedMs:elapsed!==null&&elapsed>=0?elapsed:null,revision:Number(active.revision),records,nextCursor:records.at(-1)?.id??after,hasMore};
  },'read');
 }
 private anchor(key:string,revision:number,fromTick:number|null,tick:number,source:TickTimeSource){
  const wall=this.wallNow(),monotonic=this.monotonicNow();
  if(!Number.isSafeInteger(wall)||wall<0||!Number.isFinite(monotonic)||monotonic<0)throw Error('Invalid tick anchor clock');
  const kind=fromTick===null?'observed':tick===fromTick+1?'advance':'batch';
  this.db.prepare('INSERT INTO tick_time_anchors(room_id,revision,from_tick,tick,wall_ms,monotonic_ms,session_id,kind,source) VALUES(?,?,?,?,?,?,?,?,?)').run(key,revision,fromTick,tick,wall,monotonic,this.sessionId,kind,source);
 }
 private commitRoom(room:LabRoom,expectedRevision:number,reset:boolean,source:TickTimeSource='state-write'){
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error('Invalid storage revision');
  const payload=saveRoom(room,{trustedLocalStorage:true});
  return sqliteTransaction(this.db,()=>{
   const head=this.db.prepare('SELECT room_id,revision FROM active_room WHERE slot=1').get();
   const revision=head?Number(head.revision):0;
   if(revision!==expectedRevision)throw Error('Stale room storage revision');
   let previousTick:number|null=null;
   if(head&&!reset){
    const previous=this.db.prepare('SELECT payload,digest FROM snapshots WHERE room_id=?').get(String(head.room_id));
    if(!previous||typeof previous.payload!=='string'||hash(previous.payload)!==previous.digest)throw Error('Room snapshot checksum mismatch');
    const old=JSON.parse(previous.payload);
    previousTick=JSON.parse(old.snapshot).expected.economy.tick;
    if(room.state.economy.tick<previousTick!)throw Error('Historical tick rewind requires reset');
    const previousInitial=JSON.parse(old.snapshot).replay.initial,nextInitial={...room.state.initial};
    if(JSON.stringify(previousInitial)!==JSON.stringify(nextInitial)||old.playerRoomId!==room.playerRoomId)throw Error('Room identity change requires reset');
   }
   const key=!head||reset?randomUUID():String(head.room_id);
   if(!head||reset)this.db.prepare('INSERT INTO rooms(id,profile) VALUES (?,?)').run(key,room.state.profile);
   this.journal('commands',key,room.state.commands.map(c=>({id:c.id,payload:JSON.stringify(c)})));
   this.journal('events',key,room.state.events.map(e=>({payload:JSON.stringify(e)})));
   this.db.prepare('INSERT INTO snapshots(room_id,payload,digest) VALUES (?,?,?) ON CONFLICT(room_id) DO UPDATE SET payload=excluded.payload,digest=excluded.digest').run(key,payload,hash(payload));
   if(previousTick===null||room.state.economy.tick!==previousTick)this.anchor(key,revision+1,previousTick,room.state.economy.tick,source);
   this.db.prepare('INSERT INTO active_room(slot,room_id,revision) VALUES (1,?,?) ON CONFLICT(slot) DO UPDATE SET room_id=excluded.room_id,revision=excluded.revision').run(key,revision+1);
   // A rolled-back write must still invalidate cached identities at this revision.
   this.generation++;
   for(const observer of this.commitObservers)observer(room,revision+1,reset);
   return revision+1;
  });
 }
 private journal(table:'commands'|'events',key:string,values:{id?:string;payload:string}[]){
  const rows=this.db.prepare(`SELECT ordinal,payload FROM ${table} WHERE room_id=? ORDER BY ordinal`).all(key);
  if(rows.length>values.length||rows.some((r,i)=>Number(r.ordinal)!==i||r.payload!==values[i]!.payload))throw Error('Historical journal mutation requires a new room');
  const insert=this.db.prepare(table==='commands'?'INSERT INTO commands(room_id,ordinal,command_id,payload) VALUES (?,?,?,?)':'INSERT INTO events(room_id,ordinal,payload) VALUES (?,?,?)');
  for(let i=rows.length;i<values.length;i++){const v=values[i]!;if(table==='commands')insert.run(key,i,v.id!,v.payload);else insert.run(key,i,v.payload);}
 }
 close(){this.db.close();}
}
