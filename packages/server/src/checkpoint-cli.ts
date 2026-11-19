import {resolve} from 'node:path';
import {verifyLinkedCheckpoint} from './linked-checkpoints.js';
import {restoreLinkedCheckpoint} from './checkpoint-restore.js';
const [command,source,destination,...extra]=process.argv.slice(2);
try{
 if(!source||extra.length||!['verify','restore'].includes(command??'')||command==='verify'&&destination!==undefined||command==='restore'&&!destination)throw Error('Usage: checkpoint verify <checkpoint-directory> | restore <checkpoint-directory> <new-data-directory>');
 const result=command==='restore'?await restoreLinkedCheckpoint(resolve(source),resolve(destination!)):await verifyLinkedCheckpoint(resolve(source)).then(m=>({id:m.id,name:m.name,tick:m.tick,files:m.files.length}));
 process.stdout.write(JSON.stringify({operation:command,...result},null,2)+'\n');
}catch(e){process.stderr.write((e instanceof Error?e.message:'Checkpoint operation failed')+'\n');process.exitCode=1;}
