import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';import {AiStore,initialState,executeTool,PlayerGateway,type AiSnapshot,type AgentProvider} from '../packages/ai/src/index.js';
import {observationChanges} from '../packages/ai/src/controller/observation/changes.js';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {createPlayerApi,observation} from '../packages/server/src/player-api.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';

function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 setup.match={mode:'mining',neptuniumGoal:200};
 setup.economy.outposts[2]!.owner=0;setup.economy.outposts[2]!.drillers=20;
 const room={state:createFleetScenario(setup),scheduled:[]};
 const snapshot:AiSnapshot={observation:observation(room,0,'room'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 return {room,snapshot};
}
test('change summary preserves uncertainty, identifies failed schedules and ignores pure movement/countdowns',()=>{
 const {snapshot}=fixture(),before=snapshot.observation,after=structuredClone(before);
 after.view.outposts[0]!.drillers=(after.view.outposts[0]!.drillers??0)-3;after.view.outposts[1]={id:before.view.outposts[1]!.id,position:before.view.outposts[1]!.position,visibility:0};
 after.scheduled.push({id:'failed-plan',player:0,issueTick:100,action:{kind:'check-in'},status:'failed',reason:'test-failure'});
 before.view.fleets.push({id:'lost-view',owner:1,position:{x:1,y:1},drillers:10,state:'moving',gift:false,destination:null});
 const changes=observationChanges(before,after);
 const text=JSON.stringify(changes);assert.ok(text.includes('no-longer-observed'));assert.ok(text.includes('known'));assert.ok(text.includes('drillers'));assert.ok(text.includes('test-failure'));
 assert.equal(observationChanges(null,after).baselineAvailable,false);
 assert.equal(observationChanges({...before,roomId:'other'},after).baselineAvailable,false);
 const moving=structuredClone(before);moving.view.fleets[0]!.position.x=2;
 assert.equal(observationChanges(before,moving).changes.length,0);
});
test('reminders persist across runner restart, wake before ordinary review and are consumed once after completion',async()=>{
 const {snapshot}=fixture(),store=new AiStore(':memory:'),state=initialState('room',0,{model:'',personality:'sentinel'});
 let steps=0;
 const provider:AgentProvider={step:async request=>{steps++;return {tokens:1,reply:steps===1?{tool:'reminders',summary:'停战前检查',arguments:JSON.stringify({set:[{id:'treaty',atWorldDay:101,note:'重新核实边界'}]})}:{tool:'finish',summary:'等待',arguments:'{}'}};}};
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No game writes');}};
 try{
  store.save(state);await new SeatRunner(state,store,gateway,provider).poll(0,true);
  assert.equal(store.reminders('room',0).length,1);assert.equal(steps,2);assert.ok(store.baseline('room',0));
  const restored=store.load('room',0)!;snapshot.observation.view.tick=101;snapshot.observation.secondsSinceLastTick=0;
  const runner=new SeatRunner(restored,store,gateway,{step:async request=>{steps++;assert.ok(request.prompt.includes('重新核实边界'));assert.ok(request.prompt.includes('baselineAvailable'));return {tokens:1,reply:{tool:'finish',summary:'已复查',arguments:'{"reminders":{"complete":["treaty"]}}'}};}});
  await runner.pollAndFlush(10000);assert.equal(steps,3);assert.equal(store.reminders('room',0).length,0);
  await runner.pollAndFlush(20000);assert.equal(steps,3);
  assert.equal(store.reminders('other',0).length,0);
  await assert.rejects(executeTool('reminders',{set:[{id:'past',atWorldDay:1,note:'bad'}]},{state:restored,snapshot,gateway,id:'r',spoken:0,now:60300}));
 }finally{store.close();}
});
