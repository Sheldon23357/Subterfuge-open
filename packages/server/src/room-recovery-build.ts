import {createHash} from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
/** Conservative build identity: changed authority code invalidates private recovery caches. */
export function roomRecoveryBuildId(){
 const root=fileURLToPath(new URL('../../',import.meta.url)),hash=createHash('sha256');
 const visit=(directory:string)=>{for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const path=join(directory,entry.name);if(entry.isDirectory())visit(path);else if(entry.name.endsWith('.js'))hash.update(path.slice(root.length)).update(readFileSync(path));
 }};
 for(const name of ['engine','rules','server'])visit(join(root,name,'src'));
 return hash.digest('hex');
}
