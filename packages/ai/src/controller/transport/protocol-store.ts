import {DatabaseSync} from 'node:sqlite';
import {parseOwnerDelegation,type OwnerDelegationRecord} from './owner-delegation.js';
import {emptyProtocolClientState,type ProtocolClientState,type ProtocolClientStore,type OutboxEntry} from '../../../../player-sdk/src/index.js';
const storage='sqlite-outbox/1';
interface Basis {version:number;document:string;rows:Map<string,string>;safetyStop:ProtocolClientState['safetyStop']}
/** Command history is retained, but only changed rows are rewritten. All state shares one transaction. */
export class SqliteProtocolClientStore implements ProtocolClientStore {
  private readonly db:DatabaseSync;
  private cache:Basis|null=null;
  constructor(path:string){
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS player_protocol_client(singleton INTEGER PRIMARY KEY CHECK(singleton=1), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS player_protocol_delegation(singleton INTEGER PRIMARY KEY CHECK(singleton=1), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS player_protocol_outbox(key TEXT PRIMARY KEY,document TEXT NOT NULL,state TEXT NOT NULL,scheduled INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS player_protocol_outbox_state ON player_protocol_outbox(state);
      CREATE INDEX IF NOT EXISTS player_protocol_outbox_scheduled ON player_protocol_outbox(scheduled) WHERE scheduled=1;
      CREATE TABLE IF NOT EXISTS player_protocol_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
      INSERT OR IGNORE INTO player_protocol_revision VALUES(1,0);
      ${['player_protocol_client','player_protocol_outbox'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(operation=>`
        CREATE TRIGGER IF NOT EXISTS ${table}_${operation.toLowerCase()}_revision AFTER ${operation} ON ${table}
        BEGIN UPDATE player_protocol_revision SET version=version+1 WHERE singleton=1; END;`)).join('')}`);
    try{
      const row=this.db.prepare('SELECT document FROM player_protocol_client WHERE singleton=1').get();
      if(row){
        const state=JSON.parse(String(row.document)) as ProtocolClientState&{outboxStorage?:string};this.validate(state);
        if(state.outboxStorage!==storage||Object.keys(state.outbox).length)throw Error('Invalid split private protocol state');
      }
    }catch(error){this.db.close();throw error;}
  }
  private validate(value:ProtocolClientState){if(value?.format!=='player-sdk-store/1'||!value.outbox||!value.application)throw Error('Invalid private protocol state');}
  private basis():Basis {
    const version=this.revision();
    if(this.cache?.version===version)return this.cache;
    const row=this.db.prepare('SELECT document FROM player_protocol_client WHERE singleton=1').get();
    const document=row?String(row.document):JSON.stringify({...emptyProtocolClientState(),outboxStorage:storage});
    const parsed=JSON.parse(document) as ProtocolClientState&{outboxStorage?:string};this.validate(parsed);
    if(parsed.outboxStorage!==storage||Object.keys(parsed.outbox).length)throw Error('Invalid split private protocol state');
    const rows=new Map(this.db.prepare('SELECT key,document FROM player_protocol_outbox ORDER BY rowid').all().map(r=>[String(r.key),String(r.document)]));
    return this.cache={version,document,rows,safetyStop:parsed.safetyStop};
  }
  private draft(base:Basis){
    const state=JSON.parse(base.document) as ProtocolClientState&{outboxStorage?:string};delete state.outboxStorage;
    const values:ProtocolClientState['outbox']=Object.create(null),removed=new Set<string>();
    // The captured map is immutable. Reads remain detached even after another
    // transaction commits; ordinary access never enumerates historical keys.
    const materialize=(key:string)=>{
      if(!Object.hasOwn(values,key)&&!removed.has(key)){
        const row=base.rows.get(key);if(row)values[key]=JSON.parse(row) as OutboxEntry;
      }
      return values[key];
    };
    const outbox=new Proxy(values,{
      get:(target,key)=>typeof key==='string'?materialize(key):Reflect.get(target,key),
      has:(_,key)=>typeof key==='string'&&!removed.has(key)&&(Object.hasOwn(values,key)||base.rows.has(key)),
      ownKeys:()=>[...new Set([...base.rows.keys(),...Object.keys(values)])].filter(key=>!removed.has(key)),
      getOwnPropertyDescriptor:(_,key)=>typeof key==='string'&&materialize(key)!==undefined?{value:values[key],writable:true,configurable:true,enumerable:true}:undefined,
      set:(_,key,value)=>{if(typeof key!=='string')return false;removed.delete(key);values[key]=value;return true;},
      deleteProperty:(_,key)=>{if(typeof key!=='string')return false;removed.add(key);delete values[key];return true;},
      defineProperty:(_,key,descriptor)=>{if(typeof key!=='string')return false;removed.delete(key);return Reflect.defineProperty(values,key,descriptor);},
    });
    state.outbox=outbox;return {state,outbox,values,removed};
  }
  load():ProtocolClientState {
    this.db.exec('BEGIN');
    try{
      const base=this.basis(),result=JSON.parse(base.document) as ProtocolClientState&{outboxStorage?:string};delete result.outboxStorage;
      // Plain, cloneable public snapshots. Full history is materialized only
      // when explicitly requested; the SDK uses indexed command lookups.
      let history:ProtocolClientState['outbox']|undefined;
      Object.defineProperty(result,'outbox',{enumerable:true,configurable:true,get:()=>{
        return history??=Object.fromEntries([...base.rows].map(([key,row])=>[key,JSON.parse(row) as OutboxEntry]));
      },set:(value:ProtocolClientState['outbox'])=>{history=value;}});
      this.db.exec('COMMIT');return result;
    }
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  outboxEntry(key:string):OutboxEntry|undefined {
    const row=this.db.prepare('SELECT document FROM player_protocol_outbox WHERE key=?').get(key);
    return row?JSON.parse(String(row.document)) as OutboxEntry:undefined;
  }
  readSafetyStop():ProtocolClientState['safetyStop'] {
    this.db.exec('BEGIN');
    try{const value=this.basis().safetyStop;this.db.exec('COMMIT');return value;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  outboxEntries(states:readonly OutboxEntry['state'][],includeScheduled=false):OutboxEntry[]{
    this.db.exec('BEGIN');
    try{
      const clauses=[...(states.length?[`state IN (${states.map(()=>'?').join(',')})`]:[]),...(includeScheduled?['scheduled=1']:[])];
      const rows=clauses.length?this.db.prepare(`SELECT document FROM player_protocol_outbox WHERE ${clauses.join(' OR ')} ORDER BY rowid`).all(...states).map(r=>JSON.parse(String(r.document)) as OutboxEntry):[];
      this.db.exec('COMMIT');return rows;
    }
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  transaction<T>(apply:(draft:ProtocolClientState)=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const base=this.basis(),draft=this.draft(base),result=apply(draft.state);
      if(result instanceof Promise)throw Error('Transport transactions must be synchronous');this.validate(draft.state);
      const {outbox,...core}=draft.state,document=JSON.stringify({...core,outbox:{},outboxStorage:storage});
      if(document!==base.document)this.db.prepare('INSERT INTO player_protocol_client VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET document=excluded.document').run(document);
      let rows=base.rows;const change=()=>{if(rows===base.rows)rows=new Map(rows);};
      const remove=this.db.prepare('DELETE FROM player_protocol_outbox WHERE key=?');
      const put=this.db.prepare('INSERT INTO player_protocol_outbox VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET document=excluded.document,state=excluded.state,scheduled=excluded.scheduled');
      const deleted=outbox===draft.outbox?draft.removed:new Set([...base.rows.keys()].filter(key=>!Object.hasOwn(outbox,key)));
      for(const key of deleted){remove.run(key);change();rows.delete(key);}
      for(const [key,value] of Object.entries(outbox===draft.outbox?draft.values:outbox)){
        const encoded=JSON.stringify(value);
        if(encoded===undefined){if(rows.has(key)){remove.run(key);change();rows.delete(key);}continue;}
        if(encoded!==rows.get(key)){put.run(key,encoded,value.state,Number(value.receipt?.state==='scheduled'));change();rows.set(key,encoded);}
      }
      const version=this.revision();this.db.exec('COMMIT');this.cache={version,document,rows,safetyStop:draft.state.safetyStop};return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private revision(){return Number(this.db.prepare('SELECT version FROM player_protocol_revision WHERE singleton=1').get()!.version);}
  loadDelegation(){const row=this.db.prepare('SELECT document FROM player_protocol_delegation WHERE singleton=1').get();return row?parseOwnerDelegation(JSON.parse(String(row.document))):null;}
  saveDelegation(record:OwnerDelegationRecord){this.db.prepare('INSERT INTO player_protocol_delegation(singleton,document) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET document=excluded.document').run(JSON.stringify(parseOwnerDelegation(record)));}
  close(){this.db.close();}
}
