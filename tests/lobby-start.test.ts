import {test} from 'node:test';
import assert from 'node:assert/strict';
import {originalMapCandidate,applyGameplayMapComposition,type FleetSetup,createFleetScenario} from '../packages/engine/src/index.js';
import {readFileSync} from 'node:fs';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby,submitLobbyMembership} from '../packages/server/src/waiting-lobby.js';
import {prepareLobbyStart} from '../packages/server/src/lobby-start.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {saveRoom,restoreRoom,type LabRoom} from '../packages/server/src/planning.js';
function fixture(count:number,joined:number[],teamSize=0){
 const access=PlayerAccess.generate(count);let lobby=createWaitingLobby(access);
 for(const player of joined)lobby=submitLobbyMembership(lobby,{id:'join-'+player,player,kind:'join'});
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.economy.initialTick=0;cfg.economy.teamSize=teamSize;cfg.economy.players=Array.from({length:count},()=>({active:true,neptunium:0,minesCreated:0}));
 cfg.match={mode:'mining',neptuniumGoal:200};
 for(let player=2;player<count;player++){const id='waiting-'+player;cfg.economy.outposts.push({...cfg.economy.outposts[0]!,id,owner:player});cfg.positions[id]={x:player,y:3};}
 const room:LabRoom={state:createFleetScenario(cfg),scheduled:[],playerRoomId:access.roomId};
 return{lobby,room,access};
}
test('full lobby preserves the actual waiting map and scheduled orders without mutating inputs',async()=>{
 const {lobby,room}=fixture(2,[0,1]);
 const scheduled=scheduleOrder(room,{order:{id:'future',player:1,action:{kind:'check-in'}},issueTick:2});
 const before=JSON.stringify({lobby,scheduled}),start=await prepareLobbyStart(lobby,0,4300,scheduled);
 assert.equal(start.recreated,false);assert.equal(start.secondsUntilGameInProgress,300);
 assert.deepEqual(start.room,scheduled);assert.notEqual(start.room,scheduled);
 assert.deepEqual(start.access,lobby.access);assert.deepEqual(start.seatMapping,[{lobbySeat:0,gameSeat:0},{lobbySeat:1,gameSeat:1}]);
 assert.equal(JSON.stringify({lobby,scheduled}),before);assert.deepEqual(restoreRoom(saveRoom(start.room)),start.room);
});
test('early start uses the exact eligible seed, clears the old agenda and binds sparse seats to the new world',async()=>{
 const {lobby,room,access}=fixture(4,[0,3]);
 const scheduled=scheduleOrder(room,{order:{id:'discarded',player:3,action:{kind:'check-in'}},issueTick:2});
 let seed=4300;while(seed<4800&&!applyGameplayMapComposition(originalMapCandidate(2,seed),seed).valid)seed++;assert.ok(seed<4800);
 const before=JSON.stringify({lobby,scheduled}),start=await prepareLobbyStart(lobby,0,seed,scheduled),candidate=originalMapCandidate(2,seed);
 assert.equal(start.recreated,true);assert.equal(start.secondsUntilGameInProgress,300);assert.equal(start.room.map!.seed,seed);assert.equal(start.room.map!.requestedSeed,seed);
 assert.deepEqual(Object.values(start.room.state.initial.positions),candidate.outposts.map(o=>o.position));
 assert.equal(start.room.map!.composition,'generator-45-v1');
 assert.equal(start.room.state.initial.economy.outposts.filter(p=>p.type==='generator').length,9);
 assert.equal(start.room.state.economy.players.length,2);assert.deepEqual(start.room.scheduled,[]);assert.equal(start.room.scheduledOrders,undefined);
 assert.deepEqual(start.seatMapping,[{lobbySeat:0,gameSeat:0},{lobbySeat:3,gameSeat:1}]);
 const gameAccess=new PlayerAccess(start.access);assert.equal(gameAccess.identity('Bearer '+access.credentials[3]!.token),1);
 assert.equal(gameAccess.identity('Bearer '+access.credentials[1]!.token),null);
 assert.equal(JSON.stringify({lobby,scheduled}),before);assert.deepEqual(restoreRoom(saveRoom(start.room)),start.room);
});
test('invalid host, insufficient occupancy, split teams and running worlds cannot prepare a start',async()=>{
 const {lobby,room}=fixture(4,[0,3],2);
 assert.throws(()=>prepareLobbyStart(lobby,0,4300,room),/Incomplete teams/);
 assert.throws(()=>prepareLobbyStart(lobby,3,4300,room),/host/);
 const solo=fixture(2,[0]);assert.throws(()=>prepareLobbyStart(solo.lobby,0,4300,solo.room),/two/);
 const full=fixture(2,[0,1]);full.room.playerRoomId='another';assert.throws(()=>prepareLobbyStart(full.lobby,0,4300,full.room),/identity/);
 full.room.playerRoomId=full.access.roomId;full.room.clock={format:'realtime-clock/1',anchorMs:100,anchorTick:0};
 assert.throws(()=>prepareLobbyStart(full.lobby,0,4300,full.room),/unstarted/);
});
test('early start rejects an ineligible seed rather than silently substituting another map',async()=>{
 const {lobby,room}=fixture(4,[0,3]),before=JSON.stringify({lobby,room});
 let seed=4300;while(seed<4800&&originalMapCandidate(2,seed).valid)seed++;assert.ok(seed<4800);
 assert.throws(()=>prepareLobbyStart(lobby,0,seed,room),/eligible map/);
 assert.equal(JSON.stringify({lobby,room}),before);
});

