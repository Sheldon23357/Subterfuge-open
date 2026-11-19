import {randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import type {CheckpointAckOutboxEntry} from './checkpoints.js';
import type {ProtocolMutationRequest,ProtocolReceipt,ProtocolScope} from '../../contracts/src/protocol-index.js';

/** No strategy, model credentials, prompts, or AI memory are part of the transport store. */
export interface OutboxEntry {
  scope:ProtocolScope;
  request:ProtocolMutationRequest;
  intentDigest:string;
  attempts:number;
  state:'prepared'|'unknown'|'accepted'|'settled'|'blocked';
  receipt:ProtocolReceipt|null;
  reason:string|null;
}
export interface ProtocolClientState {
  format:'player-sdk-store/1';
  scope:ProtocolScope|null;
  streamEpoch:string|null;
  cursor:string|null;
  sequence:string;
  snapshot:Record<string,unknown>|null;
  decisionInputVersion:string|null;
  needsSnapshot:boolean;
  safetyStop:string|null;
  outbox:Record<string,OutboxEntry>;
  /** Optional in older stores; ack intent is durable before transmission. */
  checkpointOutbox?:Record<string,CheckpointAckOutboxEntry>;
  /** Application-owned materialized event state, committed together with the cursor. */
  application:Record<string,unknown>;
}
export function emptyProtocolClientState():ProtocolClientState {
  return {format:'player-sdk-store/1',scope:null,streamEpoch:null,cursor:null,sequence:'0',snapshot:null,decisionInputVersion:null,needsSnapshot:true,safetyStop:null,outbox:{},application:{}};
}
/** transaction must durably commit all changes or none, and must not run async callbacks. */
export interface ProtocolClientStore {
  load():ProtocolClientState;
  transaction<T>(apply:(draft:ProtocolClientState)=>T):T;
  /** Optional indexed projection; results must be detached from durable state. */
  outboxEntries?(states:readonly OutboxEntry['state'][],includeScheduled?:boolean):OutboxEntry[];
  /** Optional indexed lookup, including settled history for idempotency. */
  outboxEntry?(key:string):OutboxEntry|undefined;
  /** Optional narrow read: permission checks need no observation or command history. */
  readSafetyStop?():ProtocolClientState['safetyStop'];
}
export class MemoryProtocolClientStore implements ProtocolClientStore {
  private state=emptyProtocolClientState();
  load(){return structuredClone(this.state);}
  transaction<T>(apply:(draft:ProtocolClientState)=>T):T {
    const draft=this.load(),result=apply(draft);
    if(result instanceof Promise)throw Error('Transport transactions must be synchronous');
    this.state=structuredClone(draft);return result;
  }
}
/** Single-host private durable adapter. Lock collisions, including abandoned crash locks, fail closed.
 * For automatic crash recovery use a transactional database adapter (the official runner does). */
export class FileProtocolClientStore implements ProtocolClientStore {
  constructor(readonly path:string){mkdirSync(dirname(path),{recursive:true,mode:0o700});}
  load():ProtocolClientState {
    if(!existsSync(this.path))return emptyProtocolClientState();
    if(statSync(this.path).size>32*1024*1024)throw Error('Transport store exceeds size limit');
    const value=JSON.parse(readFileSync(this.path,'utf8')) as ProtocolClientState;
    if(value?.format!=='player-sdk-store/1'||!value.outbox||!value.application||!/^\d+$/.test(value.sequence))throw Error('Invalid private transport store');
    return value;
  }
  transaction<T>(apply:(draft:ProtocolClientState)=>T):T {
    const lock=this.path+'.lock';let fd:number;
    try{fd=openSync(lock,'wx',0o600);}catch(error){
      if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('Transport store is busy or has an abandoned lock; inspect ownership before recovery');
      throw error;
    }
    let temporary:string|undefined;
    try{
      writeFileSync(fd,String(process.pid));fsyncSync(fd);
      const draft=this.load(),result=apply(draft);
      if(result instanceof Promise)throw Error('Transport transactions must be synchronous');
      const data=JSON.stringify(draft);if(Buffer.byteLength(data)>32*1024*1024)throw Error('Transport store exceeds size limit');
      temporary=this.path+'.tmp-'+randomUUID();const output=openSync(temporary,'wx',0o600);
      try{writeFileSync(output,data);fsyncSync(output);}finally{closeSync(output);}
      renameSync(temporary,this.path);temporary=undefined;
      // Directory fsync makes the rename durable on supported POSIX filesystems.
      if(process.platform!=='win32'){const directory=openSync(dirname(this.path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}}
      return result;
    }finally{closeSync(fd);if(temporary&&existsSync(temporary))unlinkSync(temporary);unlinkSync(lock);}
  }
}
