import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,saveFleetSnapshot,restoreFleetSnapshot,projectPlayerActivity,projectPlayerNotifications,projectPlayerView,type FleetSetup} from '../packages/engine/src/index.js';
import {parseProtocolAction,PROTOCOL_PLAYER_ACTIONS} from '../packages/contracts/src/player-protocol-wire.js';
import {observation} from '../packages/server/src/player-api.js';
import {forecastKnownObservation} from '../packages/prediction/src/index.js';
import {scheduleLaunch,advanceRoom} from '../packages/server/src/planning.js';
function setup(){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 c.size={width:80,height:80};c.positions['蓝方工厂']={x:0,y:0};c.positions['红方矿场']={x:8,y:0};c.positions['红方后方']={x:9,y:0};
 return c;
}
function launch(c=setup(),drillers=21,seconds=0){return submitFleetOrder(createFleetScenario(c),{id:'ship',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers,}},seconds).state;}
const recall=(s:ReturnType<typeof launch>,player=0,id='return')=>submitFleetOrder(s,{id,player,action:{kind:'return-fleet',fleetId:'ship'}});
test('launch immediately departs, debits troops, emits exact departure facts, and does not merge same routes',()=>{
 let s=launch();assert.equal(s.fleets[0]!.state,'moving');assert.equal(s.fleets[0]!.secondsUntilLaunch,0);
 assert.equal(s.economy.outposts[0]!.drillers,79);
 assert.equal(projectPlayerView(s,0).fleets[0]!.canCancelLaunch,false);assert.equal(projectPlayerView(s,0).fleets[0]!.canReturn,true);
 const departure=projectPlayerActivity(s,0).find(e=>e.kind==='departed')!;assert.equal(departure.tick,100);assert.equal(departure.seconds,0);
 assert.deepEqual(s.events.filter(e=>e.subject==='ship').map(e=>e.kind),['departed']);
 assert.deepEqual(projectPlayerActivity(s,0).filter(e=>e.subject==='ship').map(e=>e.kind),['departed']);
 assert.deepEqual(s.events[0]!.details,{source:'蓝方工厂',destination:'红方矿场',drillers:21});
 assert.equal(s.commands.length,1,'the launch command remains in the audit journal');
 assert.throws(()=>submitFleetOrder(s,{id:'cancel',player:0,action:{kind:'cancel-launch',fleetId:'ship'}}));
 s=submitFleetOrder(s,{id:'second',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:3}}).state;
 assert.equal(s.fleets.filter(f=>f.used).length,2);assert.deepEqual(s.fleets.map(f=>f.drillers),[21,3]);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
});
test('fractional launch starts now and moves only the remaining fraction of the tick',()=>{
 const s=launch(setup(),20,450),f=s.fleets[0]!;assert.equal(f.state,'moving');
 const event=projectPlayerActivity(s,0).find(e=>e.kind==='departed')!;assert.equal(event.tick,100);assert.equal(event.seconds,450);
 const end=advanceFleetScenario(s,101);assert.ok(end.fleets[0]!.position.x>0);assert.ok(end.fleets[0]!.position.x<.05);
 assert.equal(end.events.filter(e=>e.kind==='departed').length,1);assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(end)),end);
});
test('explicit zero delay also records one departure, including fractional command time and retries',()=>{
 const input={id:'direct',player:0,action:{kind:'launch' as const,source:'蓝方工厂',destination:'红方矿场',drillers:21,delaySeconds:0}};
 const s=submitFleetOrder(createFleetScenario(setup()),input,150).state;
 assert.deepEqual(s.events.map(e=>e.kind),['departed']);
 assert.equal(s.events[0]!.tick-1+s.events[0]!.fraction,100.25);
 assert.deepEqual(projectPlayerActivity(s,0).map(e=>[e.kind,e.tick,e.seconds]),[['departed',100,150]]);
 assert.equal(submitFleetOrder(s,input,151).duplicate,true);
 assert.equal(s.events.length,1);assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
});
test('explicit delayed departure keeps genuinely distinct order and departure facts',()=>{
 const input={id:'delayed',player:0,action:{kind:'launch' as const,source:'蓝方工厂',destination:'红方矿场',drillers:21,delaySeconds:600}};
 const s=submitFleetOrder(createFleetScenario(setup()),input,150).state;
 assert.equal(s.fleets[0]!.state,'waiting');assert.deepEqual(s.events.map(e=>e.kind),['launch-ordered']);
 const future=advanceFleetScenario(s,102),facts=projectPlayerActivity(future,0);
 assert.deepEqual(facts.map(e=>e.kind),['launch-ordered','departed']);
 assert.equal(facts[1]!.tick*600+facts[1]!.seconds-facts[0]!.tick*600-facts[0]!.seconds,600);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(future)),future);
});
test('return halves troops downward, starts immediately and is one use per fleet',()=>{
 const s=advanceFleetScenario(launch(setup()),104),before=structuredClone(s),end=recall(s).state,f=end.fleets[0]!;
 assert.deepEqual(s,before);assert.equal(f.used,true);assert.equal(f.drillers,10);assert.equal(f.returned,true);assert.equal(f.destination,'蓝方工厂');assert.equal(f.state,'moving');
 assert.deepEqual(f.position,s.fleets[0]!.position);assert.equal(end.economy.outposts[0]!.drillers,s.economy.outposts[0]!.drillers);
 assert.ok(!end.events.some(e=>['battle','fleet-arrived'].includes(e.kind)));
 const event=projectPlayerActivity(end,0).find(e=>e.kind==='fleet-recalled')!;assert.equal(event.drillers,10);assert.equal(event.termination,undefined);
 assert.equal(projectPlayerView(end,0).fleets[0]!.canReturn,false);assert.equal(recall(end).duplicate,true);assert.throws(()=>recall(end,0,'again'));
 const restored=restoreFleetSnapshot(saveFleetSnapshot(end));assert.deepEqual(restored,end);assert.throws(()=>recall(restored,0,'after-restore'));
 const arrived=advanceFleetScenario(end,120);assert.equal(arrived.fleets[0]!.used,false);
});
test('another player cannot return an owned fleet; rejected commands are atomic',()=>{
 const s=launch(),before=structuredClone(s);assert.throws(()=>recall(s,1));assert.deepEqual(s,before);
});


