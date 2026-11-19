import {copyFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {backupCheckpointDatabase} from '../controller/storage/checkpoint-files.js';
import {ProtocolPlayerGateway} from '../controller/transport/protocol-gateway.js';
import {agentStoreKey,type RuntimeEntry as Entry} from './runtime-entry.js';
interface CheckpointHost {
 entries:()=>Entry[];entry:(id:string)=>Entry;profile:(id:string)=>{slot:number};
 closing:()=>boolean;storeDirectory:()=>string;profilesPath:()=>string|undefined;
 halt:(entry:Entry,error:unknown,operation:string)=>void;
}
/** Owns the coordinated freeze lifecycle; databases remain owned by their seats. */
export class RuntimeCheckpoints {
 constructor(private readonly host:CheckpointHost){}
 get locked(){return this.checkpointLocked;}
 get settled(){return this.checkpointSettled;}
  private checkpointLocked=false;
  private checkpointSettled=false;
  private checkpointResume:string[]=[];
  get checkpointActive(){return this.checkpointLocked||this.host.entries().some(e=>!!e.checkpoint?.checkpointId);}
  private assertCheckpointIdle(){if(this.checkpointActive)throw Error('联动存档进行中，请稍后操作');}
  beginCheckpointDrain(entries:Entry[]){for(const e of entries)e.commander.beginCheckpointDrain();}
  async freezeCheckpointEntry(e:Entry){
    e.commander.freezeCheckpoint();await e.gateway.release();
    // Drain samples produced by the final requests before the database freezes.
    e.store.flushTimings();
  }
  async resumeCheckpointEntry(e:Entry){try{if(!(e.gateway instanceof ProtocolPlayerGateway&&e.gateway.writable))await e.gateway.acquire();if(e.gateway instanceof ProtocolPlayerGateway)await e.gateway.client.snapshot();}catch(error){this.host.halt(e,error,'checkpoint-control-acquire');throw error;}}
  /** Stop new polls first. Existing turns keep their leases until naturally settled. */
  async prepareCheckpoint(destination:string,roomId:string,bindings:{seat:number;slot:number}[],expiresAt:number){
    this.assertCheckpointIdle();this.checkpointLocked=true;
    try{
      const entries=this.host.entries();
      this.beginCheckpointDrain(entries);
      if(bindings.some(b=>!entries.some(e=>e.config.roomId===roomId&&e.config.lobbySeat===b.seat&&this.host.profile(e.config.id).slot===b.slot))||entries.some(e=>e.config.roomId!==roomId||!bindings.some(b=>b.seat===e.config.lobbySeat&&b.slot===this.host.profile(e.config.id).slot)))throw Error('存档的 AI 绑定与控制器不一致');
      while(entries.some(e=>e.active||e.eventObservation||e.backgroundObservation||e.starting||e.stopping||e.renewing||e.commander.busy)){
        if(Date.now()>=expiresAt||this.host.closing())throw Error('等待 AI 收尾超时，未生成存档');
        await new Promise<void>(resolve=>setTimeout(resolve,50));
      }
      // Freeze only after the active request and its durable receipt have completed.
      this.checkpointResume=entries.filter(e=>e.desired&&e.runner.state.enabled&&e.runner.state.status!=='ended').map(e=>e.config.id);
      for(const e of entries)e.commander.freezeCheckpoint();
      this.checkpointSettled=true;
      // Release only transport ownership. Keep completed wake state, memory and
      // review deadlines unchanged; saving must not synthesize a pause/replan.
      await Promise.all(entries.map(e=>this.freezeCheckpointEntry(e)));
      await mkdir(destination,{recursive:true,mode:0o700});
      // A linked checkpoint contains only the databases referenced by this
      // controller's validated seat bindings. Historical or unrelated private
      // stores remain in the runtime directory and are not part of this room's
      // restore set.
      for(const e of entries){
        const name=agentStoreKey(e.config)+'.sqlite';
        backupCheckpointDatabase(join(this.host.storeDirectory(),name),join(destination,name));
      }
      const profilesPath=this.host.profilesPath();if(profilesPath)await copyFile(profilesPath,join(destination,'controller-slots.json'));
      return {resume:[...this.checkpointResume],seats:entries.map(e=>({id:e.config.id,roomId:e.config.roomId,seat:e.config.lobbySeat,store:agentStoreKey(e.config)+'.sqlite'}))};
    }catch(error){await this.releaseCheckpoint();throw error;}
  }
  async releaseCheckpoint(){
    const resume=this.checkpointResume;this.checkpointResume=[];
    const results=await Promise.allSettled(resume.map(async id=>{const e=this.host.entry(id);await this.resumeCheckpointEntry(e);}));
    for(const e of this.host.entries())e.commander.releaseCheckpoint();
    this.checkpointSettled=false;this.checkpointLocked=false;
    if(results.some(r=>r.status==='rejected'))throw Error('存档结束，但部分 AI 未能恢复运行，请检查控制器');
  }
}
