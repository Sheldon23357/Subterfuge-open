import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export const checkpointIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface CheckpointRequest {format:'linked-checkpoint-request/1';id:string;roomId:string;bindings:{seat:number;slot:number}[];expiresAt:number;phase:'prepare'|'release'}
export function parseCheckpointRequest(value:unknown):CheckpointRequest{
 const v=value as CheckpointRequest;
 if(!v||Object.keys(v).sort().join(',')!=='bindings,expiresAt,format,id,phase,roomId'||v.format!=='linked-checkpoint-request/1'||!checkpointIdPattern.test(v.id)||typeof v.roomId!=='string'||!v.roomId||v.roomId.length>200||/[\x00-\x1f]/.test(v.roomId)||!Number.isSafeInteger(v.expiresAt)||!['prepare','release'].includes(v.phase)||!Array.isArray(v.bindings)||v.bindings.length>8||v.bindings.some(b=>!b||Object.keys(b).sort().join(',')!=='seat,slot'||!Number.isInteger(b.seat)||b.seat<0||b.seat>9||!Number.isInteger(b.slot)||b.slot<0||b.slot>7)||new Set(v.bindings.map(b=>b.seat)).size!==v.bindings.length||new Set(v.bindings.map(b=>b.slot)).size!==v.bindings.length)throw Error('Invalid checkpoint request');
 return v;
}
async function retrySharing<T>(operation:()=>Promise<T>):Promise<T>{
 for(let attempt=0;;attempt++)try{return await operation();}catch(error){
  if(attempt>=8||!['EBUSY','EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw error;
  await new Promise<void>(resolve=>setTimeout(resolve,25*(attempt+1)));
 }
}
export async function atomicCheckpointJson(path:string,value:unknown){await writeFile(path+'.tmp',JSON.stringify(value,null,2),{mode:0o600});await retrySharing(()=>rename(path+'.tmp',path));}
export async function readCheckpointJson(path:string){return JSON.parse(await retrySharing(()=>readFile(path,'utf8')));}
/** VACUUM includes committed WAL transactions, never copies a live main file alone. */
export function backupCheckpointDatabase(source:string,destination:string){
 const db=new DatabaseSync(source,{readOnly:true});
 try{if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw Error('Checkpoint database integrity failure');db.prepare('VACUUM INTO ?').run(destination);}finally{db.close();}
 const copy=new DatabaseSync(destination,{readOnly:true});
 try{if(copy.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||copy.prepare('PRAGMA foreign_key_check').all().length)throw Error('Checkpoint copy integrity failure');}finally{copy.close();}
}
export async function checkpointDigest(path:string){const data=await readFile(path);return {bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};}
