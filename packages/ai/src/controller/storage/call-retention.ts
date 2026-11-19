import type {DatabaseSync} from 'node:sqlite';
import {compactModelCall} from './diagnostic-retention.js';

/** Derived, transactional indexes. Payloads and the audit ledger remain in their original tables. */
export class CallRetention {
 constructor(private readonly db:DatabaseSync){
  db.exec('BEGIN IMMEDIATE');
  try{
   const initialized=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='diagnostic_call_index'").get();
   db.exec(`
    CREATE TABLE IF NOT EXISTS diagnostic_call_index(room TEXT NOT NULL,seat INTEGER NOT NULL,source TEXT NOT NULL,ref INTEGER NOT NULL,call_key BLOB NOT NULL,body INTEGER NOT NULL,PRIMARY KEY(room,seat,source,ref));
    CREATE INDEX IF NOT EXISTS diagnostic_call_versions ON diagnostic_call_index(room,seat,source,call_key,ref DESC);
    CREATE INDEX IF NOT EXISTS diagnostic_call_bodies ON diagnostic_call_index(room,seat,ref) WHERE body=1;
    CREATE TABLE IF NOT EXISTS diagnostic_call_heads(room TEXT NOT NULL,seat INTEGER NOT NULL,source TEXT NOT NULL,call_key BLOB NOT NULL,ref INTEGER NOT NULL,PRIMARY KEY(room,seat,source,call_key));
    CREATE INDEX IF NOT EXISTS diagnostic_call_recent ON diagnostic_call_heads(room,seat,ref DESC);
    CREATE TRIGGER IF NOT EXISTS diagnostic_call_index_insert AFTER INSERT ON diagnostic_call_index BEGIN
     INSERT INTO diagnostic_call_heads VALUES(NEW.room,NEW.seat,NEW.source,NEW.call_key,NEW.ref)
      ON CONFLICT(room,seat,source,call_key) DO UPDATE SET ref=excluded.ref WHERE excluded.ref>diagnostic_call_heads.ref;
    END;
    CREATE TRIGGER IF NOT EXISTS diagnostic_call_index_delete AFTER DELETE ON diagnostic_call_index BEGIN
     DELETE FROM diagnostic_call_heads WHERE room=OLD.room AND seat=OLD.seat AND source=OLD.source AND call_key=OLD.call_key AND ref=OLD.ref;
     INSERT INTO diagnostic_call_heads
      SELECT room,seat,source,call_key,MAX(ref) FROM diagnostic_call_index
       WHERE room=OLD.room AND seat=OLD.seat AND source=OLD.source AND call_key=OLD.call_key GROUP BY room,seat,source,call_key
      ON CONFLICT(room,seat,source,call_key) DO NOTHING;
    END;
   `);
   for(const source of ['journal','capture'] as const){
    const table=source==='journal'?'journal':'diagnostic_calls',ref=source==='journal'?'id':'call_ref';
    // No affinity conversion: match SQLite's original GROUP BY semantics,
    // including numeric equality and distinct numeric/string identities.
    const key=(alias:string)=>source==='journal'?`COALESCE(json_extract(${alias}.payload,'$.callId'),${alias}.id)`:`${alias}.call_ref`;
    const eligible=(alias:string)=>source==='journal'?`${alias}.kind GLOB 'mode-*-model-call'`:'1';
    const put=`INSERT INTO diagnostic_call_index SELECT NEW.room,NEW.seat,'${source}',NEW.${ref},${key('NEW')},json_extract(NEW.payload,'$.bodyRetention') IS NOT 'summary-only' WHERE ${eligible('NEW')};`;
    const remove=`DELETE FROM diagnostic_call_index WHERE room=OLD.room AND seat=OLD.seat AND source='${source}' AND ref=OLD.${ref};`;
    db.exec(`
     CREATE TRIGGER IF NOT EXISTS diagnostic_retention_${source}_insert AFTER INSERT ON ${table} WHEN ${eligible('NEW')} BEGIN ${put} END;
     CREATE TRIGGER IF NOT EXISTS diagnostic_retention_${source}_delete AFTER DELETE ON ${table} WHEN ${eligible('OLD')} BEGIN ${remove} END;
     CREATE TRIGGER IF NOT EXISTS diagnostic_retention_${source}_update AFTER UPDATE ON ${table} WHEN ${eligible('OLD')} OR ${eligible('NEW')} BEGIN ${remove} ${put} END;
    `);
    // Existing audit data is indexed once, in the same transaction as installation.
    if(!initialized)db.exec(`INSERT INTO diagnostic_call_index SELECT r.room,r.seat,'${source}',r.${ref},${key('r')},json_extract(r.payload,'$.bodyRetention') IS NOT 'summary-only' FROM ${table} r WHERE ${eligible('r')}`);
   }
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 trim(room:string,seat:number){
  const boundary=this.db.prepare('SELECT DISTINCT ref FROM diagnostic_call_heads WHERE room=? AND seat=? ORDER BY ref DESC LIMIT 1 OFFSET 20').get(room,seat);
  if(!boundary)return;
  // Only bodies newly outside the retained window are read. Already compacted
  // history never re-enters this partial index, even after a process restart.
  const expired=this.db.prepare('SELECT source,ref FROM diagnostic_call_index WHERE room=? AND seat=? AND body=1 AND ref<=?').all(room,seat,Number(boundary.ref));
  for(const row of expired){
   const captured=row.source==='capture',table=captured?'diagnostic_calls':'journal',key=captured?'call_ref':'id';
   const stored=this.db.prepare(`SELECT payload FROM ${table} WHERE room=? AND seat=? AND ${key}=?`).get(room,seat,Number(row.ref));
   if(!stored)throw Error('Diagnostic retention index is inconsistent');
   this.db.prepare(`UPDATE ${table} SET payload=? WHERE room=? AND seat=? AND ${key}=?`).run(JSON.stringify(compactModelCall(JSON.parse(String(stored.payload)),captured)),room,seat,Number(row.ref));
  }
 }
}
