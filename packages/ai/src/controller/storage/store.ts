import {LocalBasisChanged} from '../contracts/local-basis.js';
import type {RunnerRepository,DiagnosticReadModel,DiagnosticCaptureRepository,CommanderRepository} from './store-interfaces.js';
import {currentSnapshotOnly,snapshotSummary} from './diagnostic-retention.js';
import {CallRetention} from './call-retention.js';
import {validateReminderSource} from '../contracts/decision-task-validation.js';
import {manualMemoryEvidence,isTacticalManual} from '../execution/manual-coordination.js';
import {toolMetadata} from '../contracts/tool-metadata.js';
import {isDeepStrictEqual} from 'node:util';
import {noteDependencySummary} from './notebook-dependencies.js';
import {receiptMemoryEvidence,type MemoryEvidence} from './memory-evidence.js';
import type {ReviewReceipt} from './memory-consistency.js';
import {activeCampaign,type Campaign} from './campaign-state.js';
import {isActiveNote,matchesNote,type NotebookQuery} from './memory-records.js';
import { DatabaseSync } from "node:sqlite";
import { validateSettings, type AiState } from "../contracts/types.js";
import {projectModelData} from '../presentation/model-data-projection.js';
import type {PlayerObservation} from '../../../../contracts/src/index.js';
import type {AiReminder} from '../contracts/types.js';
import type {NotebookEntry} from '../contracts/types.js';
import {fleetLabel} from '../presentation/fleet-labels.js';
import {miningPhaseContext,type MiningPhaseHistory} from '../analysis/mining-phase.js';
import {observationRuleSeconds} from '../../../../contracts/src/index.js';

// Only replayable mode snapshots; never commands, receipts or model output.
const repeatableSnapshot=(kind:string)=>/^mode-[a-z][a-z0-9-]{0,39}-(state|operations|search|decision)$/.test(kind);

