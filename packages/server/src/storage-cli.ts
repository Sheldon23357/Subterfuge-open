import {access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {RoomStore} from './room-store.js';
const [command,source,destination,...extra]=process.argv.slice(2);
try{
 if(!['verify','backup','restore'].includes(command??'')||!source||extra.length||command==='verify'&&destination!==undefined||command!=='verify'&&!destination)throw Error('Usage: storage verify <database> | backup <database> <new-file> | restore <backup> <new-file>');
 const path=resolve(source);await access(path);const store=new RoomStore(path,{readOnly:true});
 try{
  const result=command==='verify'?{path,rooms:store.verify()}:await store.backup(destination!);
  process.stdout.write(JSON.stringify({operation:command,...result},null,2)+'\n');
 }finally{store.close();}
}catch(error){process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}
