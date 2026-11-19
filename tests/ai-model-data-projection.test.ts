import test from 'node:test';
import assert from 'node:assert/strict';
import {projectModelData} from '../packages/ai/src/controller/presentation/model-data-projection.js';

const full='p0-'+ 'a'.repeat(64),collision='p0-'+'a'.repeat(8)+'b'.repeat(56);

test('authorized countdowns and typed changes use world days without altering unknowns or original evidence',()=>{
 const input={changes:[
  {kind:'outposts',id:'a',event:'changed',fields:{mineRemainingSeconds:{before:300,after:0},shieldDisableRemainingSeconds:{before:{known:false},after:600}}},
  {kind:'fleets',id:full,event:'changed',fields:{giftPendingSeconds:{before:0,after:null},}},
  {kind:'outposts',id:'a',event:'newly-observed',current:{id:'a',visibility:2,mineRemainingSeconds:300,shieldDisableRemainingSeconds:0}},
 ],
 arguments:{changes:[{kind:'outposts',event:'changed',fields:{mineRemainingSeconds:{before:300,after:0}}}]},unrelated:{mineRemainingSeconds:77}};
 const original=structuredClone(input),shown=projectModelData(input) as any;
 assert.deepEqual(shown.changes[0].fields.mineRemainingWorldDays,{before:.5,after:0});
 assert.deepEqual(shown.changes[0].fields.shieldDisableRemainingWorldDays,{before:{known:false},after:1});
 assert.deepEqual(shown.changes[1].fields.giftPendingSecondsWorldDays,{before:0,after:null});
 assert.equal(shown.changes[2].current.mineRemainingWorldDays,.5);assert.equal(shown.changes[2].current.shieldDisableRemainingWorldDays,0);
 assert.deepEqual(shown.arguments,input.arguments);assert.deepEqual(shown.unrelated,input.unrelated);
 assert.deepEqual(projectModelData(shown),shown);assert.deepEqual(input,original);
 const conflict={kind:'outposts',id:'a',event:'changed',fields:{mineRemainingSeconds:{before:300,after:0},mineRemainingWorldDays:{before:99,after:0}}};
 const retained=projectModelData(conflict) as any;assert.deepEqual(retained.fields.mineRemainingSeconds,conflict.fields.mineRemainingSeconds);
 assert.equal(retained.fields.mineRemainingWorldDays.before,99);assert.equal(retained.fields.timeProjectionConflicts.length,1);assert.deepEqual(projectModelData(retained),retained);
});
const view=()=>({format:'player-observation/2',player:0,tick:4,size:{width:30,height:30},sonar:[],outposts:[
 {id:'a',position:{x:-14,y:0},owner:0,visibility:2,drillers:10,metrics:{active:true,output:6,cycleMinutes:10,nextMinutes:null}},
 {id:'b',position:{x:14,y:0},owner:1,visibility:2,drillers:0}],
 fleets:[{id:full,owner:0,position:{x:-14,y:0},source:'a',destination:{kind:'outpost',id:'b'},drillers:3,state:'waiting',launchRemainingSeconds:300}],});
const observation=()=>({roomId:'internal-room',revision:'exact-basis',view:view(),secondsSinceLastTick:150,scheduled:[]});

test('nested originalResult uses the accepted-receipt projection without upgrading outer unknown outcome',()=>{
 const input={id:'retry-check',tool:'order',result:{status:'unknown',accepted:false,originalResult:observation(),detail:{message:'receipt not confirmed'}}};
 const shown=projectModelData(input) as any;
 assert.equal(shown.result.status,'unknown');assert.equal(shown.result.accepted,false);
 assert.equal(shown.result.originalResult.view,undefined);assert.equal(shown.result.originalResult.accepted,true);
 assert.equal(shown.result.originalResult.observedWorldDay,4.25);assert.equal(shown.result.originalResult.revision,'exact-basis');
 const recalled={tool:'recall',result:{historical:true,stale:true,tool:'order',id:'original',result:observation()}};
 const read=projectModelData(recalled) as any;assert.equal(read.result.historical,true);assert.equal(read.result.stale,true);assert.equal(read.result.result.view,undefined);
 assert.equal((projectModelData({tool:'order',result:{...observation(),status:'pending'}}) as any).result.status,'pending');
 assert.ok(input.result.originalResult.view);
});

test('current map, note, reminder and event clocks distinguish activity from settlement notifications',()=>{
 const activity={id:0,kind:'battle',tick:4,seconds:150,actor:0,subject:full,source:'a',destination:{kind:'outpost',id:'b'},drillers:3,enabled:null};
 const notification={id:0,kind:'battle',tick:5,seconds:150,text:'Actual battle',details:null,urgent:true,sendNotification:true,location:null};
 const input={observation:{...observation(),activity:[activity]},chatCursor:999,notificationCursor:888,chat:[{id:'m',from:0,to:1,tick:4,sentAt:0,text:'historical text'}],
  reminders:[{id:'due',atSeconds:3000,note:'review'}],notebook:[{id:'n',kind:'fact',text:'old',updatedAt:600,expiresAt:null}],source:{kind:'notification',id:'event',observedSeconds:2550},notifications:[notification],events:[notification]};
 const before=structuredClone(input),shown=projectModelData(input) as any;
 assert.equal(shown.observation.observedWorldDay,4.25);assert.equal(shown.observation.roomId,undefined);assert.equal(shown.chatCursor,undefined);
 assert.equal(shown.chat[0].sentAtUtc,'1970-01-01T00:00:00.000Z');assert.equal(shown.reminders[0].atWorldDay,5);assert.equal(shown.notebook[0].expiresWorldDay,null);assert.equal(shown.source.observedWorldDay,4.25);
 assert.equal(shown.observation.activity[0].eventWorldDay,4.25);assert.equal(shown.notifications[0].eventWorldDay,4.25);assert.equal(shown.notifications[0].eventTimeBasis,'settlement-tick-interval');
 assert.deepEqual(shown.events,input.events,'an unclassified event array cannot borrow notification provenance');
 assert.deepEqual(input,before);assert.deepEqual(projectModelData(shown),shown);
});

