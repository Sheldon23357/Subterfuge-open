import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';
export interface PlayerAccessFile {format:'player-access/1';roomId:string;credentials:{player:number;token:string}[]}
const digest=(token:string)=>createHash('sha256').update(token).digest();
/** Only the local host reads the access file. Never expose it on either HTTP API. */
export class PlayerAccess {
  private hashes:{player:number;hash:Buffer}[];
  readonly roomId:string;
  constructor(data:PlayerAccessFile){
    if(data.format!=='player-access/1'||typeof data.roomId!=='string'||!data.roomId||!Array.isArray(data.credentials)||data.credentials.length<2||data.credentials.length>10)throw Error('Invalid player access file');
    const tokens=new Set<string>();
    this.hashes=data.credentials.map((c,i)=>{
      if(c.player!==i||typeof c.token!=='string'||!/^[a-f0-9]{64}$/.test(c.token)||tokens.has(c.token))throw Error('Invalid player credential');
      tokens.add(c.token);return {player:c.player,hash:digest(c.token)};
    });this.roomId=data.roomId;
  }
  identity(header:unknown):number|null{
    if(typeof header!=='string'||!/^Bearer [a-f0-9]{64}$/.test(header))return null;
    const hash=digest(header.slice(7));let result:number|null=null;
    for(const entry of this.hashes)if(timingSafeEqual(entry.hash,hash))result=entry.player;
    return result;
  }
  static generate(count:number):PlayerAccessFile{
    if(!Number.isInteger(count)||count<2||count>10)throw Error('Invalid player count');
    return {format:'player-access/1',roomId:randomUUID(),credentials:Array.from({length:count},(_,player)=>({player,token:randomBytes(32).toString('hex')}))};
  }
}
export async function savePlayerAccess(path:string,data:PlayerAccessFile){
  new PlayerAccess(data);await writeFile(path+'.tmp',JSON.stringify(data,null,2),{mode:0o600});await rename(path+'.tmp',path);
}
export async function loadPlayerAccess(path:string,count:number,roomId?:string){
  let data:PlayerAccessFile;
  try{data=JSON.parse(await readFile(path,'utf8'));}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;data=PlayerAccess.generate(count);await savePlayerAccess(path,data);}
  new PlayerAccess(data);
  if(roomId!==undefined&&data.roomId!==roomId){data={...PlayerAccess.generate(count),roomId};await savePlayerAccess(path,data);}
  const access=new PlayerAccess(data);
  if(data.credentials.length!==count)throw Error('Access file player count differs from room');
  return access;
}
/** Writes and authenticated reads use the same queue so no request sees a half-save. */
export class SerialExecutor {
  private tail:Promise<unknown>=Promise.resolve();
  run<T>(job:()=>Promise<T>|T):Promise<T>{
    const next=this.tail.then(job);this.tail=next.catch(()=>{});return next;
  }
}
