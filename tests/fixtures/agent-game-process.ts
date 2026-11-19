/** Synthetic loopback game for independent-agent OS-process integration tests. */
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {RoomStore} from '../../packages/server/src/room-store.js';
import {CommanderStore} from '../../packages/server/src/commander-store.js';
import {PlayerProtocolCoordinator} from '../../packages/server/src/player-protocol-coordinator.js';
import {createFleetScenario,type FleetSetup} from '../../packages/engine/src/index.js';
import {createPlayerApi} from '../../packages/server/src/player-api.js';
import {PlayerAccess,SerialExecutor} from '../../packages/server/src/player-access.js';
import {ChatStore} from '../../packages/server/src/chat.js';
import type {LabRoom} from '../../packages/server/src/planning.js';

const directory=await mkdtemp(join(tmpdir(),'agent-game-process-'));
const setup=JSON.parse(await readFile('examples/fleet-lab.json','utf8')).initial as FleetSetup;
setup.size={width:80,height:80};
setup.positions={'蓝方工厂':{x:0,y:0},'红方矿场':{x:20,y:0},'红方后方':{x:25,y:0}};
let room:LabRoom={state:createFleetScenario(setup),scheduled:[]};
const credentials=PlayerAccess.generate(2),access=new PlayerAccess(credentials);
const chat=new ChatStore(join(directory,'chat.json'));await chat.load();
room.playerRoomId=credentials.roomId;const store=new RoomStore(join(directory,'game.sqlite'));store.commit(room,0);const repository=store.protocol!,authority=repository.startAuthority(credentials.roomId,2),commander=new CommanderStore();
const coordinator=new PlayerProtocolCoordinator(repository,{roomId:()=>credentials.roomId,load:()=>store.load()!.room});await coordinator.bindDomains(chat,commander);coordinator.refreshWorld();store.onCommit(next=>coordinator.worldCommitted(next));
const tokens=Array.from({length:2},()=>randomBytes(32).toString('base64url'));
for(const [player,token]of tokens.entries())repository.registerGrant({grantId:`process-executor-${player}`,roomId:credentials.roomId,roomEpoch:authority.roomEpoch,player,tokenHash:createHash('sha256').update(token).digest('hex'),scopes:['observe','events.read','commands.write','control.lease','chat.send','commander.worker'],expiresAtMs:Date.now()+3600000});
const server=createPlayerApi({...(process.env.AGENT_TEST_WEBROOT?{webRoot:process.env.AGENT_TEST_WEBROOT}:{}),protocol:{repository,roomId:credentials.roomId,serial:new SerialExecutor(),load:()=>store.load()!,commit:(next,revision)=>store.commit(next,revision),chat:()=>chat,commander,snapshot:player=>coordinator.snapshot(player),capabilities:()=>coordinator.capabilities(),instructionsVersion:player=>coordinator.instructionsVersion(player),ownerIdentity:authorization=>{const player=access.identity(authorization);return player===null?null:{roomId:credentials.roomId,player};}}});
server.listen(0,'127.0.0.1');await once(server,'listening');
const address=server.address();if(!address||typeof address==='string')throw Error('Missing listener');
// Test credentials go only over the parent's IPC channel, never stdout/logs.
process.send?.({kind:'ready',pid:process.pid,url:`http://127.0.0.1:${address.port}`,roomId:credentials.roomId,tokens});
let closing=false;
async function close(){if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();await rm(directory,{recursive:true,force:true});process.disconnect?.();}
process.on('message',message=>{
 const m=message as {kind?:string};
 if(m.kind==='inspect'){const current=store.load()!.room;process.send?.({kind:'state',commands:current.state.commands.length,scheduled:current.scheduledOrders?.length??0,tick:current.state.economy.tick});}
 if(m.kind==='stop')void close();
});
process.on('SIGTERM',()=>void close());
process.on('disconnect',()=>void close());
