import {randomUUID} from 'node:crypto';
import {copyFile,mkdir,readdir,rename,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {atomicCheckpointJson,readCheckpointJson,checkpointDigest,checkpointIdPattern,backupCheckpointDatabase,type CheckpointRequest} from '../../ai/src/index.js';
import {controllerSlots} from './controller-bindings.js';
import {RoomStore} from './room-store.js';
import {PlayerAccess} from './player-access.js';
import {validateControllerBindings} from './controller-bindings.js';
import {CommanderStore} from './commander-store.js';
import {DatabaseSync} from 'node:sqlite';

export interface CheckpointManifest {
 format:'linked-checkpoint/1';id:string;name:string;createdAt:string;roomId:string;tick:number;revision:number;frozenAt:number;autoAdvance:boolean;
 bindings:{seat:number;slot:number}[];legacyResume:number[];controller:boolean;
 files:{path:string;bytes:number;sha256:string}[];
}
interface Host {
 directory:string;
 begin:()=>Promise<{roomId:string;bindings:{seat:number;slot:number}[];autoAdvance:boolean;frozenAt:number}>;
 drain:(expiresAt:number)=>Promise<number[]>;
 freeze:<T>(task:(head:{tick:number;revision:number})=>Promise<T>)=>Promise<T>;
 backupGame:(destination:string)=>Promise<void>;
 thaw:()=>Promise<void>;
 finish:(resume:number[],autoAdvance:boolean)=>void;
}
export async function checkpointFiles(directory:string,prefix=''):Promise<CheckpointManifest['files']>{
 const result:CheckpointManifest['files']=[];
 for(const name of (await readdir(join(directory,prefix))).sort()){
  const path=prefix?prefix+'/'+name:name,stat=await lstat(join(directory,path));
  if(stat.isSymbolicLink())throw Error('存档不允许符号链接');
  if(stat.isDirectory())result.push(...await checkpointFiles(directory,path));
  else if(stat.isFile()&&path!=='manifest.json')result.push({path,...await checkpointDigest(join(directory,path))});
  else if(!stat.isFile())throw Error('Invalid checkpoint file');
 }
 return result;
}
export async function verifyLinkedCheckpoint(directory:string):Promise<CheckpointManifest>{
 const m=await readCheckpointJson(join(directory,'manifest.json')) as CheckpointManifest;
 if(m?.format!=='linked-checkpoint/1'||!checkpointIdPattern.test(m.id)||typeof m.name!=='string'||typeof m.roomId!=='string'||!Number.isSafeInteger(m.tick)||!Number.isSafeInteger(m.revision)||!Number.isSafeInteger(m.frozenAt)||!Array.isArray(m.files)||!m.files.some(f=>f.path==='game/subterfuge.sqlite')||!m.files.some(f=>f.path==='game/lab-ai.sqlite')||typeof m.controller!=='boolean'||!Array.isArray(m.bindings)||!Array.isArray(m.legacyResume)||m.controller&&!m.files.some(f=>f.path==='ai/controller.json'))throw Error('Invalid linked checkpoint manifest');
 for(const file of m.files)if(!/^(game\/(subterfuge\.sqlite|lab-ai\.sqlite|player-access\.json|controller-bindings\.json|browser-eight-chat\.json|commander-chat\.json|player-chat-[a-f0-9]{64}\.json)|ai\/([a-f0-9]{64}\.sqlite|controller-slots\.json|controller\.json))$/.test(file.path))throw Error('Invalid checkpoint file path');
 const files=await checkpointFiles(directory);
 if(JSON.stringify(files)!==JSON.stringify(m.files))throw Error('存档文件缺失或校验和不一致');
 validateControllerBindings(m.bindings,10);
 if(typeof m.autoAdvance!=='boolean'||m.revision<1||m.tick<0||m.frozenAt<0||m.legacyResume.some(s=>!Number.isInteger(s)||s<0||s>9)||!m.controller&&m.bindings.length)throw Error('Invalid linked checkpoint state');
 if(m.files.some(f=>f.path==='game/controller-bindings.json')){
  const binding=await readCheckpointJson(join(directory,'game','controller-bindings.json'));
  if(binding.format!=='controller-bindings/1'||binding.roomId!==m.roomId||JSON.stringify(binding.bindings)!==JSON.stringify(m.bindings))throw Error('保存期间 AI 席位绑定发生变化');
 }else if(m.bindings.length)throw Error('存档缺少 AI 席位绑定');
 const authorityStore=new RoomStore(join(directory,'game','subterfuge.sqlite'),{readOnly:true});let commanderPayload:string|null|undefined;
 try{authorityStore.verify();commanderPayload=authorityStore.readProtocolDocument(m.roomId,'commander','journal');}finally{authorityStore.close();}
 const commander=new CommanderStore(join(directory,'game','commander-chat.json'));
 if(commanderPayload===null)throw Error('Durable checkpoint commander document is missing');
 if(commanderPayload!==undefined){const payload=commanderPayload;await commander.bindDurable({read:()=>payload,initialize:()=>{throw Error('Read-only checkpoint authority');},transact:()=>{throw Error('Read-only checkpoint authority');}});}
 else if(m.files.some(f=>f.path==='game/commander-chat.json'))await commander.load();
 if(m.controller){
  const controller=await readCheckpointJson(join(directory,'ai','controller.json'));
  if(!Array.isArray(controller.seats)||controller.seats.length!==m.bindings.length||!Array.isArray(controller.resume)||controller.resume.some((id:unknown)=>typeof id!=='string'||!controller.seats.some((s:{id:string})=>s.id===id)))throw Error('Invalid checkpoint controller metadata');
  for(const b of m.bindings){
   const seat=controller.seats.find((s:{id:string;seat:number;roomId:string})=>s.id===`ai-${String(b.slot+1).padStart(2,'0')}`&&s.seat===b.seat&&s.roomId===m.roomId);
   if(!seat||typeof seat.store!=='string'||!m.files.some(f=>f.path==='ai/'+seat.store))throw Error('存档 AI 记忆与席位绑定不一致');
   const db=new DatabaseSync(join(directory,'ai',seat.store),{readOnly:true});
   try{
    const row=db.prepare('SELECT payload FROM seats WHERE room=? AND seat=?').get(m.roomId,b.seat);if(!row)throw Error('存档缺少当前 AI 状态');
    const cached=JSON.parse(String(row.payload)).commanderDirectives,authority=commander.read(m.roomId,b.seat).directives;
    if(cached&&(cached.version>authority.version||cached.version===authority.version&&cached.text!==authority.text))throw Error('存档 AI 指挥官指令与私聊记录不一致');
   }finally{db.close();}
  }
 }
 const store=new RoomStore(join(directory,'game','subterfuge.sqlite'),{readOnly:true});
 try{
  store.verify();const saved=store.load();
  if(!saved||saved.revision!==m.revision||saved.room.state.economy.tick!==m.tick||(saved.room.playerRoomId??store.predictionSource().roomId)!==m.roomId)throw Error('存档局面与清单不一致');
  if(saved.room.playerRoomId){const access=new PlayerAccess(await readCheckpointJson(join(directory,'game','player-access.json')));if(access.roomId!==m.roomId)throw Error('存档凭证与对局不一致');}
 }finally{store.close();}
 return m;
}
/** One job at a time; long AI turns never hold the game's SerialExecutor. */
export class LinkedCheckpoints {
 private job:{id:string;name:string;status:string;error?:string;warning?:string}|null=null;
 private running=false;
 constructor(private host:Host,private timeoutMs=600000){}
 status(){return {busy:this.running,job:this.job&&{...this.job}};}
 async list(){
  let names:string[];try{names=await readdir(join(this.host.directory,'checkpoints'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
  const entries=[];
  for(const id of names.filter(n=>checkpointIdPattern.test(n))){const m=await readCheckpointJson(join(this.host.directory,'checkpoints',id,'manifest.json')) as CheckpointManifest;if(m.format==='linked-checkpoint/1'&&m.id===id)entries.push({id,name:m.name,tick:m.tick,createdAt:m.createdAt});}
  return entries.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 }
 start(raw:unknown){
  if(this.running)throw Error('已有联动存档正在保存');
  const body=raw as {name?:unknown};if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>k!=='name')||body.name!==undefined&&(typeof body.name!=='string'||!body.name.trim()||body.name.length>80||/[\x00-\x1f]/.test(body.name)))throw Error('存档名称需为 1～80 个字符');
  const id=randomUUID(),name=typeof body.name==='string'?body.name.trim():new Date().toLocaleString('zh-CN');
  this.running=true;this.job={id,name,status:'waiting'};
  void this.save(id,name);return this.status();
 }
 private async waitController(id:string,status:string,expiresAt:number){
  while(Date.now()<expiresAt){
   try{const response=await readCheckpointJson(join(this.host.directory,'checkpoint-response.json'));if(response.id===id){if(response.status===status)return;if((status==='released'?['release-failed']:['failed','expired','release-failed']).includes(response.status))throw Error(response.error??'AI 控制器存档协调失败');}}
   catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   await new Promise<void>(resolve=>setTimeout(resolve,100));
  }
  throw Error('等待 AI 控制器超时，未完成联动存档');
 }
 private async save(id:string,name:string){
  const h=this.host,root=join(h.directory,'checkpoints'),staging=join(root,'.pending-'+id),expiresAt=Date.now()+this.timeoutMs;
  let context:Awaited<ReturnType<Host['begin']>>|undefined,request:CheckpointRequest|undefined,resume:number[]=[],published=false;
  try{
   context=await h.begin();await mkdir(join(staging,'game'),{recursive:true,mode:0o700});
   const controller=await controllerSlots(h.directory);
   if(context.bindings.length&&!controller.available)throw Error('当前对局绑定的 AI 控制器未在线，无法保存完整存档');
   if(controller.available&&controller.checkpointProtocol!==1)throw Error('AI 控制器尚未加载联动存档功能，请在方便时正常重启控制器');
   if(controller.available){
    request={format:'linked-checkpoint-request/1',id,roomId:context.roomId,bindings:context.bindings,phase:'prepare',expiresAt};
    await atomicCheckpointJson(join(h.directory,'checkpoint-request.json'),request);
   }
   // Observe every drain even when its peer fails; never unlock a still-draining task.
   const results=await Promise.allSettled([h.drain(expiresAt),request?this.waitController(id,'ready',expiresAt):Promise.resolve()]);
   if(results[0]!.status==='fulfilled')resume=results[0]!.value as number[];
   for(const r of results)if(r.status==='rejected')throw r.reason;
   this.job!.status='saving';
   await h.freeze(async head=>{
    await h.backupGame(join(staging,'game','subterfuge.sqlite'));
    backupCheckpointDatabase(join(h.directory,'lab-ai.sqlite'),join(staging,'game','lab-ai.sqlite'));
    for(const file of await readdir(h.directory))if(/^(player-access\.json|controller-bindings\.json|browser-eight-chat\.json|commander-chat\.json|player-chat-[a-f0-9]{64}\.json)$/.test(file)){
     if(!(await lstat(join(h.directory,file))).isFile())throw Error('Invalid game checkpoint source');
     await copyFile(join(h.directory,file),join(staging,'game',file));
    }
    const manifest:CheckpointManifest={format:'linked-checkpoint/1',id,name,createdAt:new Date().toISOString(),roomId:context!.roomId,...head,frozenAt:context!.frozenAt,autoAdvance:context!.autoAdvance,bindings:context!.bindings,legacyResume:resume,controller:!!request,files:await checkpointFiles(staging)};
    await atomicCheckpointJson(join(staging,'manifest.json'),manifest);await verifyLinkedCheckpoint(staging);
    // The controller's bounded freeze must still cover the entire copy and validation.
    if(Date.now()>=expiresAt)throw Error('存档超出安全冻结期限');
    await rename(staging,join(root,id));published=true;
   });
  }catch(e){this.job!.error=e instanceof Error?e.message:'保存失败';}
  finally{
   // Resume clock/write access before reacquiring player control on the controller.
   try{if(context)await h.thaw();}catch{this.job!.warning='游戏时钟恢复失败，请检查服务日志';}
   if(request){try{await atomicCheckpointJson(join(h.directory,'checkpoint-request.json'),{...request,phase:'release'});await this.waitController(id,'released',Date.now()+15000);}catch(error){this.job!.warning='AI 控制器恢复未确认，请检查控制器状态：'+(error instanceof Error?error.message:'未知错误');}}
   try{if(context)h.finish(resume,context.autoAdvance);}catch{this.job!.warning='部分运行状态恢复失败，请检查服务状态';}
   this.job!.status=published?'completed':'failed';this.running=false;
  }
 }
}