/** One private service database; callers never provide SQL, paths or another seat's key. */
export class AiStore implements RunnerRepository,DiagnosticReadModel,DiagnosticCaptureRepository,CommanderRepository {
  private db: DatabaseSync;
  private readonly callRetention:CallRetention;
  private observedFleets=new Map<string,{through:number;ids:Set<string>}>();
  private rewriteVersion=-1;
  private fleetDataVersion=-1;
  private refreshRewrites(){
    const version=Number(this.db.prepare('SELECT version FROM journal_rewrite_revision WHERE singleton=1').get()!.version);
    if(version!==this.rewriteVersion){this.projections.clear();this.rewriteVersion=version;}
  }
  private projections=new Map<string,{through:number;notes:Map<string,NotebookEntry>;latestNotes:Map<string,NotebookEntry>;noteCursors:Map<string,number>;reminders:Map<string,AiReminder>;reviews:Map<string,ReviewReceipt>}>();
  /** Replay only new private journal rows. Returned values never alias this cache. */
  private projection(room:string,seat:number){
    this.refreshRewrites();
    const key=JSON.stringify([room,seat]);
    let cache=this.projections.get(key);
    if(!cache)cache={through:0,notes:new Map(),latestNotes:new Map(),noteCursors:new Map(),reminders:new Map(),reviews:new Map()};
    const rows=this.db.prepare("SELECT id,kind,payload FROM journal INDEXED BY journal_seat_kind_cursor WHERE room=? AND seat=? AND id>? AND kind IN ('notebook-set','notebook-removed','reminder-set','reminder-cancelled','reminder-fired','memory-reviewed') ORDER BY id").all(room,seat,cache.through);
    for(const row of rows){
      const p=JSON.parse(String(row.payload)),id=Number(row.id);
      switch(row.kind){
        case 'notebook-set':cache.notes.set(p.id,p);cache.latestNotes.set(p.id,p);cache.noteCursors.set(p.id,id);break;
        case 'notebook-removed':cache.notes.delete(p.id);break;
        case 'reminder-set':validateReminderSource(p);cache.reminders.set(p.id,p);break;
        case 'reminder-cancelled':case 'reminder-fired':cache.reminders.delete(p.id);break;
        case 'memory-reviewed':cache.reviews.set(p.id,p);break;
      }
      cache.through=id;
    }
    this.projections.set(key,cache);return cache;
  }
  latestNotebookEntry(room:string,seat:number,id:string):NotebookEntry|undefined {
    const entry=this.projection(room,seat).latestNotes.get(id);return entry?structuredClone(entry):undefined;
  }
  notebookDependencyHistory(room:string,seat:number,now:number){
    const cache=this.projection(room,seat);
    return [...cache.latestNotes.values()].filter(n=>!cache.notes.has(n.id)||!isActiveNote(n,now)).map(n=>noteDependencySummary(n,now,!cache.notes.has(n.id)));
  }
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      const version = Number(
        this.db.prepare("PRAGMA user_version").get()!.user_version,
      );
      const app = Number(
        this.db.prepare("PRAGMA application_id").get()!.application_id,
      );
      if ((version !== 0 && version !== 2) || (app !== 0 && app !== 1398096201))
        throw Error("Unsupported AI database");
      if (
        app === 0 &&
        this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all().length
      )
        throw Error("Unrecognized AI database");
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS seats(room TEXT NOT NULL, seat INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(room,seat));
        CREATE TABLE IF NOT EXISTS journal(id INTEGER PRIMARY KEY, room TEXT NOT NULL, seat INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime_state(room TEXT NOT NULL,seat INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(room,seat,kind));
        CREATE TABLE IF NOT EXISTS journal_rewrite_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
        INSERT OR IGNORE INTO journal_rewrite_revision VALUES(1,0);
        CREATE TRIGGER IF NOT EXISTS journal_delete_revision AFTER DELETE ON journal
          WHEN OLD.kind IN ('notebook-set','notebook-removed','reminder-set','reminder-cancelled','reminder-fired','memory-reviewed')
          BEGIN UPDATE journal_rewrite_revision SET version=version+1 WHERE singleton=1; END;
        CREATE TRIGGER IF NOT EXISTS journal_update_revision AFTER UPDATE ON journal
          WHEN OLD.kind IN ('notebook-set','notebook-removed','reminder-set','reminder-cancelled','reminder-fired','memory-reviewed')
            OR NEW.kind IN ('notebook-set','notebook-removed','reminder-set','reminder-cancelled','reminder-fired','memory-reviewed')
          BEGIN UPDATE journal_rewrite_revision SET version=version+1 WHERE singleton=1; END;
        CREATE INDEX IF NOT EXISTS journal_seat_cursor ON journal(room,seat,id);
        CREATE INDEX IF NOT EXISTS journal_seat_kind_cursor ON journal(room,seat,kind,id);
        CREATE INDEX IF NOT EXISTS local_receipt_lookup ON journal(room,seat,json_extract(payload,'$.id'),id) WHERE kind='tool-result';
        CREATE INDEX IF NOT EXISTS comparison_evidence_lookup ON journal(room,seat,json_extract(payload,'$.id'),json_extract(payload,'$.planId'),id) WHERE kind='comparison-evidence';
        CREATE INDEX IF NOT EXISTS arrival_estimates_lookup ON journal(room,seat,id) WHERE kind='arrival-estimates';
        CREATE INDEX IF NOT EXISTS diagnostic_entity_cursor ON journal(room,seat,json_extract(payload,'$.id'),id);
        CREATE INDEX IF NOT EXISTS diagnostic_sequence_cursor ON journal(room,seat,kind,json_extract(payload,'$.sequence'),id);
        CREATE INDEX IF NOT EXISTS diagnostic_time_cursor ON journal(room,seat,kind,json_extract(payload,'$.startedAt'),id);
        CREATE TABLE IF NOT EXISTS diagnostic_calls(room TEXT NOT NULL,seat INTEGER NOT NULL,call_ref INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(room,seat,call_ref));
        PRAGMA application_id=1398096201; PRAGMA user_version=2;`);
      this.callRetention=new CallRetention(this.db);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  load(room: string, seat: number): AiState | null {
    const row = this.db
      .prepare("SELECT payload FROM seats WHERE room=? AND seat=?")
      .get(room, seat);
    if (!row) return null;
    const state = JSON.parse(String(row.payload)) as AiState;
    if (
      state.format !== "ai-seat/2" ||
      state.roomId !== room ||
      state.lobbySeat !== seat
    )
      throw Error("Invalid AI state");
    state.settings=validateSettings(state.settings);
    if(state.commanderDirectives&&(!Number.isSafeInteger(state.commanderDirectives.version)||state.commanderDirectives.version<0||typeof state.commanderDirectives.text!=="string"||state.commanderDirectives.text.length>12000))throw Error("Invalid commander directives");
    for (const key of [
      "calls",
      "tokens",
      "sequence",
      "chatCursor",
      "notificationCursor",
    ] as const)
      if (!Number.isSafeInteger(state[key]) || state[key] < 0)
        throw Error("Invalid AI counters");
    if (
      typeof state.enabled !== "boolean" ||
      !["waiting", "thinking", "paused", "error", "ended"].includes(
        state.status,
      ) ||
      !state.memory ||
      Object.keys(state.memory).sort().join(",") !==
        "agreements,deceptions,relations,strategy" ||
      Object.values(state.memory).some(
        (v) => typeof v !== "string" || v.length > 12000,
      )
    )
      throw Error("Invalid AI memory");
    for (const key of ["lastThought", "nextReview", "lastSpoke"] as const)
      if (
        state[key] !== null &&
        (!Number.isFinite(state[key]) || state[key]! < 0)
      )
        throw Error("Invalid AI time");
    return state;
  }
  save(state: AiState, kind = "state", details: unknown = null,expectedBasis?:string) {
    this.saveEvents(state,[{kind,details}],undefined,expectedBasis);
  }
  private performanceTimings:{room:string;seat:number;kind:string;payload:string}[]=[];
  private timingTimer:ReturnType<typeof setTimeout>|undefined;
  /** Performance samples are best effort; command intents and receipts are not buffered. */
  recordTiming(room:string,seat:number,kind:import('./store-interfaces.js').PerformanceTimingKind,details:unknown){
    this.performanceTimings.push({room,seat,kind,payload:JSON.stringify(details)});
    if(!this.timingTimer)this.timingTimer=setTimeout(()=>{
      this.timingTimer=undefined;
      try{this.flushTimings();}catch{console.warn('AI performance samples could not be saved.');}
    },500).unref();
  }
  flushTimings(){
    clearTimeout(this.timingTimer);this.timingTimer=undefined;
    if(!this.performanceTimings.length)return;
    const batch=this.performanceTimings;this.performanceTimings=[];
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const put=this.db.prepare('INSERT INTO journal(room,seat,kind,payload) VALUES(?,?,?,?)');
      for(const row of batch)put.run(row.room,row.seat,row.kind,row.payload);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Local finalization: memory, notes and reminders commit together. */
  saveEvents(state:AiState,events:{kind:string;details:unknown}[],localId?:string,expectedBasis?:string,options:{preserveMemory?:boolean}={}) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const oldReceipt=localId?this.queryResult(state.roomId,state.lobbySeat,localId) as {tool?:string;result?:unknown}|undefined:undefined;
      if(oldReceipt!==undefined){
        const nextReceipt=events.find(e=>e.kind==='tool-result')?.details as {tool?:string;result?:unknown}|undefined;
        if(oldReceipt.tool!==nextReceipt?.tool||!isDeepStrictEqual(oldReceipt.result,nextReceipt?.result))throw Error('LOCAL_ID_CONFLICT: same receipt ID has different content; nothing saved');
        const persisted=this.load(state.roomId,state.lobbySeat)!;this.db.exec('COMMIT');return persisted;
      }
      if(expectedBasis!==undefined&&this.localWriteBasis(state.roomId,state.lobbySeat)!==expectedBasis)throw new LocalBasisChanged();
      const persisted=options.preserveMemory||expectedBasis!==undefined?this.load(state.roomId,state.lobbySeat):null;
      // Runtime audit rows own counters and journals, not a model memory write.
      // Merge under the same SQLite write transaction so a concurrent strategy
      // cannot be overwritten between a caller-side read and this commit.
      const candidate=options.preserveMemory&&persisted?{...state,memory:persisted.memory}:state;
      const previousMemory=expectedBasis===undefined?undefined:persisted?.memory;
      this.db
        .prepare(
          "INSERT INTO seats VALUES(?,?,?) ON CONFLICT(room,seat) DO UPDATE SET payload=excluded.payload WHERE seats.payload<>excluded.payload",
        )
        .run(state.roomId, state.lobbySeat, JSON.stringify(candidate));
      const insert=this.db.prepare("INSERT INTO journal(room,seat,kind,payload) VALUES(?,?,?,?)");
      if(previousMemory&&!isDeepStrictEqual(previousMemory,candidate.memory))insert.run(state.roomId,state.lobbySeat,'memory-overwritten',JSON.stringify({at:new Date().toISOString(),policy:'last-writer-wins',previous:previousMemory,next:candidate.memory}));
      for(const event of events){
        if(event.kind==='wake-observation'){
          const observation=event.details as PlayerObservation;
          if(!observation||observation.roomId!==state.roomId||typeof observation.revision!=='string'||!observation.view||!Number.isSafeInteger(observation.view.player))throw Error('Invalid durable wake observation');
          this.db.prepare('INSERT INTO runtime_state(room,seat,kind,payload) VALUES(?,?,?,?) ON CONFLICT(room,seat,kind) DO UPDATE SET payload=excluded.payload')
            .run(state.roomId,state.lobbySeat,event.kind,JSON.stringify(observation));
        }else if(currentSnapshotOnly(event.kind)){
          const payload=JSON.stringify(event.details);
          this.db.prepare('INSERT INTO runtime_state(room,seat,kind,payload) VALUES(?,?,?,?) ON CONFLICT(room,seat,kind) DO UPDATE SET payload=excluded.payload WHERE runtime_state.payload<>excluded.payload')
            .run(state.roomId,state.lobbySeat,event.kind,payload);
          insert.run(state.roomId,state.lobbySeat,event.kind,JSON.stringify(snapshotSummary(event.kind,payload,state.sequence)));
        }else{
          const payload=JSON.stringify(event.details);
          const prior=repeatableSnapshot(event.kind)?this.db.prepare('SELECT id,payload=? AS identical FROM journal WHERE room=? AND seat=? AND kind=? ORDER BY id DESC LIMIT 1').get(payload,state.roomId,state.lobbySeat,event.kind):undefined;
          if(prior?.identical===1)insert.run(state.roomId,state.lobbySeat,'snapshot-repeated',JSON.stringify({kind:event.kind,ref:Number(prior.id)}));
          else insert.run(state.roomId,state.lobbySeat,event.kind,payload);
        }
      }
      if(events.some(event=>/^mode-[a-z][a-z0-9-]*-model-call$/.test(event.kind)))this.trimCallBodies(state.roomId,state.lobbySeat);
      this.db.exec("COMMIT");
      return candidate;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  /** Private memory uses last-writer-wins. Keep CAS for records and authority;
   * never execute or retry a game request at this storage boundary. */
  localWriteBasis(room:string,seat:number){
    const state=this.load(room,seat);
    return JSON.stringify({initialized:!!state,commander:state?.commanderDirectives??null,notes:this.notebook(room,seat,-Infinity),
      reminders:this.reminders(room,seat),manualVersion:this.latest<import('../../../../contracts/src/index.js').ManualCommandView>(room,seat,'manual-commands-observed')?.version??0,manualReviews:this.manualReviewedReceiptIds(room,seat)});
  }
  /** Read all displayed private domains and their CAS token in one DB snapshot. */
  localDecisionView(room:string,seat:number,seconds:number){
    this.db.exec('BEGIN');
    try{
      const state=this.load(room,seat),notebook=this.notebook(room,seat,seconds),reminders=this.reminders(room,seat);
      const basis=this.localWriteBasis(room,seat);
      this.db.exec('COMMIT');return {state,notebook,reminders,basis};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  saveLocalEvents(state:AiState,id:string,events:{kind:string;details:unknown}[],expectedBasis?:string){
    const receipt=events.find(e=>e.kind==='tool-result')?.details as {id?:string;tool?:string}|undefined;
    if(receipt?.id!==id||toolMetadata(receipt.tool??'')?.commit!=='local-cas')throw Error('Invalid local commit receipt');
    return this.saveEvents(state,events,id,expectedBasis);
  }
  pendingCommanderCleanup(room:string,seat:number):{requestId:string;cleanup:import('../../../../contracts/src/index.js').CommanderCleanup}|null{
    const row=this.db.prepare(`SELECT a.payload FROM journal a WHERE a.room=? AND a.seat=? AND a.kind='commander-cleanup-requested'
      AND NOT EXISTS(SELECT 1 FROM journal b WHERE b.room=a.room AND b.seat=a.seat AND b.kind IN ('commander-cleanup-applied','commander-cleanup-rejected') AND json_extract(b.payload,'$.requestId')=json_extract(a.payload,'$.requestId')) ORDER BY a.id LIMIT 1`).get(room,seat);
    return row?JSON.parse(String(row.payload)):null;
  }
  list(room: string) {
    return this.db
      .prepare("SELECT seat FROM seats WHERE room=? ORDER BY seat")
      .all(room)
      .map((r) => this.load(room, Number(r.seat))!);
  }
  /** Drop journal entries from a later timeline after a local room rewind. */
  trimHistoryToTick(room: string, tick: number) {
    if (!room || !Number.isSafeInteger(tick) || tick < 0) throw Error('Invalid AI history boundary');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`DELETE FROM journal WHERE room=? AND id IN (
        SELECT j.id FROM journal j
        WHERE j.room=? AND CAST(COALESCE((SELECT json_extract(started.payload,'$.tick')
          FROM journal started WHERE started.room=j.room AND started.seat=j.seat
            AND started.kind='started' AND started.id<=j.id
          ORDER BY started.id DESC LIMIT 1), ?) AS INTEGER) > ?
      )`).run(room, room, tick, tick);
      let sanitized = 0;
      const update = this.db.prepare('UPDATE journal SET payload=? WHERE id=?');
      for (const row of this.db.prepare("SELECT id,kind,payload FROM journal WHERE room=? AND kind IN ('started','messages-read','chat-coalesced','tool-result')").all(room)) {
        const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
        const filterMessages = (value: unknown) => Array.isArray(value) ? value.filter(message => !message || typeof message !== 'object' || !Number.isSafeInteger((message as {tick?: unknown}).tick) || Number((message as {tick: number}).tick) <= tick) : value;
        if (row.kind === 'started' || row.kind === 'messages-read' || row.kind === 'chat-coalesced') {
          const key = row.kind === 'started' ? 'incomingMessages' : 'messages';
          if (key in payload) payload[key] = filterMessages(payload[key]);
        } else if (payload.tool === 'chatHistory' && payload.result && typeof payload.result === 'object') {
          const resultValue = payload.result as Record<string, unknown>;
          if ('messages' in resultValue) resultValue.messages = filterMessages(resultValue.messages);
        }
        const next = JSON.stringify(payload);
        if (next !== String(row.payload)) { update.run(next, Number(row.id)); sanitized++; }
      }
      // The chat transcript is append-only, so a rewind invalidates every
      // cached per-seat cursor even when the surviving messages are valid.
      this.db.prepare("UPDATE seats SET payload=json_set(json_set(payload,'$.chatCursor',0),'$.notificationCursor',0) WHERE room=?").run(room);
      this.db.exec('COMMIT');
      this.projections.clear();this.observedFleets.clear();
      return Number(result.changes) + sanitized;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  history(room: string, seat: number, limit = 20) {
    return this.db
      .prepare(
        "SELECT kind,payload FROM journal WHERE room=? AND seat=? ORDER BY id DESC LIMIT ?",
      )
      .all(room, seat, Math.min(50, Math.max(1, limit)))
      .map(r=>this.readHistoryRow(room,seat,String(r.kind),String(r.payload)));
  }
  private readHistoryRow(room:string,seat:number,kind:string,payload:string):{kind:string;payload:unknown}{
    if(kind!=='snapshot-repeated')return {kind,payload:JSON.parse(payload)};
    const reference=JSON.parse(payload) as {kind:string;ref:number};
    if(!repeatableSnapshot(reference.kind)||!Number.isSafeInteger(reference.ref)||reference.ref<1)throw Error('Invalid snapshot reference');
    const source=this.db.prepare('SELECT payload FROM journal WHERE room=? AND seat=? AND kind=? AND id=?').get(room,seat,reference.kind,reference.ref);
    if(!source)throw Error('Missing snapshot reference');
    return {kind:reference.kind,payload:JSON.parse(String(source.payload))};
  }
  close() {
    try{this.flushTimings();}finally{this.db.close();}
  }
  baseline(room:string,seat:number):PlayerObservation|null {
    const row=this.db.prepare("SELECT payload FROM journal WHERE room=? AND seat=? AND kind='observation-baseline' ORDER BY id DESC LIMIT 1").get(room,seat);
    return row?JSON.parse(String(row.payload)):null;
  }
  latest<T>(room:string,seat:number,kind:string):T|null {
    if(kind==='wake-observation'||currentSnapshotOnly(kind)){
      const current=this.db.prepare('SELECT payload FROM runtime_state WHERE room=? AND seat=? AND kind=?').get(room,seat,kind);
      if(current)return JSON.parse(String(current.payload)) as T;
      if(kind==='wake-observation')return null;
    }
    const row=this.db.prepare('SELECT payload FROM journal WHERE room=? AND seat=? AND kind=? ORDER BY id DESC LIMIT 1').get(room,seat,kind);
    return row?JSON.parse(String(row.payload)):null;
  }
  /** Persist only observed phase advances. No state/memory/notes write and no
   * model authority. Recheck the journal under the same write transaction so
   * gameplay and commander observers cannot overwrite each other's milestone. */
  observeMiningPhase(room:string,seat:number,o:PlayerObservation){
    if(o.roomId!==room)throw Error('Mining phase observation room mismatch');
    const previous=this.latest<MiningPhaseHistory>(room,seat,'mining-phase-observed');
    const context=miningPhaseContext(o,previous);
    const shouldSave=(old:MiningPhaseHistory|null,next:typeof context)=>!!next?.history&&next.history!==old
      &&!(old?.roomId===o.roomId&&old.player===o.view.player&&old.playerCount===o.view.playerCount
        &&old.goal===o.view.match?.neptuniumGoal&&old.observedAtSeconds>observationRuleSeconds(o));
    if(!shouldSave(previous,context))return context;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const latest=this.latest<MiningPhaseHistory>(room,seat,'mining-phase-observed'),next=miningPhaseContext(o,latest);
      if(shouldSave(latest,next))this.db.prepare('INSERT INTO journal(room,seat,kind,payload) VALUES(?,?,?,?)').run(room,seat,'mining-phase-observed',JSON.stringify(next!.history));
      this.db.exec('COMMIT');return next;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Historical identity only, never current existence or an actionable unit.
   * Read actual authenticated observations, excluding forecasts and prose. */
  observedFleetIds(room:string,seat:number,reference:string):string[] {
    const version=Number(this.db.prepare('PRAGMA data_version').get()!.data_version);
    if(version!==this.fleetDataVersion){this.observedFleets.clear();this.fleetDataVersion=version;}
    const key=JSON.stringify([room,seat]),cache=this.observedFleets.get(key)??{through:0,ids:new Set<string>()};
    const through=Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM journal WHERE room=? AND seat=?').get(room,seat)!.id);
    if(through>cache.through){
      // Historical receipt names identify actual observations only; they never enable retired tools.
      const rows=this.db.prepare(`WITH observations AS (
        SELECT json_extract(payload,CASE WHEN kind IN ('observation-baseline','wake-observation') THEN '$'
          WHEN kind='wake-state' THEN '$.observed'
          WHEN json_type(payload,'$.result.observation')='object' THEN '$.result.observation'
          ELSE '$.result' END) AS observation
        FROM journal WHERE room=? AND seat=? AND id>? AND id<=? AND
          (kind IN ('observation-baseline','wake-observation','wake-state') OR kind='tool-result' AND json_extract(payload,'$.tool') IN ('observe','order','schedule','cancelSchedule','batch'))
      ) SELECT DISTINCT json_extract(fleet.value,'$.id') AS fleetId FROM observations,json_each(observation,'$.view.fleets') AS fleet
        WHERE json_extract(observation,'$.roomId')=? AND json_extract(observation,'$.view.format')='player-observation/2'`)
        .all(room,seat,cache.through,through,room);
      for(const row of rows)if(typeof row.fleetId==='string')cache.ids.add(row.fleetId);
      const runtimeObservation=this.db.prepare("SELECT payload FROM runtime_state WHERE room=? AND seat=? AND kind='wake-observation'").get(room,seat);
      if(runtimeObservation){
        const observation=JSON.parse(String(runtimeObservation.payload)) as PlayerObservation;
        for(const fleet of observation.view.fleets)cache.ids.add(fleet.id);
      }
      cache.through=through;this.observedFleets.set(key,cache);
    }
    const short=/^F\d+-[A-F0-9]{8}$/i.test(reference);
    return [...cache.ids].filter(id=>short?fleetLabel(id).toUpperCase()===reference.toUpperCase():id===reference).slice(0,2);
  }
  queryResult(room:string,seat:number,id:string,detail=false):unknown {
    const row=this.db.prepare("SELECT kind,payload FROM journal WHERE room=? AND seat=? AND kind IN ('tool-result','query-result','batch-recovered','write-reconciled','tool-rejected') AND json_extract(payload,'$.id')=? ORDER BY id DESC LIMIT 1").get(room,seat,id);
    if(!row)return undefined;
    const intent=this.db.prepare("SELECT payload FROM journal WHERE room=? AND seat=? AND kind='tool-intent' AND json_extract(payload,'$.id')=? ORDER BY id DESC LIMIT 1").get(room,seat,id);
    if(detail){
      const archive=this.db.prepare("SELECT payload FROM journal WHERE room=? AND seat=? AND kind IN ('campaign-detail','prediction-detail') AND json_extract(payload,'$.id')=? ORDER BY id DESC LIMIT 1").get(room,seat,id);
      if(archive)return JSON.parse(String(archive.payload));
      // Older forecast/compare receipts already contain their complete result.
      const legacy=JSON.parse(String(row.payload));
      if(!['forecast','compare'].includes(legacy.tool)||legacy.result?.format)return undefined;
    }
    const value=JSON.parse(String(row.payload));
    return {...value,...(row.kind==='write-reconciled'?{result:{...value,status:value.status==='committed'?'accepted':value.status}}:row.kind==='tool-rejected'?{result:{...value,status:'rejected'}}:{}),...(intent?{arguments:JSON.parse(String(intent.payload)).arguments}:{})};
  }
  modeReceipt(room:string,seat:number,kind:string,id:string):{requestId:string;receipt:unknown}|undefined {
    if(/^mode-[a-z][a-z0-9-]*-operations$/.test(kind)){
      const match=/^operation-(\d+)(?:-internal)?$/.exec(id);if(!match)return undefined;
      const sequence=Number(match[1]),prefix=`ai-${seat}-${sequence}-%`;
      // No batch identity was ever opened in this round. A superseded reply is definitive non-submission evidence.
      if(this.db.prepare("SELECT 1 FROM journal WHERE room=? AND seat=? AND kind='tool-intent' AND json_extract(payload,'$.id') LIKE ? AND json_extract(payload,'$.tool')='batch' LIMIT 1").get(room,seat,prefix))return undefined;
      const creation=this.db.prepare("SELECT j.payload FROM journal j,json_each(j.payload,'$.operations') p WHERE j.room=? AND j.seat=? AND j.kind=? AND json_extract(j.payload,'$.sequence')=? AND json_extract(p.value,'$.id')=? AND json_extract(p.value,'$.status')='proposed' ORDER BY j.id ASC LIMIT 1").get(room,seat,kind,sequence,id);if(!creation)return undefined;
      const attempt=JSON.parse(String(creation.payload));
      const cancelled=this.db.prepare("SELECT id,payload FROM journal WHERE room=? AND seat=? AND kind='reply-superseded' AND json_extract(payload,'$.sequence')=? AND json_extract(payload,'$.step')=? ORDER BY id DESC LIMIT 1").get(room,seat,sequence,attempt.step);if(!cancelled)return undefined;
      const requestId=`ai-${seat}-${sequence}-${attempt.step}`;
      return {requestId,receipt:{id:requestId,tool:'batch',result:{status:'not-executed',evidenceId:cancelled.id,reason:'实际调度记录确认回复已作废，未提交游戏命令'}}};
    }
    if(!/^mode-[a-z][a-z0-9-]*-(?:message|contract|contract-withdrawal)-attempt$/.test(kind))throw Error('Invalid execution attempt kind');
    const row=this.db.prepare("SELECT payload FROM journal WHERE room=? AND seat=? AND kind=? AND json_extract(payload,'$.id')=? ORDER BY id DESC LIMIT 1").get(room,seat,kind,id);if(!row)return undefined;
    const attempt=JSON.parse(String(row.payload));if(!Number.isSafeInteger(attempt.sequence)||!Number.isSafeInteger(attempt.step))return undefined;
    const requestId=`ai-${seat}-${attempt.sequence}-${attempt.step}`;
    let receipt=this.queryResult(room,seat,requestId);
    if((kind.endsWith('-contract-attempt')||kind.endsWith('-contract-withdrawal-attempt'))&&!receipt&&!this.db.prepare("SELECT 1 FROM journal WHERE room=? AND seat=? AND kind='tool-intent' AND json_extract(payload,'$.id')=? LIMIT 1").get(room,seat,requestId))receipt={id:requestId,tool:kind.endsWith('-contract-withdrawal-attempt')?'batch':'order',result:{status:'not-executed',reason:'持久命令日志确认该次回复尚未打开写入意图，允许重新规划提交'}};
    return {requestId,receipt};
  }
  comparisonEvidence(room:string,seat:number,resultRef:string,planId:string):import('../../../../prediction/src/index.js').KnownDefenseEvidence|null {
    const row=this.db.prepare("SELECT payload FROM journal WHERE room=? AND seat=? AND kind='comparison-evidence' AND json_extract(payload,'$.id')=? AND json_extract(payload,'$.planId')=? ORDER BY id DESC LIMIT 1").get(room,seat,resultRef,planId);
    return row?JSON.parse(String(row.payload)).evidence:null;
  }
  arrivalEstimates(room:string,seat:number):import('../observation/arrival-coalescing.js').ArrivalEstimates|null {
    const row=this.db.prepare("SELECT payload FROM journal WHERE room=? AND seat=? AND kind='arrival-estimates' ORDER BY id DESC LIMIT 1").get(room,seat);
    return row?JSON.parse(String(row.payload)):null;
  }
  memoryReviews(room:string,seat:number):ReviewReceipt[]{
    return structuredClone([...this.projection(room,seat).reviews.values()]);
  }

  endSeat(state:AiState,observation:PlayerObservation){
    if(observation.view.self.active&&!observation.view.match?.ended)throw Error('Seat is not confirmed ended');
    this.closeSeat(state,observation.view.tick*600+observation.secondsSinceLastTick,observation.view.match?.ended?'match-ended':'eliminated');
  }
  closeSeat(state:AiState,seconds:number,reason:'eliminated'|'match-ended'|'lobby-cancelled'){
    const notes=this.notebook(state.roomId,state.lobbySeat,-Infinity),reminders=this.reminders(state.roomId,state.lobbySeat);
    const campaigns=this.latest<{plans:Campaign[]}>(state.roomId,state.lobbySeat,'campaign-state')?.plans??[];
    const next={...state,enabled:false,status:'ended' as const,error:null,nextReview:null};
    const already=this.latest(state.roomId,state.lobbySeat,'memory-session-ended');
    if(!already||notes.length||reminders.length||campaigns.some(activeCampaign)){
      const events=[...notes.map(n=>({kind:'notebook-removed',details:{id:n.id,reason:'seat-ended'}})),
        ...reminders.map(r=>({kind:'reminder-cancelled',details:{id:r.id,reason:'seat-ended'}})),
        {kind:'campaign-state',details:{plans:campaigns.map(p=>activeCampaign(p)?{...p,stage:'cancelled',allocations:[],issues:['本人已出局或对局结束；历史计划归档，不代表战役完成']}:p)}},
        {kind:'memory-session-ended',details:{seconds,reason,notes:notes.length,reminders:reminders.length,campaigns:campaigns.filter(activeCampaign).length}},
        {kind:'ended',details:null}];
      this.saveEvents(next,events);
    }else if(state.status!=='ended'||state.enabled)this.save(next,'ended');
    Object.assign(state,next);
  }
  notebook(room:string,seat:number,now:number):NotebookEntry[]{
    return structuredClone([...this.projection(room,seat).notes.values()].filter(n=>now===-Infinity||isActiveNote(n,now)));
  }

  queryNotebook(room:string,seat:number,now:number,q:NotebookQuery){
    if(!q.archive){
      const latest=this.projection(room,seat).noteCursors;
      const matching=this.notebook(room,seat,now).filter(n=>matchesNote(n,q)&&(latest.get(n.id)??0)<(q.before??Number.MAX_SAFE_INTEGER)).sort((a,b)=>latest.get(b.id)!-latest.get(a.id)!);
      const entries=matching.slice(0,q.limit??32),more=matching.length>entries.length;
      return {historical:false,entries,nextCursor:more?latest.get(entries.at(-1)!.id)!:null};
    }
    // Iterate the private journal backwards; filters precede the page limit.
    const entries:{cursor:number;kind:string;entry:unknown}[]=[];
    let cursor=q.before??Number.MAX_SAFE_INTEGER;
    while(entries.length<=(q.limit??16)){
    const batch=this.db.prepare("SELECT id,kind,payload FROM journal WHERE room=? AND seat=? AND id<? AND kind IN ('notebook-set','notebook-removed') ORDER BY id DESC LIMIT 128").all(room,seat,cursor);
    if(!batch.length)break;
    for(const row of batch){
      cursor=Number(row.id);
      const entry=JSON.parse(String(row.payload));
      if(row.kind==='notebook-removed'){
        if(q.players?.length||q.entities?.length||q.statuses?.length||q.ids?.length&&!q.ids.includes(entry.id)||q.text&&!JSON.stringify(entry).includes(q.text))continue;
      }else if(!matchesNote(entry,q))continue;
      entries.push({cursor:Number(row.id),kind:String(row.kind),entry});
      if(entries.length>(q.limit??16))break;
    }
    }
    const more=entries.length>(q.limit??16);if(more)entries.pop();
    return {historical:true,entries,nextCursor:more?entries.at(-1)!.cursor:null};
  }
  /** Authoritative observation journal only: never writes strategy, starts a model,
   * acknowledges execution, or rebases an in-flight model's private CAS token. */
  observeManualCommands(room:string,seat:number,observation:PlayerObservation){
    if(observation.roomId!==room)throw Error('Manual observation room mismatch');
    const view=observation.manualCommands;if(!view)return false;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const old=this.latest<import('../../../../contracts/src/index.js').ManualCommandView>(room,seat,'manual-commands-observed');
      if(old&&old.version>view.version){this.db.exec('COMMIT');return false;}
      const insert=this.db.prepare('INSERT INTO journal(room,seat,kind,payload) VALUES(?,?,?,?)');
      const write=(kind:string,payload:unknown)=>insert.run(room,seat,kind,JSON.stringify(payload));
      let added=false;
      for(const receipt of view.receipts){
        if(receipt.player!==observation.view.player)throw Error('Manual receipt identity mismatch');
        const existing=this.manualReceipt(room,seat,receipt.id);
        if(existing&&JSON.stringify(existing)!==JSON.stringify(receipt))throw Error('Manual receipt identity conflict');
        if(!existing){write('manual-command-evidence',receipt);added=true;}
      }
      // Exact fleet/schedule reminders become stale after an explicit manual
      // redirection/cancellation. Never infer that their objective was achieved.
      const replaced=new Set(view.receipts.filter(r=>r.version>(old?.version??0)&&
        (r.kind==='cancel-schedule'||['cancel-launch','return-fleet'].includes(r.action?.kind??'')))
        .flatMap(r=>[...r.affectedFleetIds,...r.cancelledScheduleIds,...(r.scheduleId?[r.scheduleId]:[]),...(typeof r.action?.fleetId==='string'?[r.action.fleetId]:[])]));
      for(const reminder of this.reminders(room,seat))if(reminder.entities?.some(id=>replaced.has(id)))
        write('reminder-cancelled',{id:reminder.id,reason:'manual-command-superseded',manualVersion:view.version});
      const advanced=!old||old.version<view.version;
      if(advanced)write('manual-commands-observed',view);
      this.db.exec('COMMIT');return advanced||added;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  manualReviewedReceiptIds(room:string,seat:number):string[]{
    return this.db.prepare("SELECT DISTINCT value FROM journal,json_each(journal.payload,'$.receiptIds') WHERE room=? AND seat=? AND kind='manual-intent-reconciled'").all(room,seat).map(row=>String(row.value));
  }
  /** Undelivered cognitive acknowledgements retain their original authorized
   * facts; this is not a model archive-query capability. */
  pendingManualFacts(room:string,seat:number):import('../../../../contracts/src/index.js').ManualCommandReceipt[]{
    const reviewed=new Set(this.manualReviewedReceiptIds(room,seat));
    return this.db.prepare("SELECT payload FROM journal WHERE room=? AND seat=? AND kind='manual-command-evidence' ORDER BY id").all(room,seat)
      .map(row=>JSON.parse(String(row.payload)) as import('../../../../contracts/src/index.js').ManualCommandReceipt)
      .filter(receipt=>isTacticalManual(receipt)&&!reviewed.has(receipt.id)).sort((a,b)=>a.version-b.version);
  }
  manualReceipt(room:string,seat:number,id:string):import('../../../../contracts/src/index.js').ManualCommandReceipt|undefined{
    const row=this.db.prepare("SELECT payload FROM journal WHERE room=? AND seat=? AND kind='manual-command-evidence' AND json_extract(payload,'$.id')=? ORDER BY id DESC LIMIT 1").get(room,seat,id);
    return row?JSON.parse(String(row.payload)):undefined;
  }
  /** Exact, private receipt lookup. Intents alone are deliberately not evidence. */
  memoryEvidence(room:string,seat:number,reference:string):MemoryEvidence|undefined {
    if(reference.startsWith('manual:'))return manualMemoryEvidence(reference,this.manualReceipt(room,seat,reference.slice(7)));
    if(!reference.startsWith('tool:')||reference.length<=5)return undefined;
    const row=this.db.prepare("SELECT kind,payload FROM journal WHERE room=? AND seat=? AND kind IN ('tool-result','query-result','tool-rejected','batch-item-result','batch-item-unknown') AND json_extract(payload,'$.id')=? ORDER BY id DESC LIMIT 1").get(room,seat,reference.slice(5));
    return row?receiptMemoryEvidence(reference,String(row.kind),JSON.parse(String(row.payload))):undefined;
  }
  hasMemoryEvidence(room:string,seat:number,reference:string){
    const separator=reference.indexOf(':'),kind=reference.slice(0,separator),id=reference.slice(separator+1);
    if(!id)return false;
    if(kind==='manual')return this.memoryEvidence(room,seat,reference)!==undefined;
    if(kind==='tool')return this.memoryEvidence(room,seat,reference)!==undefined;
    if(kind==='note')return !!this.db.prepare("SELECT id FROM journal WHERE room=? AND seat=? AND kind='notebook-set' AND json_extract(payload,'$.id')=? LIMIT 1").get(room,seat,id);
    if(kind==='chat')return !!this.db.prepare(`SELECT id FROM journal WHERE room=? AND seat=? AND kind='tool-result'
      AND json_extract(payload,'$.tool')='say' AND json_type(payload,'$.result.error') IS NULL
      AND json_extract(payload,'$.result.roomId')=? AND json_extract(payload,'$.result.message.id')=? LIMIT 1`).get(room,seat,room,id)||
      !!this.db.prepare(`SELECT journal.id FROM journal,json_each(journal.payload,CASE
        WHEN kind='started' THEN '$.incomingMessages' WHEN kind='messages-read' THEN '$.messages'
        ELSE '$.result.messages' END) AS message WHERE room=? AND seat=? AND
        (kind IN ('started','messages-read') OR kind='tool-result' AND json_extract(payload,'$.tool')='chatHistory')
        AND json_extract(message.value,'$.id')=? LIMIT 1`).get(room,seat,id);
    return false;
  }
  reminders(room:string,seat:number):AiReminder[] {
    return structuredClone([...this.projection(room,seat).reminders.values()].sort((a,b)=>a.atSeconds-b.atSeconds));
  }

  /** Bounded diagnostics only: every query is bound to the caller's existing room and seat. */
  debugActionRows(room:string,seat:number){
    const intents=this.db.prepare(`SELECT j.id,j.payload,(SELECT max(s.id) FROM journal s WHERE s.room=j.room AND s.seat=j.seat AND s.kind='started' AND s.id<j.id) AS round_ref
      FROM journal j WHERE room=? AND seat=? AND kind='tool-intent' AND json_extract(payload,'$.tool') IN ('order','batch') ORDER BY id DESC LIMIT 40`).all(room,seat);
    const rounds=new Set<number>();
    return intents.flatMap(row=>{
      const ref=Number(row.round_ref??row.id);if(!rounds.has(ref)&&rounds.size>=5)return [];rounds.add(ref);
      const start=row.round_ref===null?undefined:this.db.prepare('SELECT payload FROM journal WHERE room=? AND seat=? AND id=?').get(room,seat,ref);
      const basis=start?JSON.parse(String(start.payload)):{};
      const intent=JSON.parse(String(row.payload)),id=intent.id;
      if(typeof id!=='string')return [];
      const ids=[id,...Array.from({length:8},(_,i)=>`${id}-item-${i}`)];
      const events=this.db.prepare(`SELECT kind,CASE WHEN length(CAST(payload AS BLOB))<=65536 THEN payload ELSE NULL END AS payload FROM journal INDEXED BY diagnostic_entity_cursor
        WHERE room=? AND seat=? AND kind IN ('tool-result','tool-rejected','tool-unknown','batch-item-intent','batch-item-result','batch-item-unknown','batch-recovered','write-reconciled')
        AND json_extract(payload,'$.id') IN (${ids.map(()=>'?').join(',')}) ORDER BY id`).all(room,seat,...ids)
        .map(r=>({kind:String(r.kind),payload:r.payload===null?null:JSON.parse(String(r.payload)) as unknown}));
      return [{round:typeof basis.sequence==='number'?basis.sequence:null,tick:typeof basis.tick==='number'?basis.tick:null,intent:intent as unknown,events}];
    });
  }
  debugRows(room:string,seat:number,q:{before?:number;after?:number;limit?:number;kinds?:string[];sequence?:number;from?:number;to?:number}={}){
    const limit=q.limit??20;
    for(const n of [q.before,q.after,q.sequence,q.from,q.to])if(n!==undefined&&(!Number.isSafeInteger(n)||n<0))throw Error('Invalid diagnostic cursor');
    if(!Number.isInteger(limit)||limit<1||limit>100||q.kinds&&(q.kinds.length<1||q.kinds.length>32))throw Error('Invalid diagnostic page');
    const clauses=['room=?','seat=?','id<?','id>?'],args:(string|number)[]=[room,seat,q.before??Number.MAX_SAFE_INTEGER,q.after??0];
    if(q.kinds){clauses.push(`kind IN (${q.kinds.map(()=>'?').join(',')})`);args.push(...q.kinds);}
    if(q.sequence!==undefined){clauses.push("json_extract(payload,'$.sequence')=?");args.push(q.sequence);}
    if(q.from!==undefined){clauses.push("json_extract(payload,'$.startedAt')>=?");args.push(q.from);}
    if(q.to!==undefined){clauses.push("json_extract(payload,'$.startedAt')<=?");args.push(q.to);}
    const rows=this.db.prepare(`SELECT id,kind,CASE WHEN length(CAST(payload AS BLOB))<=65536 THEN payload ELSE NULL END AS payload FROM journal WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args,limit+1);
    const entries=rows.slice(0,limit).map(r=>({id:Number(r.id),kind:String(r.kind),payload:r.payload===null?null:JSON.parse(String(r.payload)) as unknown,unavailable:r.payload===null}));
    return {entries,nextCursor:rows.length>limit?entries.at(-1)!.id:null};
  }
  /** One stable reference per background request; completion updates its queued row logically. */
  debugStrategyCalls(room:string,seat:number,eventKind:string,q:{before:number;after:number;limit:number;from?:number;to?:number}){
    for(const n of [q.before,q.after,q.limit,q.from,q.to])if(n!==undefined&&(!Number.isSafeInteger(n)||n<0))throw Error('Invalid strategy call cursor');
    if(q.limit<1||q.limit>50)throw Error('Invalid strategy call page');
    const clauses=['calls.call_ref<?'],args:(string|number)[]=[room,seat,q.after,eventKind,q.before];
    if(q.from!==undefined){clauses.push("unixepoch(json_extract(j.payload,'$.queuedAt'),'subsec')*1000>=?");args.push(q.from);}
    if(q.to!==undefined){clauses.push("unixepoch(json_extract(j.payload,'$.queuedAt'),'subsec')*1000<=?");args.push(q.to);}
    const rows=this.db.prepare(`WITH calls AS (
      SELECT min(id) AS call_ref,max(id) AS latest_ref FROM journal
      WHERE room=? AND seat=? AND id>? AND kind=?
      GROUP BY json_extract(payload,'$.callId')
    ) SELECT calls.call_ref AS id,CASE WHEN length(CAST(j.payload AS BLOB))<=2097152 THEN j.payload ELSE NULL END AS payload
      FROM calls JOIN journal j ON j.id=calls.latest_ref WHERE ${clauses.join(' AND ')} ORDER BY calls.call_ref DESC LIMIT ?`).all(...args,q.limit+1);
    return {entries:rows.slice(0,q.limit).map(r=>({id:Number(r.id),payload:r.payload===null?null:JSON.parse(String(r.payload)) as unknown,unavailable:r.payload===null})),nextCursor:rows.length>q.limit?Number(rows[q.limit-1]!.id):null};
  }
  debugGetStrategyCall(room:string,seat:number,ref:number,eventKind:string):unknown{
    if(!Number.isSafeInteger(ref)||ref<1)throw Error('Invalid call reference');
    const row=this.db.prepare(`SELECT CASE WHEN length(CAST(latest.payload AS BLOB))<=2097152 THEN latest.payload ELSE NULL END AS payload
      FROM journal origin JOIN journal latest ON latest.room=origin.room AND latest.seat=origin.seat
      AND latest.kind=origin.kind AND json_extract(latest.payload,'$.callId')=json_extract(origin.payload,'$.callId')
      WHERE origin.room=? AND origin.seat=? AND origin.id=? AND origin.kind=?
      AND origin.id>coalesce((SELECT max(id) FROM journal cleared WHERE cleared.room=origin.room AND cleared.seat=origin.seat AND cleared.kind='diagnostics-cleared'),0)
      ORDER BY latest.id DESC LIMIT 1`).get(room,seat,ref,eventKind);
    return row?.payload?JSON.parse(String(row.payload)):null;
  }
  /** Only compact execution fields; large tool bodies and prompts stay in storage. */
  debugToolUsageRows(room:string,seat:number,after:number){
    return this.db.prepare(`SELECT id,kind,json_extract(payload,'$.sequence') AS sequence,
      json_extract(payload,'$.id') AS logicalId,json_extract(payload,'$.tool') AS tool
      FROM journal WHERE room=? AND seat=? AND id>? AND kind IN ('started','call-reserved','tool-intent')
      ORDER BY id LIMIT 200`).all(room,seat,after).map(row=>({id:Number(row.id),kind:String(row.kind),sequence:row.sequence,logicalId:row.logicalId,tool:row.tool}));
  }
  debugExecutionRows(room:string,seat:number,after:number){
    const rows=this.db.prepare(`SELECT id,kind,json_extract(payload,'$.sequence','$.diagnostic.sequence','$.id','$.step','$.attempt',
      '$.reason','$.code','$.result.error','$.result.results[#-1].error','$.result.complete','$.diagnostic.cause.message',
      '$.diagnostic.cause.code','$.operation','$.diagnostic.at','$.at','$.phase','$.diagnostic.phase') AS metrics
      FROM journal WHERE room=? AND seat=? AND id>? AND kind IN
      ('started','call-reserved','call-failed','error','observation-error','runtime-error','tool-rejected','tool-result','reply-superseded','provider-retry','recovery-started')
      ORDER BY id LIMIT 100`).all(room,seat,after);
    return rows.map(row=>({id:Number(row.id),kind:String(row.kind),metrics:JSON.parse(String(row.metrics)) as unknown[]}));
  }
  /** Only terminal model failure evidence, never prompts, stacks or provider output. */
  debugModelFailureRows(room:string,seat:number,after:number){
    const rows=this.db.prepare(`SELECT id,kind,json_extract(payload,
      '$.diagnostic.httpStatus','$.diagnostic.provider.httpStatus',
      '$.diagnostic.evidence.httpStatuses','$.diagnostic.provider.evidence.httpStatuses',
      '$.sequence','$.diagnostic.sequence',
      '$.diagnostic.evidence.finishedAt','$.diagnostic.provider.evidence.finishedAt','$.diagnostic.at','$.at') AS metrics
      FROM journal WHERE room=? AND seat=? AND id>? AND (kind IN
      ('call-failed','commander-call-failed') OR kind GLOB 'mode-*-task-failed') ORDER BY id LIMIT 100`).all(room,seat,after);
    return rows.map(row=>({id:Number(row.id),kind:String(row.kind),metrics:JSON.parse(String(row.metrics)) as unknown[]}));
  }
  /** Compact read-only metrics: full prompts/replies never enter aggregate pages. */
  debugStatsRows(room:string,seat:number,before=Number.MAX_SAFE_INTEGER,limit=100){
    if(!Number.isSafeInteger(before)||before<1||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid diagnostic stats page');
    const rows=this.db.prepare(`SELECT j.id,
      CASE WHEN length(CAST(j.payload AS BLOB))<=65536 THEN json_extract(j.payload,'$.sequence','$.step','$.attempt','$.promptContext','$.promptTools.results.total','$.promptTools.measurement') ELSE NULL END AS metrics,
      CASE WHEN d.payload IS NOT NULL THEN json_extract(d.payload,'$.round','$.step','$.attempt','$.durationMs','$.usage','$.promptReceiptBreakdown','$.promptDecisionBreakdown') ELSE NULL END AS capture,
      CASE WHEN d.payload IS NOT NULL AND length(CAST(j.payload AS BLOB))<=65536
        AND json_type(j.payload,'$.promptContext.sections')='object' AND json_extract(d.payload,'$.bodyRetention') IS NOT 'summary-only'
        AND COALESCE(json_type(j.payload,'$.promptContext.decisionContext'),'null')!='object'
        THEN length(CAST(json_extract(d.payload,'$.promptText') AS BLOB)) ELSE NULL END AS prompt_bytes
      FROM journal j LEFT JOIN diagnostic_calls d ON d.room=j.room AND d.seat=j.seat AND d.call_ref=j.id AND length(CAST(d.payload AS BLOB))<=2097152
      WHERE j.room=? AND j.seat=? AND j.kind='call-reserved' AND j.id<? ORDER BY j.id DESC LIMIT ?`).all(room,seat,before,limit+1);
    const entries=rows.slice(0,limit).map(row=>{
      const metrics:unknown[]=row.metrics===null?[]:JSON.parse(String(row.metrics)),capture:unknown[]|null=row.capture===null?null:JSON.parse(String(row.capture));
      return {id:Number(row.id),payload:{sequence:metrics[0],step:metrics[1],attempt:metrics[2],promptContext:metrics[3],promptTools:{results:{total:metrics[4]},measurement:metrics[5]}},
        capture:capture?{round:capture[0],step:capture[1],attempt:capture[2],durationMs:capture[3],usage:capture[4],promptReceiptBreakdown:capture[5],promptDecisionBreakdown:capture[6]}:null,promptBytes:row.prompt_bytes===null?null:Number(row.prompt_bytes)};
    });
    return {entries,nextCursor:rows.length>limit?entries.at(-1)!.id:null};
  }
  /** Optional historical detail backfill; caller owns the request-wide byte budget. */
  debugStatsPrompt(room:string,seat:number,callRef:number,maxBytes:number):string|null{
    if(!Number.isSafeInteger(callRef)||callRef<1||!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>4194304)throw Error('Invalid diagnostic prompt budget');
    const row=this.db.prepare(`SELECT json_extract(payload,'$.promptText') AS prompt FROM diagnostic_calls
      WHERE room=? AND seat=? AND call_ref=? AND length(CAST(payload AS BLOB))<=2097152
      AND json_type(payload,'$.promptText')='text' AND length(CAST(json_extract(payload,'$.promptText') AS BLOB))<=?`).get(room,seat,callRef,maxBytes);
    return row?String(row.prompt):null;
  }
  debugCallTrail(room:string,seat:number,callRef:number){
    if(!Number.isSafeInteger(callRef)||callRef<1)throw Error('Invalid call reference');
    const rows=this.db.prepare(`SELECT kind,json_extract(payload,'$.id') AS logicalId,json_extract(payload,'$.tool') AS tool,
      json_extract(payload,'$.summary') AS summary,json_extract(payload,'$.result.error') AS error,
      json_extract(payload,'$.result.complete') AS complete,json_extract(payload,'$.result.results[#-1].error') AS batchError,
      COALESCE(json_extract(payload,'$.diagnostic.tick'),json_extract(payload,'$.result.observation.view.tick')) AS resultTick FROM journal
      WHERE room=? AND seat=? AND id>? AND id<COALESCE((SELECT min(id) FROM journal WHERE room=? AND seat=? AND kind='call-reserved' AND id>?),?)
      AND kind IN ('tool-intent','tool-result','tool-rejected','tool-unknown','reply-superseded','call-failed','paused','completed') ORDER BY id LIMIT 12`)
      .all(room,seat,callRef,room,seat,callRef,Number.MAX_SAFE_INTEGER);
    const intent=rows.find(r=>r.kind==='tool-intent');
    if(typeof intent?.logicalId==='string'){
      // A recovery can arrive in a later round. Join by the original logical
      // operation identity; never attach the next tool's or sibling's result.
      const recovered=this.db.prepare(`SELECT kind,json_extract(payload,'$.tool') AS tool,
        json_extract(payload,'$.status') AS resolutionStatus,
        json_extract(payload,'$.result.complete') AS complete,
        CASE WHEN json_extract(payload,'$.status') IN ('rejected','not-executed','unknown') THEN json_extract(payload,'$.reason') END AS error,
        json_extract(payload,'$.result.results[#-1].error') AS batchError,
        NULL AS resultTick FROM journal WHERE room=? AND seat=? AND id>?
        AND kind IN ('write-reconciled','batch-recovered') AND json_extract(payload,'$.id')=? ORDER BY id DESC LIMIT 1`).get(room,seat,callRef,intent.logicalId);
      if(recovered)rows.push(recovered);
    }
    return rows;
  }
  debugRoundBounds(room:string,seat:number,sequence:number){
    if(!Number.isSafeInteger(sequence)||sequence<0)throw Error('Invalid round');
    const row=this.db.prepare("SELECT id FROM journal WHERE room=? AND seat=? AND kind='started' AND json_extract(payload,'$.sequence')=? ORDER BY id DESC LIMIT 1").get(room,seat,sequence);
    if(!row)return null;const start=Number(row.id);
    const next=this.db.prepare("SELECT id FROM journal WHERE room=? AND seat=? AND kind='started' AND id>? ORDER BY id LIMIT 1").get(room,seat,start);
    return {after:start-1,before:next?Number(next.id):Number.MAX_SAFE_INTEGER};
  }
  debugEntityPage(room:string,seat:number,entity:'notebook'|'reminders',before=Number.MAX_SAFE_INTEGER,limit=50,includeClosed=false){
    if(!Number.isSafeInteger(before)||before<1||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid entity page');
    const kinds=entity==='notebook'?['notebook-set','notebook-removed']:['reminder-set','reminder-cancelled','reminder-fired'];
    const latestKinds=includeClosed?[kinds[0]!]:kinds;
    // Bound candidate scanning as well as returned rows. An empty page may still have a cursor.
    const scanLimit=Math.max(100,limit*4);
    const candidates=this.db.prepare('SELECT id FROM journal WHERE room=? AND seat=? AND kind=? AND id<? ORDER BY id DESC LIMIT ?').all(room,seat,kinds[0]!,before,scanLimit+1);
    if(!candidates.length)return {entries:[],nextCursor:null};
    const cutoff=Number(candidates[Math.min(scanLimit,candidates.length)-1]!.id);
    const rows=this.db.prepare(`SELECT j.id,${includeClosed?`(SELECT n.kind FROM journal n WHERE n.room=j.room AND n.seat=j.seat AND json_extract(n.payload,'$.id')=json_extract(j.payload,'$.id') AND n.kind IN (${kinds.map(k=>`'${k}'`).join(',')}) ORDER BY n.id DESC LIMIT 1) AS kind`:'j.kind'},CASE WHEN length(CAST(j.payload AS BLOB))<=65536 THEN j.payload ELSE NULL END AS payload FROM journal j WHERE j.room=? AND j.seat=? AND j.kind=? AND j.id<? AND j.id>=? AND NOT EXISTS (SELECT 1 FROM journal n WHERE n.room=j.room AND n.seat=j.seat AND json_extract(n.payload,'$.id')=json_extract(j.payload,'$.id') AND n.id>j.id AND n.kind IN (${latestKinds.map(()=>'?').join(',')})) ORDER BY j.id DESC LIMIT ?`).all(room,seat,kinds[0]!,before,cutoff,...latestKinds,limit+1);
    const entries=rows.slice(0,limit).map(r=>({id:Number(r.id),kind:String(r.kind),payload:r.payload===null?null:JSON.parse(String(r.payload)) as unknown,unavailable:r.payload===null}));
    return {entries,nextCursor:rows.length>limit?entries.at(-1)!.id:candidates.length>scanLimit?cutoff:null};
  }
  debugGetEvent(room:string,seat:number,id:number):unknown{
    if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid event reference');
    const row=this.db.prepare('SELECT payload FROM journal WHERE room=? AND seat=? AND id=? AND length(CAST(payload AS BLOB))<=1048576').get(room,seat,id);
    return row?JSON.parse(String(row.payload)):null;
  }
  debugReadTransaction<T>(read:()=>T):T{
    this.db.exec('BEGIN');try{const result=read();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  debugPutCall(room:string,seat:number,callRef:number,payload:unknown){
    if(!Number.isSafeInteger(callRef)||callRef<1)throw Error('Invalid call reference');
    const value=JSON.stringify(payload);if(Buffer.byteLength(value)>2097152)throw Error('Diagnostic call too large');
    this.db.exec('BEGIN');
    try{
      this.db.prepare('INSERT INTO diagnostic_calls(room,seat,call_ref,payload) VALUES(?,?,?,?) ON CONFLICT(room,seat,call_ref) DO UPDATE SET payload=excluded.payload').run(room,seat,callRef,value);
      this.trimCallBodies(room,seat);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private trimCallBodies(room:string,seat:number){
    this.callRetention.trim(room,seat);
  }
  clearDiagnosticCalls(room:string,seat:number){
    this.db.exec('BEGIN');try{
      this.db.prepare("DELETE FROM journal WHERE room=? AND seat=? AND kind='call-reserved'").run(room,seat);
      this.db.prepare('DELETE FROM diagnostic_calls WHERE room=? AND seat=?').run(room,seat);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  debugGetCall(room:string,seat:number,callRef:number):unknown{
    if(!Number.isSafeInteger(callRef)||callRef<1)throw Error('Invalid call reference');
    const row=this.db.prepare('SELECT payload FROM diagnostic_calls WHERE room=? AND seat=? AND call_ref=? AND length(CAST(payload AS BLOB))<=2097152').get(room,seat,callRef);
    return row?JSON.parse(String(row.payload)):null;
  }
  historyPage(room:string,seat:number,before?:number) {
    if(!Number.isSafeInteger(seat)||seat<0||before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw Error('Invalid history cursor');
    const rows=this.db.prepare('SELECT id,kind,payload FROM journal WHERE room=? AND seat=? AND id<? ORDER BY id DESC LIMIT 31')
      .all(room,seat,before??Number.MAX_SAFE_INTEGER);
    const entries=rows.slice(0,30).map(r=>({id:Number(r.id),...this.readHistoryRow(room,seat,String(r.kind),String(r.payload))}));
    return {entries,nextCursor:rows.length>30?entries.at(-1)!.id:null};
  }
  /** System-owned unresolved writes are selected by durable identity, never by
   * a recent-history count. This is not a model historical-read capability. */
  pendingWriteEvidence(room:string,seat:number,ids:readonly string[]) {
    const read=this.db.prepare("SELECT kind,payload FROM journal WHERE room=? AND seat=? AND kind IN ('tool-intent','tool-unknown','tool-rejected','tool-result','batch-item-intent','batch-item-result','batch-item-unknown','batch-recovered') AND json_extract(payload,'$.id')=? ORDER BY id DESC");
    return [...new Set(ids)].map(id=>{
      const rows=read.all(room,seat,id).map(r=>({kind:String(r.kind),payload:JSON.parse(String(r.payload)) as Record<string,unknown>}));
      const intent=rows.find(r=>r.kind==='tool-intent'||r.kind==='batch-item-intent')?.payload;
      const outcome=rows.find(r=>!['tool-intent','batch-item-intent'].includes(r.kind));
      return {id,tool:typeof intent?.tool==='string'?intent.tool:'unknown',status:'unknown',intentRecorded:!!intent,
        ...(typeof (intent?.basisRevision)==='string'?{basisRevision:String(intent?.basisRevision)}:{}),
        ...(intent?.arguments!==undefined?{arguments:intent.arguments}:{}),
        evidence:outcome?{kind:outcome.kind,result:outcome.payload.result??outcome.payload,...(outcome.payload.error!==undefined?{error:outcome.payload.error}:{})}:{kind:'no-durable-outcome'},
        meaning:'程序尚未核实结果，禁止重发；缺少回执不表示未执行'};
    });
  }
  decisionPage(room:string,seat:number,before?:number) {
    if(!Number.isSafeInteger(seat)||seat<0||before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw Error('Invalid history cursor');
    const starts=this.db.prepare("SELECT id,payload FROM journal WHERE room=? AND seat=? AND kind='started' AND id<? ORDER BY id DESC LIMIT 9")
      .all(room,seat,before??Number.MAX_SAFE_INTEGER);
    const entries=starts.slice(0,8).map(start=>{
      const end=this.db.prepare("SELECT id FROM journal WHERE room=? AND seat=? AND kind='started' AND id>? ORDER BY id LIMIT 1").get(room,seat,Number(start.id));
      const rows=this.db.prepare('SELECT kind,payload FROM journal WHERE room=? AND seat=? AND id>=? AND id<? ORDER BY id')
        .all(room,seat,Number(start.id),end?Number(end.id):Number.MAX_SAFE_INTEGER).map(r=>({kind:String(r.kind),p:JSON.parse(String(r.payload))}));
      const meta=JSON.parse(String(start.payload))??{};
      const steps=rows.filter(r=>r.kind==='tool-intent').map(({p})=>{
        const outcome=[...rows].reverse().find(r=>['tool-result','tool-rejected','tool-unknown','batch-recovered'].includes(r.kind)&&r.p.id===p.id);
        const partial=outcome&&p.tool==='batch'&&outcome.p.result?.complete===false;
        const shown=outcome?{result:projectModelData(outcome.p.result)}:undefined;
        return {...p,status:partial?'partial':outcome?(outcome.kind==='tool-rejected'?'rejected':outcome.kind==='tool-unknown'?'unconfirmed':'success'):'unconfirmed',result:shown?.result,...(outcome?.p.diagnostic?{diagnostic:outcome.p.diagnostic}:{})};
      });
      const updates=rows.filter(r=>r.kind==='task-updated').map(r=>r.p);
      const latestTask=updates.at(-1);
      const incomingMessages=[...new Map([...(meta.incomingMessages??[]),...rows.filter(r=>r.kind==='messages-read').flatMap(r=>r.p.messages??[])].map(m=>[`${m.from}:${m.id}`,m])).values()];
      const terminal=rows.find(r=>r.kind==='completed');
      const yielded=terminal?.p?.reason==='time-budget-yield';
      const error=rows.find(r=>r.kind==='error');
      const usage=rows.filter(r=>r.kind==='usage'&&Number.isSafeInteger(r.p?.tokens)&&r.p.tokens>=0);
      const elapsed=rows.filter(r=>['call-completed','call-failed'].includes(r.kind)&&Number.isFinite(r.p?.roundElapsedMs)&&r.p.roundElapsedMs>=0).map(r=>r.p.roundElapsedMs as number);
      const durationMs=Number.isFinite(terminal?.p?.durationMs)&&terminal!.p.durationMs>=0?terminal!.p.durationMs as number:null;
      const stats={tokens:usage.length?usage.reduce((sum,r)=>sum+r.p.tokens,0):null,durationMs:durationMs??(elapsed.length?Math.max(...elapsed):null),durationComplete:durationMs!==null};
      return {id:Number(start.id),kind:'decision',payload:{...meta,...(latestTask?{category:latestTask.category,weight:latestTask.weight,reasons:[...new Set([...(meta.reasons??[]),...updates.flatMap(u=>u.reasons??[])])]}:{}),sequence:meta.sequence??rows.find(r=>r.kind==='call-reserved')?.p.sequence,
        stats,
        incomingMessages,
        contextExpanded:rows.some(r=>r.kind==='context-expanded'),
        status:error?'error':yielded?'pending-continuation':terminal?'completed':rows.some(r=>r.kind==='paused')?'interrupted':'thinking',
        error:error?.p.reason,steps,
        diagnostics:rows.filter(r=>['error','observation-error','call-failed'].includes(r.kind)&&r.p.diagnostic).slice(-12).map(r=>({kind:r.kind,...r.p}))}};
    });
    return {entries,nextCursor:starts.length>8?entries.at(-1)!.id:null};
  }
}
