import {DatabaseSync} from 'node:sqlite';
import {sqliteTransaction} from './sqlite-transaction.js';
import {createHash} from 'node:crypto';
import type {ForecastNotificationEntry} from '../../engine/src/index.js';
import {TICK_MILLISECONDS} from './realtime.js';
const APP=1398096457;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function identities(entries:readonly ForecastNotificationEntry[]){
 const occurrences=new Map<string,number>();
 return entries.filter(e=>e.notification.sendNotification).map(entry=>{
  const {minutesBeforeSending,generateAlert,...semantic}=entry.notification;
  const fingerprint=hash(canonical({source:entry.source,notification:semantic}));
  const occurrence=occurrences.get(fingerprint)??0;occurrences.set(fingerprint,occurrence+1);
  return{id:hash(fingerprint+':'+occurrence),entry};
 });
}
export interface ScheduledNotification {id:string;dueAtMs:number;entry:ForecastNotificationEntry}
/** Derived local inbox, never a source of authority for game state. Callers must
 * synchronize the game and supply its current revision before delivery.
 */
export class NotificationScheduleStore{
 private db:DatabaseSync;
 constructor(path:string){
  this.db=new DatabaseSync(path);
  try{
   const app=Number(this.db.prepare('PRAGMA application_id').get()!.application_id),version=Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
   if(app!==0&&app!==APP||version!==0&&version!==3)throw Error('Unsupported notification database');
   if(app===0&&this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length)throw Error('Unrecognized notification database');
   this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS heads(room TEXT NOT NULL,player INTEGER NOT NULL,generation INTEGER NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(room,player));
    CREATE TABLE IF NOT EXISTS notices(room TEXT NOT NULL,player INTEGER NOT NULL,id TEXT NOT NULL,due INTEGER NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,confirmed INTEGER NOT NULL DEFAULT 0,inbox_ordinal INTEGER,PRIMARY KEY(room,player,id));
    PRAGMA application_id=${APP}; PRAGMA user_version=3; COMMIT;`);
  }catch(e){this.db.close();throw e;}
 }
 close(){this.db.close();}
 private scope(room:string,player:number){if(!room||room.length>200||!Number.isInteger(player)||player<0||player>9)throw Error('Invalid notification scope');}
 generation(room:string,player:number){this.scope(room,player);return Number(this.db.prepare('SELECT generation FROM heads WHERE room=? AND player=?').get(room,player)?.generation??0);}
 needsSonarConfirmation(room:string,player:number,throughTick:number){
  this.scope(room,player);if(!Number.isSafeInteger(throughTick)||throughTick<0)throw Error('Invalid sonar confirmation tick');
  return !!this.db.prepare("SELECT 1 FROM notices WHERE room=? AND player=? AND delivered=0 AND confirmed=0 AND json_extract(payload,'$.entry.source')='sonar' AND json_extract(payload,'$.entry.notification.tick')<=? LIMIT 1").get(room,player,throughTick);
 }
 replace(room:string,player:number,expectedGeneration:number,revision:string,observedAtMs:number,entries:readonly ForecastNotificationEntry[],occurred:readonly ForecastNotificationEntry[]=[],tickDurationMs=TICK_MILLISECONDS){
  this.scope(room,player);
  if(!Number.isSafeInteger(expectedGeneration)||expectedGeneration<0||!revision||revision.length>200||!Number.isSafeInteger(observedAtMs)||observedAtMs<0||entries.length>1024)throw Error('Invalid notification replacement');
  const records:ScheduledNotification[]=[];
  for(const entry of entries){
   const notice=entry.notification;
   if(!Number.isSafeInteger(notice.tick)||notice.tick<0||!Number.isSafeInteger(notice.minutesBeforeSending)||notice.minutesBeforeSending<1||notice.minutesBeforeSending>721||typeof notice.sendNotification!=='boolean')throw Error('Invalid notification time');
  }
  for(const {id,entry} of identities(entries)){
   const dueAtMs=observedAtMs+entry.notification.minutesBeforeSending*tickDurationMs/10;
   if(!Number.isSafeInteger(dueAtMs))throw Error('Invalid notification deadline');
   records.push({id,dueAtMs,entry:structuredClone(entry)});
  }
  return sqliteTransaction(this.db,()=>{
   if(this.generation(room,player)!==expectedGeneration)throw Error('Stale notification generation');
   // Only the synchronized service may supply observed events. Confirmation
   // never creates a new event and preserves the original send deadline.
   for(const {id} of identities(occurred))this.db.prepare('UPDATE notices SET confirmed=1 WHERE room=? AND player=? AND id=?').run(room,player,id);
   this.db.prepare('DELETE FROM notices WHERE room=? AND player=? AND delivered=0 AND confirmed=0').run(room,player);
   for(const record of records){const payload=JSON.stringify(record);
    this.db.prepare('INSERT OR IGNORE INTO notices(room,player,id,due,payload,digest) VALUES(?,?,?,?,?,?)').run(room,player,record.id,record.dueAtMs,payload,hash(payload));
   }
   this.db.prepare('INSERT INTO heads(room,player,generation,revision) VALUES(?,?,?,?) ON CONFLICT(room,player) DO UPDATE SET generation=excluded.generation,revision=excluded.revision').run(room,player,expectedGeneration+1,revision);
   return expectedGeneration+1;
  });
 }
 /** Atomically moves due items into a persistent inbox; no external send occurs.
  * Revision mismatch invalidates unconfirmed predictions; confirmed pending
  * events and delivered history survive later changes to the game.
  */
 deliverDue(room:string,player:number,currentRevision:string,now:number){
  this.scope(room,player);if(!currentRevision||!Number.isSafeInteger(now)||now<0)throw Error('Invalid notification delivery');
  return sqliteTransaction(this.db,()=>{
   const head=this.db.prepare('SELECT revision,generation FROM heads WHERE room=? AND player=?').get(room,player);
   if(!head)return [];
   if(head.revision!==currentRevision){
    this.db.prepare('DELETE FROM notices WHERE room=? AND player=? AND delivered=0 AND confirmed=0').run(room,player);
    this.db.prepare('UPDATE heads SET revision=?,generation=generation+1 WHERE room=? AND player=?').run(currentRevision,room,player);
   }
   const rows=this.db.prepare("SELECT id,payload,digest FROM notices WHERE room=? AND player=? AND delivered=0 AND due<=? ORDER BY due,json_extract(payload,'$.entry.sequence'),id").all(room,player,now);
   const result=rows.map(row=>this.decode(row));
   let ordinal=Number(this.db.prepare('SELECT COALESCE(MAX(inbox_ordinal),-1) AS last FROM notices WHERE room=? AND player=?').get(room,player)!.last)+1;
   for(const row of rows)this.db.prepare('UPDATE notices SET delivered=1,inbox_ordinal=? WHERE room=? AND player=? AND id=?').run(ordinal++,room,player,String(row.id));
   return result;
  });
 }
 inbox(room:string,player:number){this.scope(room,player);return this.db.prepare('SELECT payload,digest FROM notices WHERE room=? AND player=? AND delivered=1 ORDER BY inbox_ordinal').all(room,player).map(row=>this.decode(row));}
 private decode(row:Record<string,unknown>):ScheduledNotification{
  if(typeof row.payload!=='string'||hash(row.payload)!==row.digest)throw Error('Notification checksum mismatch');
  return JSON.parse(row.payload) as ScheduledNotification;
 }
}
