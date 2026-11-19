import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createFleetScenario,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {RoomStore} from '../packages/server/src/room-store.js';
function room(){return {state:createFleetScenario(JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup),scheduled:[]};}
test('backup and CLI restore preserve active and archived rooms, never overwrite existing destination',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-backup-')),path=join(dir,'source.sqlite'),dest=join(dir,"backup ' literal.sqlite"),store=new RoomStore(path);
 try{
  let r=room();let revision=store.commit(r,0);r={...r,state:advanceFleetScenario(r.state,105)};revision=store.commit(r,revision);store.commit(room(),revision,true);
  const expected=store.load(),report=await store.backup(dest);assert.equal(report.rooms.length,2);
  const copy=new RoomStore(dest,{readOnly:true});try{assert.deepEqual(copy.load(),expected);assert.equal(copy.verify().length,2);}finally{copy.close();}
  const bytes=await readFile(dest);await assert.rejects(()=>store.backup(dest),/exist/i);assert.deepEqual(await readFile(dest),bytes);
  const restored=join(dir,'restored.sqlite');const cli=resolve('dist/packages/server/src/storage-cli.js');
  const result=JSON.parse(execFileSync(process.execPath,[cli,'restore',dest,restored],{encoding:'utf8'}));assert.equal(result.operation,'restore');assert.equal(result.rooms.length,2);
  assert.deepEqual(await readFile(dest),bytes);const check=new RoomStore(restored,{readOnly:true});try{assert.deepEqual(check.load(),expected);}finally{check.close();}
  assert.equal((await readdir(dir)).some(name=>name.includes('.tmp')),false);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('verification includes archived journals and invalid backup is not published',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-backup-invalid-')),path=join(dir,'source.sqlite'),store=new RoomStore(path);
 try{
  store.commit(room(),0);store.commit(room(),1,true);const raw=new DatabaseSync(path);
  raw.exec("UPDATE snapshots SET digest='invalid' WHERE room_id<>(SELECT room_id FROM active_room)");raw.close();
  assert.ok(store.load());assert.throws(()=>store.verify(),/checksum/);await assert.rejects(()=>store.backup(join(dir,'invalid.sqlite')),/checksum/);
  assert.equal((await readdir(dir)).some(n=>n==='invalid.sqlite'||n.includes('.tmp')),false);
  const existing=join(dir,'existing.sqlite');await writeFile(existing,'preserve me');await assert.rejects(()=>store.backup(existing));assert.equal(await readFile(existing,'utf8'),'preserve me');
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('backups remain valid while another process commits ticks into the WAL',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-backup-writer-')),path=join(dir,'source.sqlite'),store=new RoomStore(path);store.commit(room(),0);
 const source=new URL('../packages/server/src/room-store.js',import.meta.url).href,engine=new URL('../packages/engine/src/index.js',import.meta.url).href;
 const script=`import {RoomStore} from ${JSON.stringify(source)};import {advanceFleetScenario} from ${JSON.stringify(engine)};const s=new RoomStore(process.argv[1]);for(let i=0;i<30;i++){const old=s.load();old.room.state=advanceFleetScenario(old.room.state,old.room.state.economy.tick+1);s.commit(old.room,old.revision);if(i===0)console.log('ready');await new Promise(r=>setTimeout(r,10));}s.close();`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,path],{stdio:['ignore','pipe','pipe']});const ended=once(child,'exit');let errors='';child.stderr.on('data',b=>errors+=b);
 try{
  await once(child.stdout,'data');
  for(let i=0;i<4;i++){const dest=join(dir,'copy-'+i+'.sqlite');await store.backup(dest);const copy=new RoomStore(dest,{readOnly:true});try{const restored=copy.load()!;assert.equal(restored.room.state.economy.tick,99+restored.revision);assert.equal(copy.verify().length,1);}finally{copy.close();}}
  const [code]=await ended;assert.equal(code,0,errors);assert.equal(store.load()!.room.state.economy.tick,130);
 }finally{if(child.exitCode===null){child.kill();await ended;}store.close();await rm(dir,{recursive:true,force:true});}
});
