import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,rm,symlink} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {createRoomHub} from '../packages/server/src/room-hub.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby,submitLobbyMembership} from '../packages/server/src/waiting-lobby.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
async function fixture(root:string,code:string,index:number,ended:boolean,running=false){
 const dir=join(root,code);await mkdir(dir);const access=PlayerAccess.generate(2);let lobby=createWaitingLobby(access);
 for(const player of [0,1])lobby=submitLobbyMembership(lobby,{id:'join'+player,player,kind:'join'});
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;cfg.economy.initialTick=0;
 if(ended)cfg.match={mode:'mining',neptuniumGoal:1};
 const room={state:createFleetScenario(cfg),scheduled:[],playerRoomId:access.roomId},store=new LobbyStore(join(dir,'lifecycle.sqlite'));
 try{store.commit(lobby,0,room);if(ended||running){const startedAtMs=running?Date.now()-400000:1000000+index*10000;store.commitStart(room,{id:'start',player:0,seed:4300,startedAtMs},1);await store.sync(startedAtMs+300000,2);assert.equal(store.current()!.runtime!.status,ended?'ended':'in-progress');if(ended){const revision=store.current()!.revision;assert.equal(await store.sync(Date.now()+100000,revision),revision);}}}
 finally{store.close();}
 await writeFile(join(dir,'room.json'),JSON.stringify({code,name:code,createdAt:2000000-index*10000,createHash:createHash('sha256').update(code).digest('hex')}));
}
test('lobby serves before recovery, isolates corrupt rooms, and deletes only ended matches older than the newest five', {timeout:60000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-retain-')),dir=join(root,'rooms'),alias=join(root,'configured-path');let hub:Awaited<ReturnType<typeof createRoomHub>>|undefined;
 try{
  await mkdir(dir);
  await symlink(dir,alias,process.platform==='win32'?'junction':'dir');
  for(let i=0;i<7;i++)await fixture(dir,'E0000'+i,i,true);
  await fixture(dir,'W00000',0,false);await fixture(dir,'P00000',0,false,true);await mkdir(join(dir,'X00000'));
  await writeFile(join(dir,'X00000','room.json'),JSON.stringify({code:'X00000',name:'损坏测试',createdAt:1,createHash:'a'.repeat(64)}));
  await writeFile(join(dir,'X00000','lifecycle.sqlite'),'invalid sqlite');
  hub=await createRoomHub({directory:alias,webRoot:resolve('packages/client/public')});
  const listen=async()=>{await new Promise<void>(r=>hub!.server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(hub!.server.address() as AddressInfo).port}`;};
  let origin=await listen();const initial=await fetch(origin+'/api/rooms');assert.equal(initial.status,200);
  assert.ok((await initial.json()).rooms.some((r:any)=>r.status==='recovering'));
  await hub.ready;
  const rooms=(await (await fetch(origin+'/api/rooms')).json()).rooms;
  assert.deepEqual(rooms.filter((r:any)=>r.status==='ended').map((r:any)=>r.code).sort(),['E00002','E00003','E00004','E00005','E00006']);
  assert.equal(rooms.find((r:any)=>r.code==='X00000').status,'unavailable');assert.equal(rooms.find((r:any)=>r.code==='W00000').status,'waiting');assert.equal(rooms.find((r:any)=>r.code==='P00000').status,'in-progress');
  assert.equal((await fetch(origin+'/api/rooms/X00000/join',{method:'POST',body:JSON.stringify({key:'a'.repeat(64)})})).status,503);
  const files=await readdir(dir);assert.ok(!files.includes('E00000')&&!files.includes('E00001'));assert.ok(files.includes('W00000')&&files.includes('X00000')&&files.includes('P00000'));assert.ok(!files.some(name=>name.startsWith('.ended-')));
  await hub.close();hub=await createRoomHub({directory:alias,webRoot:resolve('packages/client/public')});origin=await listen();await hub.ready;
  assert.equal((await (await fetch(origin+'/api/rooms')).json()).rooms.filter((r:any)=>r.status==='ended').length,5);
 }finally{if(hub)await hub.close();await rm(root,{recursive:true,force:true,maxRetries:5});}
});
