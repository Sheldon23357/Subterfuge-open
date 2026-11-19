import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,chmodSync,existsSync,openSync,closeSync,fsyncSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {backupCheckpointDatabase} from '../storage/checkpoint-files.js';
import {protocolIdentifier} from '../../../../contracts/src/index.js';
import type {PlayerProtocolClient,ProtocolClientStore,ProtocolCheckpointStatus} from '../../../../player-sdk/src/index.js';
interface LocalCheckpoint {checkpointId:string;roomEpoch:string;startedAtMs:number;released:boolean;receiptId?:string;sha256?:string}
export interface ProtocolCheckpointHooks {
  beginDrain():void;idle():boolean;unresolved():boolean;freeze():Promise<void>;
  resume():Promise<void>;fail(error:unknown):void;
}
/** Official policy only. No model, strategy or local file data is sent by this coordinator. */
export class ProtocolCheckpointParticipant {
  private pending:Promise<void>|null=null;
  private stopped=false;
  private local:LocalCheckpoint|null;
  private held=true;
  private begun=false;
  private healthy=true;
  private readonly root:string;
  error:string|null=null;
  constructor(private readonly client:PlayerProtocolClient,private readonly store:ProtocolClientStore,storeDirectory:string,private readonly database:string,private readonly hooks:ProtocolCheckpointHooks){
    this.root=join(resolve(storeDirectory),'protocol-checkpoints');
    const saved=store.load().application.coordinatedCheckpoint as LocalCheckpoint|null|undefined;
    if(saved){protocolIdentifier(saved.checkpointId);protocolIdentifier(saved.roomEpoch);if(!Number.isSafeInteger(saved.startedAtMs)||typeof saved.released!=='boolean')throw Error('Invalid local checkpoint state');if(saved.receiptId!==undefined){protocolIdentifier(saved.receiptId);if(typeof saved.sha256!=='string'||saved.sha256.length!==64||!/^[a-f0-9]{64}$/.test(saved.sha256))throw Error('Invalid local checkpoint digest');}}
    this.local=saved??null;
  }
  get blocked(){return this.held;}
  get busy(){return this.pending!==null;}
  get checkpointId(){return this.local?.checkpointId??null;}
  private persist(){this.store.transaction(s=>{s.application.coordinatedCheckpoint=this.local?structuredClone(this.local):null;});}
  private begin(status:ProtocolCheckpointStatus){
    this.held=true;
    if(!this.local){this.local={checkpointId:status.checkpointId,roomEpoch:status.roomEpoch,startedAtMs:Date.now(),released:false};this.persist();}
    if(!this.begun){this.begun=true;this.hooks.beginDrain();}
  }
  /** The poll is independent of gameplay ticks, and only one request chain may run at a time. */
  poll():Promise<void>{if(this.stopped)return Promise.resolve();if(this.pending)return this.pending;this.pending=this.step().catch(error=>{this.error=error instanceof Error?error.message:'Checkpoint transport unavailable';this.held=true;}).finally(()=>{this.pending=null;});return this.pending;}
  private async step(){
    const status=this.local?await this.client.checkpointHistory(this.local.checkpointId):await this.client.checkpointCurrent();
    if(this.stopped)return;
    if(!status){if(this.local)throw Error('Checkpoint history unavailable; local execution remains paused');this.held=false;this.error=null;return;}
    if(this.local&&status.roomEpoch!==this.local.roomEpoch)throw Error('Checkpoint epoch changed; explicit recovery required');
    const terminal=status.phase==='completed'||status.phase==='aborted';
    if(!this.local&&terminal){this.held=false;return;}
    this.begin(status);
    if(terminal){
      // Never infer completion from a local clock or an empty current response.
      if(!this.hooks.idle())return;
      if(this.healthy&&!this.hooks.unresolved()&&!Object.values(this.client.state.outbox).some(row=>row.state!=='settled'))await this.hooks.resume();else this.hooks.fail(Error('Checkpoint recovery requires explicit resume'));
      if(this.stopped)return;
      this.local=null;this.persist();this.begun=false;this.held=false;this.healthy=true;this.error=null;return;
    }
    if(Date.now()-this.local!.startedAtMs>10*60_000){this.healthy=false;this.error='Checkpoint local safety deadline exceeded';return;}
    if(status.mode!=='coordinated'||!status.participant?.supported||status.participant.sessionId!==this.client.sessionId){this.error='Checkpoint belongs to a previous executor session; waiting for terminal history';return;}
    if(status.phase==='preparing'){
      if(!this.hooks.idle())return;
      // Releasing the original lease retires its fence. Lookup still has to prove every unknown outcome.
      if(!this.local!.released){await this.hooks.freeze();this.local!.released=true;this.persist();}
      await this.client.reconcile();
      if(this.hooks.unresolved()||Object.values(this.client.state.outbox).some(row=>row.state!=='settled')){this.error='Checkpoint waits for durable command reconciliation';return;}
      await this.client.checkpointAck({checkpointId:status.checkpointId,phase:'prepared'});this.error=null;
    }else if(status.phase==='freezing'&&status.participant?.prepared){
      if(!this.hooks.idle()||!this.local!.released)return;
      if(Object.values(this.client.state.outbox).some(row=>row.state!=='settled'))throw Error('Unresolved commands cannot be frozen');
      if(!this.local!.receiptId){
        const receiptId=randomUUID();mkdirSync(this.root,{recursive:true,mode:0o700});if(!lstatSync(this.root).isDirectory()||lstatSync(this.root).isSymbolicLink())throw Error('Checkpoint root must be a real local directory');
        const directory=join(this.root,receiptId);mkdirSync(directory,{mode:0o700});const destination=join(directory,'state.sqlite');
        // FlushFileBuffers on Windows requires a writable handle. The database
        // copy is already closed and owned by this participant at this point.
        backupCheckpointDatabase(this.database,destination);chmodSync(destination,0o600);const backupFd=openSync(destination,'r+');try{fsyncSync(backupFd);}finally{closeSync(backupFd);}
        const bytes=readFileSync(destination),sha256=createHash('sha256').update(bytes).digest('hex');
        const manifest={format:'private-protocol-checkpoint/1',checkpointId:status.checkpointId,scope:this.client.state.scope,receiptId,sha256,bytes:bytes.length,database:'state.sqlite'};
        const file=join(directory,'manifest.json'),fd=openSync(file+'.tmp','wx',0o600);try{writeFileSync(fd,JSON.stringify(manifest));fsyncSync(fd);}finally{closeSync(fd);}renameSync(file+'.tmp',file);
        if(process.platform!=='win32'){const handle=openSync(directory,'r');try{fsyncSync(handle);}finally{closeSync(handle);}}
        this.local={...this.local!,receiptId,sha256};this.persist();
      }
      const local=this.local!,localDirectory=join(this.root,local.receiptId!);if(!existsSync(join(localDirectory,'manifest.json')))throw Error('Local checkpoint receipt has no backup');
      if(createHash('sha256').update(readFileSync(join(localDirectory,'state.sqlite'))).digest('hex')!==local.sha256)throw Error('Local checkpoint backup checksum changed');
      await this.client.checkpointAck({checkpointId:status.checkpointId,phase:'frozen',receiptId:local.receiptId!,sha256:local.sha256!});this.error=null;
    }else if(status.phase==='resuming'&&status.participant?.frozen){
      // The server still holds its write barrier. ACK ready, but no acquisition/model until terminal history.
      await this.client.checkpointAck({checkpointId:status.checkpointId,phase:'resumed'});this.error=null;
    }
  }
  async close(){this.stopped=true;this.held=true;await this.pending;}
}