test('typed fleet countdown conflicts retain original duration and explicit unknown without choosing a winner',()=>{
 for(const value of [99,null,'unknown']){
  const input={tool:'forecast',result:{status:'conditional',fleets:[{id:full,state:'moving',drillers:3,destination:{kind:'outpost',id:'b'},arrivalMinutes:10,arrivalWorldDays:value}]}};
  const before=structuredClone(input),shown=projectModelData(input) as any,fleet=shown.result.fleets[0];
  assert.equal(fleet.arrivalMinutes,10);assert.equal(fleet.arrivalWorldDays,value);assert.equal(fleet.timeProjectionConflicts[0].status,'unresolved');
  assert.deepEqual(projectModelData(shown),shown);assert.deepEqual(input,before);
 }
 const contradictory={id:'due',note:'do not lose contradiction',atSeconds:600,atWorldDay:999},shown=projectModelData(contradictory) as any;
 assert.equal(shown.atSeconds,600);assert.equal(shown.atWorldDay,999);assert.equal(shown.timeProjectionConflicts[0].status,'unresolved');
});

test('matching fleet durations compact, while arbitrary current time cannot invent an absolute arrival',()=>{
 const input={tool:'forecast',result:{status:'conditional',fleets:[{id:full,state:'moving',drillers:3,destination:{kind:'outpost',id:'b'},arrivalMinutes:10,arrivalWorldDays:1}]}};
 const shown=projectModelData(input,{currentRevision:'different',currentWorldDay:100}) as any;
 assert.equal(shown.result.fleets[0].arrivalWorldDays,1);assert.equal('arrivalMinutes'in shown.result.fleets[0],false);assert.equal('arrivalWorldDay'in shown.result.fleets[0],false);
 const notification={id:0,kind:'battle',tick:5,seconds:150,text:'Actual',eventWorldDay:999};
 const activity={id:0,kind:'battle',tick:4,seconds:150,actor:0,subject:full,source:null,destination:null,drillers:0,enabled:null,eventWorldDay:null};
 const mixed=projectModelData({notifications:[notification],activity:[activity]}) as any;
 assert.equal(mixed.notifications[0].eventWorldDay,999);assert.equal(mixed.notifications[0].derivedEventClock.eventWorldDay,4.25);
 assert.equal(mixed.activity[0].eventWorldDay,null);assert.equal(mixed.activity[0].tick,4);assert.equal(mixed.activity[0].seconds,150);
 assert.equal(mixed.notifications[0].timeProjectionConflicts[0].status,'unresolved');assert.equal(mixed.activity[0].timeProjectionConflicts[0].status,'unresolved');
 assert.deepEqual(projectModelData(mixed),mixed);
});

test('contradictory chat and waiting-departure clocks keep anchors and explicit uncertainty',()=>{
 const input={chat:[{id:'m',from:0,to:1,text:'old',tick:1,sentAt:0,sentAtUtc:'explicit-other-time'}],timing:{observedSeconds:600,observedWorldDay:99,waitingDepartures:[{id:'f',secondsRemaining:600,remainingWorldDays:99}]},source:{kind:'notification',observedSeconds:600,observedWorldDay:null}};
 const before=structuredClone(input),shown=projectModelData(input) as any;
 assert.equal(shown.chat[0].sentAt,0);assert.equal(shown.chat[0].sentAtUtc,'explicit-other-time');assert.equal(shown.chat[0].timeProjectionConflicts[0].status,'unresolved');
 assert.equal(shown.timing.observedSeconds,600);assert.equal(shown.timing.observedWorldDay,99);assert.equal(shown.timing.timeProjectionConflicts[0].displayField,'observedWorldDay');
 assert.equal(shown.timing.waitingDepartures[0].secondsRemaining,600);assert.equal(shown.timing.waitingDepartures[0].remainingWorldDays,99);assert.equal(shown.timing.waitingDepartures[0].timeProjectionConflicts[0].status,'unresolved');
 assert.equal(shown.source.observedSeconds,600);assert.equal(shown.source.observedWorldDay,null);assert.equal(shown.source.timeProjectionConflicts[0].status,'unresolved');
 assert.deepEqual(projectModelData(shown),shown);assert.deepEqual(input,before);
 const matching={chat:[{...input.chat[0],sentAtUtc:'1970-01-01T00:00:00.000Z'}],timing:{observedSeconds:600,waitingDepartures:[{id:'f',secondsRemaining:600,remainingWorldDays:1}]}};
 const compact=projectModelData(matching) as any;assert.equal('sentAt'in compact.chat[0],false);assert.equal('secondsRemaining'in compact.timing.waitingDepartures[0],false);
});
