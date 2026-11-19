import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RoomStore} from '../packages/server/src/room-store.js';
import {AiStore,initialState} from '../packages/ai/src/index.js';
import {PlayerAccess,savePlayerAccess} from '../packages/server/src/player-access.js';
import {createFleetScenario} from '../packages/engine/src/index.js';

async function port(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');await new Promise<void>(r=>server.close(()=>r()));return address.port;}
test('lab auto-advance toggle does not resume paused hosted AI or take external control',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'lab-clock-control-')),labPort=await port();let playerPort=await port();while(playerPort===labPort)playerPort=await port();
 const access=PlayerAccess.generate(2),roomStore=new RoomStore(join(directory,'subterfuge.sqlite')),aiStore=new AiStore(join(directory,'lab-ai.sqlite'));
 const fixture=JSON.parse(await readFile('examples/fleet-lab.json','utf8'));
 roomStore.commit({state:createFleetScenario(fixture.initial),scheduled:[],playerRoomId:access.roomId},0);roomStore.close();
 const state=initialState(access.roomId,0,{model:'',personality:'schemer'});state.enabled=false;state.status='paused';aiStore.save(state);aiStore.close();await savePlayerAccess(join(directory,'player-access.json'),access);
 let child:ChildProcess|undefined;
 try{
  child=spawn(process.execPath,[fileURLToPath(new URL('../packages/server/src/main.js',import.meta.url))],{env:{PATH:process.env.PATH??'',LAB_PORT:String(labPort),PLAYER_PORT:String(playerPort),LAB_DATA_DIR:directory,GAME_CLOCK:'manual',AI_PROVIDER:'codex',CODEX_EXECUTABLE:'/nonexistent-synthetic-test-model'},stdio:'pipe'});
  await new Promise<void>((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('Lab startup timeout')),20000);child!.stdout!.on('data',chunk=>{output+=String(chunk);if(output.includes('Player API listening')){clearTimeout(timeout);resolve();}});child!.once('error',e=>{clearTimeout(timeout);reject(e);});child!.once('exit',code=>{clearTimeout(timeout);reject(Error('Lab exited '+code));});});
  const lab=`http://127.0.0.1:${labPort}`,player=`http://127.0.0.1:${playerPort}`;
  const toggle=async(enabled:boolean)=>{const response=await fetch(lab+'/api/auto-advance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});assert.equal(response.status,200);};
  const assertPaused=async()=>{const status=await(await fetch(lab+'/api/ai')).json();assert.equal(status.seats[0].enabled,false);assert.equal(status.seats[0].status,'paused');assert.equal(status.seats[0].calls,0);};
  await assertPaused();await toggle(true);await assertPaused();await new Promise(r=>setTimeout(r,1100));await assertPaused();
  const headers={authorization:`Bearer ${access.credentials[0]!.token}`},sessionId='external-clock-test-0001';
  const claimed=await fetch(player+'/player/v2/owner/control',{method:'POST',headers,body:JSON.stringify({action:'acquire',sessionId})});assert.equal(claimed.status,200);
  await toggle(false);await toggle(true);await assertPaused();
  const status=await(await fetch(player+'/player/v2/owner/control',{headers})).json();assert.equal(status.controller,'external');assert.equal(status.mode,'agent');await toggle(false);
 }finally{if(child&&child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}await rm(directory,{recursive:true,force:true});}
});
