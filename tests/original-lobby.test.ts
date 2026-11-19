import {test} from 'node:test';
import assert from 'node:assert/strict';
import {originalLobby,originalLobbyCountdown} from '../packages/engine/src/index.js';
import {RULES} from '../packages/rules/src/index.js';
function fixture(capacity=4){
 const events:string[]=[],recreations:unknown[][]=[],seats=Array.from({length:capacity},()=>({seatState:0,lastCheckinTime:-1}));
 const subs=[{used:true,ownerIndex:1},{used:true,ownerIndex:0},{used:false,ownerIndex:1},{used:true,ownerIndex:1}];
 const state={status:1,info:{initialMaxPlayerCount:capacity,maxPlayerCount:capacity,playerCount:0,seed:4300,percentGeneratorsMin:20,percentGeneratorsMax:30},
  playerStates:{get:(i:number)=>seats[i]!},world:{subs:{count:subs.length,get:(i:number)=>subs[i]!},cachedValues:{}},
  secondsUntilGameInProgress:0,secondsSinceCreation:0,secondsSinceStarting:0,timeFactor:1,
  hooks:{gameSeconds:()=>123.5,recreate:(...args:unknown[])=>{recreations.push(args);},recalculate:()=>events.push('recalculate'),cancelSub:(i:number)=>{events.push('recall-'+i);subs[i]!.used=false;}},
  listener:{handlePlayerJoined:(_s:unknown,i:number)=>events.push('join-'+i),handlePlayerLeft:(_s:unknown,i:number)=>events.push('leave-'+i),handleGameStarting:()=>events.push('starting'),handleGameStarted:()=>events.push('started')}};
 return{state,seats,subs,events,recreations};
}

test('original join/leave enforce waiting seats and recall every used vessel owned by the departing player',()=>{
 const {state,seats,subs,events}=fixture();assert.equal(originalLobby.join(state,1),true);assert.equal(seats[1]!.seatState,1);assert.equal(state.info.playerCount,1);
 assert.equal(originalLobby.join(state,1),false);assert.equal(originalLobby.leave(state,0),false);
 assert.equal(originalLobby.leave(state,1),true);assert.equal(state.info.playerCount,0);assert.equal(seats[1]!.seatState,0);
 assert.deepEqual(subs.map(s=>s.used),[false,true,false,false]);assert.deepEqual(events,['join-1','recall-0','recall-3','leave-1']);
 state.status=2;assert.equal(originalLobby.join(state,0),false);assert.equal(originalLobby.leave(state,1),false);
});
test('full lobby start keeps map and queue, initializes check-ins and uses original delay',()=>{
 const {state,seats,recreations,events}=fixture(2),queue={count:7};originalLobby.join(state,0);originalLobby.join(state,1);
 assert.equal(originalLobby.start(state,0,987,queue),true);assert.equal(state.status,2);assert.equal(queue.count,7);assert.deepEqual(recreations,[]);
 assert.equal(state.secondsUntilGameInProgress,RULES.GameParams.GameStartingDelayInHours*3600);assert.equal(state.secondsUntilGameInProgress,28800);
 assert.deepEqual(seats.map(p=>p.lastCheckinTime),[123.5,123.5]);assert.equal(events.at(-1),'starting');
 assert.equal(originalLobby.start(state,0,987,queue),false);assert.equal(originalLobby.cancel(state,0),false);
});
test('early start shrinks capacity, clears future queue, requests a new world before announcing countdown',()=>{
 const {state,seats,recreations,events}=fixture(4),queue={count:7};originalLobby.join(state,0);originalLobby.join(state,1);
 assert.equal(originalLobby.start(state,0,987,queue),true);assert.equal(state.info.maxPlayerCount,2);assert.equal(state.info.initialMaxPlayerCount,4);
 assert.equal(queue.count,0);assert.deepEqual(recreations,[[2,987,20,30]]);assert.deepEqual(events.slice(-2),['recalculate','starting']);
 assert.equal(state.secondsUntilGameInProgress,RULES.GameParams.GameStartingDelayInHoursAfterWorldRecreation*3600);
 assert.deepEqual(seats.map(p=>p.lastCheckinTime),[123.5,123.5,-1,-1]);
});
test('only occupied seat zero can cancel a waiting room; countdown uses float32 delta and transitions once',()=>{
 const {state,events}=fixture(2);originalLobby.join(state,1);assert.equal(originalLobby.cancel(state,1),false);assert.equal(originalLobby.cancel(state,0),false);
 originalLobby.join(state,0);assert.equal(originalLobby.cancel(state,0),true);assert.equal(state.status,5);
 assert.equal(originalLobby.start(state,0,1,{count:0}),false);
 state.status=2;state.secondsUntilGameInProgress=1;state.timeFactor=3;
 originalLobbyCountdown(state,.1);assert.equal(state.secondsUntilGameInProgress,1-Math.fround(.3));assert.equal(state.secondsSinceStarting,Math.fround(.3));
 originalLobbyCountdown(state,1);assert.equal(state.status,3);assert.equal(state.secondsUntilGameInProgress,0);assert.equal(events.filter(e=>e==='started').length,1);
 assert.throws(()=>originalLobbyCountdown(state,1),/Expected starting/);
});
