import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';

export interface ControllerSlotStatus {slot:number;id:string;provider:string;model:string;bound:boolean;roomId?:string;seat?:number;enabled?:boolean;status?:string;busy?:boolean}
export async function controllerSlots(directory:string):Promise<{available:boolean;checkpointProtocol?:number;slots:ControllerSlotStatus[]}>{
 try{
  const value=JSON.parse(await readFile(join(directory,'ai-controller-slots.json'),'utf8'));
  if(value.format!=='ai-controller-slots/1'||!Number.isInteger(value.pid)||Date.now()-value.updatedAt>15000||!Array.isArray(value.slots)||value.slots.length!==8)throw Error();
  process.kill(value.pid,0);
  return {available:true,...(value.checkpointProtocol===1?{checkpointProtocol:1}:{}),slots:value.slots.map((s:{slot:number;id:string;provider:string;model:string;bound?:boolean;roomId?:string;seat?:number|null;enabled?:boolean;status?:string;busy?:boolean},i:number)=>{
   if(s.slot!==i||typeof s.id!=='string'||typeof s.provider!=='string'||typeof s.model!=='string')throw Error();
   const bound=s.bound===true&&typeof s.roomId==='string'&&Number.isInteger(s.seat)&&Number(s.seat)>=0&&Number(s.seat)<10;
   return {slot:i,id:s.id,provider:s.provider,model:s.model,...(bound?{bound:true,roomId:s.roomId,seat:s.seat as number,enabled:s.enabled===true,status:['waiting','thinking','paused','error','ended'].includes(s.status??'')?s.status:'paused',busy:s.busy===true}:{bound:false})};
  })};
 }catch{return {available:false,slots:[]};}
}
export function validateControllerBindings(raw:unknown,players:number){
 if(!Array.isArray(raw)||raw.length>8)throw Error('无效 AI 绑定');
 const seats=new Set<number>(),slots=new Set<number>();
 return raw.map(value=>{
  if(!value||Object.keys(value).sort().join(',')!=='seat,slot'||!Number.isInteger(value.seat)||value.seat<0||value.seat>=players||!Number.isInteger(value.slot)||value.slot<0||value.slot>7||seats.has(value.seat)||slots.has(value.slot))throw Error('AI 席位不可重复绑定');
  seats.add(value.seat);slots.add(value.slot);return {seat:value.seat as number,slot:value.slot as number};
 });
}
export async function saveControllerBindings(directory:string,roomId:string,bindings:{seat:number;slot:number}[]){
 const path=join(directory,'controller-bindings.json');await writeFile(path+'.tmp',JSON.stringify({format:'controller-bindings/1',roomId,bindings}));await rename(path+'.tmp',path);
}
export async function loadControllerBindings(directory:string,roomId:string,players:number){
 try{
  const value=JSON.parse(await readFile(join(directory,'controller-bindings.json'),'utf8'));
  if(value.format!=='controller-bindings/1'||value.roomId!==roomId)throw Error('AI 绑定不属于当前对局');
  return validateControllerBindings(value.bindings,players);
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
}
