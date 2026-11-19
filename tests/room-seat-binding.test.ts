import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLifecycleService} from '../packages/server/src/lifecycle-service.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby} from '../packages/server/src/waiting-lobby.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {seatBindingTarget} from '../packages/client/src/AgentSeatBinding.js';
test('binding navigation validates hall, seat and correlation without player credentials',()=>{
 const params=new URLSearchParams({bind:'seat',hall:'https://example.com',code:'ABC123',roomId:'room',seat:'2',nonce:'a'.repeat(48)});
 assert.equal(seatBindingTarget('#'+params)?.seat,2);
 for(const [key,value] of [['hall','javascript:alert(1)'],['hall','https://example.com/path'],['seat','-1'],['seat','10'],['nonce','bad'],['code','bad']]){
  const invalid=new URLSearchParams(params);invalid.set(key!,value!);assert.equal(seatBindingTarget('#'+invalid),null);
 }
});
test('exact-seat admission is idempotent and races cannot switch or steal seats',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'seat-binding-')),store=new LobbyStore(join(dir,'lobby.sqlite')),access=PlayerAccess.generate(3);
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.economy.initialTick=0;cfg.economy.players.push({...cfg.economy.players[0]!});
 store.commit(createWaitingLobby(access),0,{state:createFleetScenario(cfg),scheduled:[],playerRoomId:access.roomId});
 const service=createLifecycleService(store);
 try{
  await service.claimSeat('a'.repeat(64),true);
  const result=await service.claimSeat('b'.repeat(64),false,2);assert.equal(result.player,2);
  assert.equal((await service.claimSeat('b'.repeat(64),false,2)).playerToken,result.playerToken);
  await assert.rejects(service.claimSeat('b'.repeat(64),false,1),/不符/);
  await assert.rejects(service.claimSeat('c'.repeat(64),false,2),/房间已满/);
  await assert.rejects(service.claimSeat('c'.repeat(64),false,0),/无效/);
  const outcomes=await Promise.allSettled([service.claimSeat('c'.repeat(64),false,1),service.claimSeat('d'.repeat(64),false,1)]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  assert.deepEqual(store.load()!.lobby.seats,[1,1,1]);
 }finally{service.stopClock();await new Promise<void>(resolve=>service.server.close(()=>resolve()));await service.drain();store.close();rmSync(dir,{recursive:true,force:true});}
});
