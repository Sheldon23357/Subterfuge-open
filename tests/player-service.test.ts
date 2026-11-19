import {saveRoom} from '../packages/server/src/planning.js';
import {createEightPlayerScenario} from '../packages/server/src/eight-player.js';
import {RoomStore} from '../packages/server/src/room-store.js';
import {test} from 'node:test';
import {createServer as createPortProbe} from 'node:net';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
test('real player listener persists credentials and invalidates them when the host imports a room',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'subterfuge-player-service-'));let child:ChildProcess|undefined;
  const probes=[createPortProbe(),createPortProbe()];
  for(const probe of probes){probe.listen(0,'127.0.0.1');await once(probe,'listening');}
  const ports=probes.map(probe=>{const a=probe.address();if(!a||typeof a==='string')throw Error('No test port');return a.port;});
  for(const probe of probes)await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const debug=`http://127.0.0.1:${ports[0]}`,player=`http://127.0.0.1:${ports[1]}`;
  async function start(){
    child=spawn(process.execPath,[fileURLToPath(new URL('../packages/server/src/main.js',import.meta.url))],{env:{...process.env,GAME_CLOCK:'realtime',LAB_PORT:String(ports[0]),PLAYER_PORT:String(ports[1]),PLAYER_PUBLIC_ORIGIN:'https://public-player.example',LAB_LEGACY_FIXTURE:'1',LAB_DATA_DIR:dir},stdio:'pipe'});
    await new Promise<void>((done,reject)=>{
      let text='',errors='';child!.stderr!.on('data',chunk=>errors+=chunk);const timer=setTimeout(()=>reject(Error('Player listener startup timeout')),15000);
      child!.stdout!.on('data',chunk=>{text+=chunk;if(text.includes('Player API listening')){clearTimeout(timer);done();}});
      child!.once('error',e=>{clearTimeout(timer);reject(e);});child!.once('exit',code=>{clearTimeout(timer);reject(Error(`Startup exited ${code}: ${errors}`));});
    });
  }
  async function stop(){if(child&&child.exitCode===null){const done=new Promise<void>(resolve=>child!.once('exit',()=>resolve()));child.kill();await done;}}
  const credentials=async()=>JSON.parse(await readFile(join(dir,'player-access.json'),'utf8'));
  const observe=(token:string)=>fetch(player+'/player/v2/owner/observation',{headers:{Authorization:`Bearer ${token}`,Origin:'https://public-player.example'}});
  try{
    const legacy=saveRoom({state:createEightPlayerScenario(),scheduled:[]});await writeFile(join(dir,'browser-eight.json'),legacy);
    await start();assert.equal(await readFile(join(dir,'browser-eight.json'),'utf8'),legacy);const access=await credentials(),token=access.credentials[0].token;
    const first=await (await observe(token)).json();assert.equal(first.roomId,access.roomId);assert.equal(first.view.player,0);
    const snap=await (await fetch(debug+'/api/export')).json();assert.equal(snap.playerRoomId,access.roomId);
    assert.equal(JSON.stringify(snap).includes(token),false);
    const chatRequest=(credential:string,data?:unknown)=>fetch(player+'/player/v2/owner/chat',{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credential}`},...(data===undefined?{}:{body:JSON.stringify(data)})});
    assert.equal((await chatRequest(token,{id:'private',to:1,text:'persistent private message'})).status,200);
    const oldChat=await (await chatRequest(token)).json();assert.equal(oldChat.messages.length,1);
    const labSession=await (await fetch(debug+'/api/chat/session',{method:'POST',body:JSON.stringify({seat:1})})).json();
    const labMessages=await (await fetch(debug+'/api/chat/list',{method:'POST',headers:{'x-lab-seat-token':labSession.token},body:'{}'})).json();assert.equal(labMessages.messages[0].text,'persistent private message');
    await stop();await start();assert.deepEqual(await (await chatRequest(token)).json(),oldChat);assert.deepEqual(await credentials(),access);const restarted=await (await observe(token)).json();
    // The wall-clock phase and observation revision may change across a real restart.
    const stable=({revision,secondsSinceLastTick,...observed}:typeof first)=>({...observed,view:{...observed.view,}});
    assert.deepEqual(stable(restarted),stable(first));
    assert.equal((await fetch(debug+'/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(snap)})).status,200);
    assert.equal((await observe(token)).status,401);
    const next=await credentials();assert.equal((await chatRequest(token)).status,401);assert.deepEqual((await (await chatRequest(next.credentials[0].token)).json()).messages,[]);assert.notEqual(next.roomId,access.roomId);assert.equal((await observe(next.credentials[0].token)).status,200);
    await stop();await start();assert.equal((await observe(token)).status,401);assert.equal((await observe(next.credentials[0].token)).status,200);
    assert.equal((await fetch(debug+'/api/step',{method:'POST',body:JSON.stringify({ticks:1})})).status,400);
    await stop();
    // Move only the test fixture's wall anchor: simulate two ticks of downtime.
    const database=new RoomStore(join(dir,'subterfuge.sqlite'));const stored=database.load()!;
    stored.room.clock!.tickMilliseconds=60_000;stored.room.clock!.anchorTick=stored.room.state.economy.tick;stored.room.clock!.anchorMs=Date.now()-120_000;database.commit(stored.room,stored.revision);database.close();
    await start();const recovered=await (await observe(next.credentials[0].token)).json();
    assert.equal(recovered.view.tick,stored.room.state.economy.tick+2);assert.equal(recovered.roomId,next.roomId);
    const afterOutage=await (await fetch(debug+'/api/export')).json();
    assert.equal(JSON.parse(afterOutage.snapshot).replay.commands.length,stored.room.state.commands.length);
    assert.equal(await readFile(join(dir,'browser-eight.json'),'utf8'),legacy);
  }finally{await stop();await rm(dir,{recursive:true,force:true});}
});