test('empty return has no minimum troop floor and is cleaned by normal empty-fleet rules',()=>{
 let s=recall(advanceFleetScenario(launch(setup(),1),103)).state;assert.equal(s.fleets[0]!.drillers,0);s=advanceFleetScenario(s,104);assert.equal(s.fleets[0]!.used,false);
});
test('returning to a captured origin follows ordinary hostile attack settlement',()=>{
 const c=setup();c.positions['红方后方']={x:.05,y:0};c.economy.outposts[2]!.drillers=200;
 let s=launch(c,99);s=submitFleetOrder(s,{id:'invasion',player:1,action:{kind:'launch',source:'红方后方',destination:'蓝方工厂',drillers:200}}).state;
 s=advanceFleetScenario(s,103);assert.equal(s.economy.outposts[0]!.owner,1);s=recall(s).state;
 s=advanceFleetScenario(s,110);assert.ok(s.events.some(e=>e.kind==='battle'&&e.subject==='ship'&&e.details.target==='蓝方工厂'));assert.equal(s.economy.outposts[0]!.owner,1);assert.equal(s.fleets.find(f=>f.id==='ship')!.used,false);
});

test('protocol exposes return only and validates its exact fields',()=>{
 assert.ok(PROTOCOL_PLAYER_ACTIONS.includes('return-fleet'));assert.deepEqual(parseProtocolAction({kind:'return-fleet',fleetId:'ship'}),{kind:'return-fleet',fleetId:'ship'});
 for(const kind of ['destroy-fleet','toggle-gift'])assert.throws(()=>parseProtocolAction({kind,fleetId:'ship'}),/Unsupported/);
 assert.throws(()=>parseProtocolAction({kind:'return-fleet',fleetId:'ship',enabled:true}));
 assert.doesNotThrow(()=>parseProtocolAction({kind:'launch',source:'a',destination:'b',drillers:1,delaySeconds:0}));
});
test('authorized forecast applies return and preserves its one-use status without changing real state',()=>{
 const s=advanceFleetScenario(launch(),104),o=observation({state:s,scheduled:[]},0,'return-forecast'),before=structuredClone(o);
 const result=forecastKnownObservation(o,105,[{id:'return-plan',issueTick:104,action:{kind:'return-fleet',fleetId:'ship'}}]);
 assert.equal(result.status,'conditional');if(result.status!=='conditional')return;
 const f=result.result.fleets.find(f=>f.id==='ship')!;assert.equal(f.drillers,10);assert.equal(f.returned,true);assert.equal(f.canReturn,false);
 assert.deepEqual(o,before);assert.equal(s.fleets[0]!.drillers,21);
 const returned=recall(s).state,view=observation({state:returned,scheduled:[]},0,'second-return');
 const second=forecastKnownObservation(view,105,[{id:'again',issueTick:104,action:{kind:'return-fleet',fleetId:'ship'}}]);assert.equal(second.status,'conditional');if(second.status==='conditional')assert.equal(second.orders[0]!.status,'failed');
});
test('integer booking holds troops at origin until the execution day and departs without preparation',()=>{
 const state=createFleetScenario(setup()),room=scheduleLaunch({state,scheduled:[]},{order:{id:'book',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:20}},departureTick:101});
 assert.equal(room.scheduled[0]!.issueTick,101);assert.equal(room.state.fleets.length,0);assert.equal(room.state.economy.outposts[0]!.drillers,100);
 const end=advanceRoom(room,101);assert.equal(end.scheduled[0]!.status,'executed');assert.equal(end.state.fleets[0]!.state,'moving');assert.equal(end.state.fleets[0]!.secondsUntilLaunch,0);assert.equal(end.state.economy.outposts[0]!.drillers,advanceFleetScenario(state,101).economy.outposts[0]!.drillers-20);
});

test('return at a fractional time turns at the current position and does not move twice',()=>{
 const original=advanceFleetScenario(launch(setup(),21),104),atStart=original.fleets[0]!.position.x;
 const returned=submitFleetOrder(original,{id:'fraction-return',player:0,action:{kind:'return-fleet',fleetId:'ship'}},300).state;
 assert.ok(returned.fleets[0]!.position.x>atStart);assert.equal(returned.fleets[0]!.secondsUntilLaunch,300);
 const next=advanceFleetScenario(returned,105);assert.ok(Math.abs(next.fleets[0]!.position.x-atStart)<1e-6);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(next)),next);
});

test('direct departure notification and activity agree on the command world time',()=>{
 const s=launch(setup(),21,150);
 const notice=projectPlayerNotifications(s,1).find(e=>e.kind==='departed')!;
 assert.ok(notice);assert.equal(notice.tick-1+notice.seconds/600,100.25);
 const event=projectPlayerActivity(s,0).find(e=>e.kind==='departed')!;
 assert.equal(event.tick+event.seconds/600,100.25);
});
