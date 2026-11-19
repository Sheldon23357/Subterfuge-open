import {copyFile,mkdir,unlink,writeFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {verifyLinkedCheckpoint} from './linked-checkpoints.js';

/** Offline restore only, to an exclusively-created new directory; no live overwrite. */
export async function restoreLinkedCheckpoint(source:string,destination:string){
 const manifest=await verifyLinkedCheckpoint(source),target=resolve(destination);
 const nested=relative(resolve(source),target);if(!nested||nested!=='..'&&!nested.startsWith('..'+sep)&&!isAbsolute(nested))throw Error('恢复目录不能位于原存档内部');
 await mkdir(target,{mode:0o700});
 const marker=join(target,'.checkpoint-restore-incomplete');await writeFile(marker,'incomplete',{mode:0o600});
 await mkdir(join(target,'independent-agent'),{mode:0o700});
 for(const file of manifest.files){
  const relative=file.path.startsWith('game/')?file.path.slice(5):'independent-agent/'+file.path.slice(3);
  await copyFile(join(source,file.path),join(target,relative));
 }
 // Rebase a realtime clock on the first startup, so a restored stage does not
 // immediately catch up through all the wall time since it was originally saved.
 await writeFile(join(target,'checkpoint-restored.json'),JSON.stringify({format:'checkpoint-restored/1',id:manifest.id,revision:manifest.revision,frozenAt:manifest.frozenAt}),{mode:0o600});
 await unlink(marker);
 return {directory:target,id:manifest.id,name:manifest.name,tick:manifest.tick,aiDirectory:join(target,'independent-agent')};
}
