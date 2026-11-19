import {test} from 'node:test';
import assert from 'node:assert/strict';
import {detectEndCondition,teamSeats,shouldAutoResign,inactivityWarningCount,orderMovementEvents,canProcessCollision,type MovementEvent} from '../packages/engine/src/index.js';
import {ACTIVITY_RULES} from '../packages/rules/src/index.js';

test('team victory shares resource sum but checks live teams in seat order',()=>{
  const seats=[{alive:false,neptunium:0,outposts:4},{alive:true,neptunium:200,outposts:8},{alive:true,neptunium:120,outposts:6},{alive:true,neptunium:90,outposts:6}];
  assert.deepEqual(detectEndCondition(seats,2,'mining'),{ended:true,triggeringSeat:1,triggeringTeam:0});
  seats[1]!.neptunium=10;
  assert.deepEqual(detectEndCondition(seats,2,'mining'),{ended:true,triggeringSeat:2,triggeringTeam:1});
});
test('team goal indexes total room capacity, not team size or surviving seats',()=>{
  const seats=Array.from({length:4},()=>({alive:true,neptunium:0,outposts:9}));
  assert.equal(detectEndCondition(seats,2,'domination').ended,false);
  seats[1]!.outposts=10;
  assert.equal(detectEndCondition(seats,2,'domination').triggeringTeam,0);
  assert.deepEqual(teamSeats(5,2,2),[4]);
});
test('elimination ends a game without a fabricated winner when no one survives',()=>{
  const seats=[{alive:false,neptunium:0,outposts:0},{alive:false,neptunium:0,outposts:0}];
  assert.deepEqual(detectEndCondition(seats,0,'mining'),{ended:true,triggeringSeat:null,triggeringTeam:null});
  seats[1]!.alive=true;
  assert.equal(detectEndCondition(seats,0,'mining').triggeringSeat,1);
});

test('inactivity is disabled in forecasts and warnings preserve client thresholds',()=>{
  assert.equal(shouldAutoResign(287,0),false);assert.equal(shouldAutoResign(288,0),true);
  assert.equal(shouldAutoResign(288,0,true),false);assert.equal(shouldAutoResign(288,600),false);
  assert.deepEqual([959,960,1319,1320,1679,1680].map(inactivityWarningCount),[0,1,1,1,1,2]);
});
test('current inactivity deadline is three real hours and respects phase check-ins and forecasts',()=>{
  assert.equal(shouldAutoResign(1079,0,false,ACTIVITY_RULES),false);
  assert.equal(shouldAutoResign(1080,0,false,ACTIVITY_RULES),true);
  assert.equal(shouldAutoResign(1080,0,true,ACTIVITY_RULES),false);
  assert.equal(shouldAutoResign(1080,590,false,ACTIVITY_RULES),false);
  assert.equal(shouldAutoResign(1081,590,false,ACTIVITY_RULES),true);
});
test('movement event sorting preserves collection order on identical keys',()=>{
  const events:MovementEvent[]=[
    {type:'arrival',subIndex:5,timeFraction:.5,destination:{type:'outpost',index:1}},
    {type:'collision',subIndex:5,timeFraction:.5,destination:{type:'outpost',index:1},otherSubIndex:6},
    {type:'launch',subIndex:2,timeFraction:.5,destination:{type:'outpost',index:1}},
    {type:'arrival',subIndex:9,timeFraction:.1,destination:{type:'outpost',index:1}}
  ];
  assert.deepEqual(orderMovementEvents(events),[events[3],events[2],events[0],events[1]]);
  assert.equal(events[0]!.subIndex,5);
});
test('changed routes and reciprocal duplicate collisions are discarded',()=>{
  const destination={type:'sub' as const,index:2};
  const subs=new Map([[1,{used:true,destination}],[2,{used:true,destination:{type:'sub' as const,index:1}}]]);
  const event:MovementEvent={type:'collision',subIndex:1,otherSubIndex:2,timeFraction:.5,destination};
  assert.equal(canProcessCollision(event,subs),true);
  assert.equal(canProcessCollision({...event,subIndex:2,otherSubIndex:1,destination:{type:'sub',index:1}},subs),false);
  assert.equal(canProcessCollision({...event,destination:{type:'sub',index:9}},subs),false);
});
