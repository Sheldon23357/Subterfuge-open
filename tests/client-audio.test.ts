import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {MUSIC_TRACKS,actionSound,notificationSound,AudioEventCursor,AudioDayCursor} from '../packages/client/src/audio-policy.js';
import {servePlayerStatic} from '../packages/server/src/player-static.js';

test('audio action mapping differentiates commands and keeps simulation silent',()=>{
  assert.equal(actionSound('order',{action:{kind:'launch'}}),'fleet_launch');
  assert.equal(actionSound('order',{action:{kind:'set-shields'}}),'shield_toggle');
  assert.equal(actionSound('order',{action:{kind:'toggle-mine'}}),'mine_build');
  assert.equal(actionSound('order',{action:{kind:'cancel-launch'}}),'order_cancel');
  assert.equal(actionSound('schedule',{order:{action:{kind:'launch'}}}),'order_confirm');
  assert.equal(actionSound('cancel-schedule',{}),'order_cancel');
  for(const path of ['preview','step','auto-advance','state','import','reset'])assert.equal(actionSound(path,{}),null);
});

test('day audio follows successful automatic time changes, not controls or repeated snapshots',()=>{
  const c = new AudioDayCursor();
  assert.equal(c.accept('room',10,true),null,'initial load is silent');
  assert.equal(c.accept('room',10,true),null,'waiting is silent');
  assert.equal(c.accept('room',11,true),'day_advance');
  assert.equal(c.accept('room',11,true),null,'same day is deduplicated');
  assert.equal(c.accept('room',14,false),'day_advance','final automatic update sounds once without replaying missed days');
  assert.equal(c.accept('room',15,false),null,'manual step is silent');
  assert.equal(c.accept('room',15,true),null,'enabling automatic advance alone is silent');
  assert.equal(c.accept('room',3,true),null,'rewind is silent');
  assert.equal(c.accept('other-room',30,true),null,'new room is baselined');
  assert.equal(c.accept('other-room',31,true),'day_advance');
});
test('notification audio baselines paginated history and deduplicates fresh events',()=>{
 const c=new AudioEventCursor();const e=(id:number,kind='departed',sendNotification=true)=>({id,kind,urgent:false,sendNotification});
 assert.equal(c.accept([e(1)],true),null);
 assert.equal(c.accept([e(2)],false),null);
 assert.equal(c.accept([e(2)],false),null);
 assert.equal(c.accept([e(3)],false),'threat_alert');
 assert.equal(c.accept([e(3)],false),null);
 assert.equal(c.accept([e(4,'mine-created',false)],false),null);
 assert.equal(c.accept([e(5,'mine-created')],false),'mine_build');
 assert.equal(c.accept([e(1)],false),null);
 assert.equal(notificationSound('game-ended',false),'message_received');
});
test('all five music choices and effects ship in both browser formats',async()=>{
 const manifest=JSON.parse(await readFile('packages/client/public/audio/manifest.json','utf8'));
 assert.equal(MUSIC_TRACKS.length,5);
 assert.equal(manifest.assets.length,23);
 assert.ok(manifest.assets.some((a:{id:string})=>a.id==='day_advance'));
 for(const asset of manifest.assets){
  for(const ext of ['ogg','mp3']){
   const category=asset.type==='bgm'?'bgm':'sfx';
   assert.ok((await stat(`packages/client/public/audio/${category}/${asset.id}.${ext}`)).size>100);
  }
 }
 for(const track of MUSIC_TRACKS)assert.ok(manifest.assets.some((a:{id:string})=>a.id===track.id));
});
test('public player static allows only audio media, with MIME and traversal guard',async()=>{
 const root=await mkdtemp(join(tmpdir(),'subterfuge-audio-'));
 await mkdir(join(root,'audio','bgm'),{recursive:true});
 await writeFile(join(root,'audio','bgm','test.ogg'),'OggS');
 await writeFile(join(root,'audio','bgm','test.mp3'),'ID3');
 await writeFile(join(root,'audio','secret.json'),'{}');
 const server=createServer((req,res)=>{void servePlayerStatic(root,req,res).then(ok=>{if(!ok)res.writeHead(404).end();}).catch(()=>res.writeHead(500).end());});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const base=`http://127.0.0.1:${address.port}`;
 try{
  for(const [file,mime] of [['test.ogg','audio/ogg'],['test.mp3','audio/mpeg']]){
   const r=await fetch(`${base}/audio/bgm/${file}`);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),mime);
  }
  for(const path of ['/audio/secret.json','/audio/bgm/../../package.json','/audio/bgm/%2e%2e%2fsecret.json','/app.js'])assert.equal((await fetch(base+path)).status,404);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});
