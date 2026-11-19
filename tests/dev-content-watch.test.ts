import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rename,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {watchContent,logReloadTrigger}=await import(pathToFileURL(resolve('scripts/dev-content-watch.mjs')).href);
interface Change {file:string;kind:string;change:string;before:string|null;after:string|null}
interface Batch {at:string;changes:Change[]}
async function fixture(onChange?:(batch:Batch)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'dev-content-watch-')),batches:Batch[]=[],notifications:(()=>void)[]=[],errors:unknown[]=[];
 await mkdir(join(root,'backend'));await mkdir(join(root,'client'));
 await writeFile(join(root,'backend/code.ts'),'original');await writeFile(join(root,'client/page.tsx'),'page');
 let closed=0;
 const watcher=await watchContent({root,delayMs:10000,folders:[{path:'backend',kind:'backend',extensions:/\.(?:ts|json)$/},{path:'client',kind:'client',extensions:/\.(?:tsx|css)$/}],
  watchFactory:(_path:string,_options:unknown,notify:()=>void)=>{notifications.push(notify);return {close:()=>closed++};},
  onChange:async(batch:Batch)=>{batches.push(batch);await onChange?.(batch);},onError:(error:unknown)=>errors.push(error)});
 return {root,batches,notifications,errors,watcher,closed:()=>closed,async close(){watcher.close();await rm(root,{recursive:true,force:true});}};
}

test('duplicate filesystem notifications, timestamp touches and identical rewrites never reload',async()=>{
 const f=await fixture();try{
  await utimes(join(f.root,'backend/code.ts'),new Date(),new Date());
  await writeFile(join(f.root,'backend/code.ts'),'original');
  for(let n=0;n<20;n++)for(const notify of f.notifications)notify();
  await f.watcher.flush();assert.equal(f.batches.length,0);assert.deepEqual(f.errors,[]);
  await writeFile(join(f.root,'backend/code.ts'),'temporary');await writeFile(join(f.root,'backend/code.ts'),'original');
  await f.watcher.flush();assert.equal(f.batches.length,0);
 }finally{await f.close();}
});

test('one real batch identifies added, modified, renamed and deleted files with hashes and source kind',async()=>{
 const f=await fixture();try{
  await mkdir(join(f.root,'backend/nested'));await writeFile(join(f.root,'backend/nested/a.json'),'{}');
  await writeFile(join(f.root,'backend/code.ts'),'changed');await rename(join(f.root,'client/page.tsx'),join(f.root,'client/new.tsx'));
  await writeFile(join(f.root,'backend/ignored.md'),'documentation');
  for(const notify of f.notifications){notify();notify();}await f.watcher.flush();
  assert.equal(f.batches.length,1);const b=f.batches[0]!;
  assert.ok(Number.isFinite(Date.parse(b.at)));assert.deepEqual(b.changes.map(c=>[c.file,c.kind,c.change]),[
   ['backend/code.ts','backend','modified'],['backend/nested/a.json','backend','added'],['client/new.tsx','client','added'],['client/page.tsx','client','deleted']]);
  assert.notEqual(b.changes[0]!.before,b.changes[0]!.after);assert.match(b.changes[0]!.after!,/^[a-f0-9]{64}$/);
  await f.watcher.flush();assert.equal(f.batches.length,1);
  await rm(join(f.root,'backend/nested'),{recursive:true});await f.watcher.flush();assert.equal(f.batches[1]!.changes[0]!.change,'deleted');
 }finally{await f.close();}
});

test('changes while a build is in flight are processed serially without dropping the next reload',async()=>{
 let release!:()=>void,entered!:()=>void,active=0,maximum=0;
 const blocked=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const f=await fixture(async()=>{active++;maximum=Math.max(maximum,active);entered();await blocked;active--;});
 try{
  await writeFile(join(f.root,'backend/code.ts'),'first');const work=f.watcher.flush();await started;
  await writeFile(join(f.root,'client/page.tsx'),'second');f.notifications[1]!();const queued=f.watcher.flush();release();await Promise.all([work,queued]);
  assert.equal(maximum,1);assert.equal(f.batches.length,2);assert.equal(f.batches[1]!.changes[0]!.file,'client/page.tsx');
 }finally{release();await f.close();}
});

test('failed build is reported, unchanged events do not retry it, and closing prevents reloads',async()=>{
 const f=await fixture(async()=>{throw Error('isolated build failure');});try{
  await writeFile(join(f.root,'backend/code.ts'),'changed');await f.watcher.flush();assert.equal(f.errors.length,1);
  f.notifications[0]!();await f.watcher.flush();assert.equal(f.batches.length,1);
  await writeFile(join(f.root,'backend/code.ts'),'changed again');await f.watcher.flush();assert.equal(f.batches.length,2);
  f.watcher.close();await writeFile(join(f.root,'backend/code.ts'),'after close');f.notifications[0]!();await f.watcher.flush();assert.equal(f.batches.length,2);
  assert.equal(f.closed(),2);
 }finally{await f.close();}
});

test('reload trigger logs include action, UTC time, detection time, exact file and before/after hashes',()=>{
 const lines:string[]=[],batch:Batch={at:'2026-10-22T01:00:00.000Z',changes:[{file:'backend/code.ts',kind:'backend',change:'modified',before:'old',after:'new'}]};
 logReloadTrigger('ai-backend-restart',batch,batch.changes,(line:string)=>lines.push(line));
 const logged=JSON.parse(lines[0]!);assert.equal(logged.kind,'dev-reload-trigger');assert.equal(logged.action,'ai-backend-restart');assert.equal(logged.detectedAt,batch.at);assert.ok(Number.isFinite(Date.parse(logged.at)));assert.deepEqual(logged.changes,batch.changes);
});

test('native filesystem notifications trigger the content comparator in an isolated directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dev-native-watch-'));await writeFile(join(root,'file.ts'),'before');
 let done!:(batch:Batch)=>void;const received=new Promise<Batch>(r=>done=r);let timeout:ReturnType<typeof setTimeout>|undefined;
 const watcher=await watchContent({root,folders:[{path:'.',kind:'backend',extensions:/\.ts$/}],delayMs:20,onChange:(batch:Batch)=>done(batch)});
 try{
  await writeFile(join(root,'file.ts'),'after');
  const batch=await Promise.race([received,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('Native watch notification missing')),5000);})]);
  assert.equal(batch.changes[0]!.file,'file.ts');assert.equal(batch.changes[0]!.change,'modified');
 }finally{clearTimeout(timeout);watcher.close();await rm(root,{recursive:true,force:true});}
});
