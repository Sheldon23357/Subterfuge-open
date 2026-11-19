import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {LocalAgentConnection} from './agent-console.js';

/** Host-only convenience: reads player credentials, never the game database. */
export async function localAgentConnections(directory:string,port:number):Promise<LocalAgentConnection[]>{
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error('Invalid local player port');
  const path=resolve(directory,'player-access.json');
  let raw:string;
  try{if((await stat(path)).size>16384)throw Error('Invalid local credentials');raw=await readFile(path,'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw Error('Cannot read local player credentials');}
  const data=JSON.parse(raw);
  if(data?.format!=='player-access/1'||typeof data.roomId!=='string'||!data.roomId||!Array.isArray(data.credentials)||data.credentials.length<2||data.credentials.length>10)throw Error('Invalid local credentials');
  const tokens=new Set<string>();
  return data.credentials.map((value:{player:number;token:string},index:number)=>{
    if(!value||value.player!==index||typeof value.token!=='string'||!/^[a-f0-9]{64}$/.test(value.token)||tokens.has(value.token))throw Error('Invalid local credentials');
    tokens.add(value.token);
    return {serverUrl:`http://127.0.0.1:${port}`,roomId:data.roomId,player:value.player,token:value.token};
  });
}
