import {createHash} from 'node:crypto';
import {watch} from 'node:fs';
import {readdir,readFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';

/** fs.watch is only a hint. Content snapshots, not timestamps or event names,
 * decide whether a build/restart is needed. Callbacks run serially. */
export async function watchContent({root=process.cwd(),folders,delayMs=300,onChange,onError=console.error,watchFactory=watch}){
 root=resolve(root);
 const sources=folders.map(folder=>({...folder,path:resolve(root,folder.path)}));
 const watchers=[];
 let baseline=new Map(),timer,work=null,dirty=false,closed=false;
 async function snapshot(){
  const result=new Map();
  async function visit(directory,source){
   let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return;throw error;}
   for(const entry of entries){
    const path=join(directory,entry.name);
    if(entry.isDirectory())await visit(path,source);
    else if(entry.isFile()&&source.extensions.test(entry.name)){
     let bytes;try{bytes=await readFile(path);}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')continue;throw error;}
     result.set(relative(root,path).replaceAll('\\','/'),{kind:source.kind,hash:createHash('sha256').update(bytes).digest('hex')});
    }
   }
  }
  for(const source of sources)await visit(source.path,source);
  return result;
 }
 async function drain(){
  while(dirty&&!closed){
   dirty=false;clearTimeout(timer);
   try{
    const next=await snapshot();if(closed)return;
    const changes=[];
    for(const file of new Set([...baseline.keys(),...next.keys()])){
     const old=baseline.get(file),current=next.get(file);
     if(old?.hash!==current?.hash)changes.push({file,kind:current?.kind??old.kind,change:!old?'added':!current?'deleted':'modified',before:old?.hash??null,after:current?.hash??null});
    }
    // A failed build is retried only after another real source change.
    baseline=next;
    if(changes.length)await onChange({at:new Date().toISOString(),changes:changes.sort((a,b)=>a.file.localeCompare(b.file))});
   }catch(error){onError(error);}
  }
 }
 function flush(){
  if(closed)return Promise.resolve();dirty=true;clearTimeout(timer);
  if(!work)work=drain().finally(()=>{work=null;if(dirty&&!closed)schedule();});
  return work;
 }
 function schedule(){if(closed)return;dirty=true;clearTimeout(timer);timer=setTimeout(()=>void flush(),delayMs);}
 try{
  // Seed before enabling callbacks. The initial build follows this snapshot;
  // flush once after attaching to cover changes during initial enumeration.
  baseline=await snapshot();
  for(const source of sources){
   const watcher=watchFactory(source.path,{recursive:true},()=>schedule());
   watcher.on?.('error',onError);watchers.push(watcher);
  }
 }catch(error){for(const watcher of watchers)watcher.close();throw error;}
 return {flush,close(){if(closed)return;closed=true;dirty=false;clearTimeout(timer);for(const watcher of watchers)watcher.close();}};
}

export function logReloadTrigger(action,batch,changes=batch.changes,write=console.log){
 write(JSON.stringify({kind:'dev-reload-trigger',at:new Date().toISOString(),detectedAt:batch.at,action,changes}));
}
