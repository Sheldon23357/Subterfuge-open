import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('standalone lifecycle entry initializes once and restores waiting membership and credentials on restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-lifecycle-main-')),probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const address=probe.address();assert.ok(address&&typeof address==='object');const port=address.port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
 let child:ChildProcess|undefined,output='';
 const start=async()=>{
  child=spawn(process.execPath,[fileURLToPath(new URL('../packages/server/src/lifecycle-main.js',import.meta.url))],{env:{...process.env,LOBBY_PORT:String(port),LOBBY_HOST:'127.0.0.1',LOBBY_PLAYERS:'2',LOBBY_DATA_DIR:dir},stdio:'pipe'});
  await new Promise<void>((resolve,reject)=>{
   let errors='';const timer=setTimeout(()=>reject(Error('Lifecycle startup timeout')),30000);
   child!.stderr!.on('data',c=>errors+=c);child!.stdout!.on('data',c=>{output+=c;if(output.includes('Lifecycle service listening')){clearTimeout(timer);resolve();}});
   child!.once('error',e=>{clearTimeout(timer);reject(e);});child!.once('exit',code=>{clearTimeout(timer);reject(Error('Lifecycle exited '+code+': '+errors));});
  });
 };
 const stop=async()=>{if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}};
 try{
  await start();const access=JSON.parse(await readFile(join(dir,'lobby-access.json'),'utf8')),headers={Authorization:'Bearer '+access.credentials[0].token};
  for(const c of access.credentials)assert.equal(output.includes(c.token),false);
  const url=`http://127.0.0.1:${port}/lobby/v2`,initial=await(await fetch(url,{headers})).json();assert.equal(initial.capacity,2);assert.deepEqual(initial.occupied,[false,false]);
  const joined=await fetch(url+'/commands',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({id:'join',kind:'join',revision:initial.revision})});assert.equal(joined.status,200);
  await stop();output='';await start();assert.deepEqual(JSON.parse(await readFile(join(dir,'lobby-access.json'),'utf8')),access);
  const restored=await(await fetch(url,{headers})).json();assert.deepEqual(restored.occupied,[true,false]);assert.equal(restored.roomId,initial.roomId);
 }finally{await stop();await rm(dir,{recursive:true,force:true});}
});
