import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {SeatRunner} from './helpers/scripted-controller.js';import {AiStore,initialState,type AiSnapshot} from '../packages/ai/src/index.js';import {createFleetScenario} from '../packages/engine/src/index.js';import {observation} from '../packages/server/src/player-api.js';
for(const fail of [false,true])test(`a ${fail?'failed':'stalled'} background read never owns foreground readiness`,async()=>{
 const state=initialState('independent',0,{model:'',personality:'schemer'}),store=new AiStore(':memory:');
 const view=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,state.roomId);
 const snapshot:AiSnapshot={observation:view,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};let release!:()=>void,entered!:()=>void,calls=0;
 const enteredRead=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const runner=new SeatRunner(state,store,{snapshot:async(_chat,_notifications,background)=>{if(background){entered();await gate;if(fail)throw Error('Synthetic background read failed');}return structuredClone(snapshot);},request:async()=>{throw Error('No remote writes');}},{step:async()=>{calls++;return {tokens:0,reply:{tool:'finish',arguments:{},summary:'Done'}};}});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const pending=runner.pollBackground();const settled=pending.then(()=>null,error=>error);await enteredRead;
  await Promise.race([runner.poll(0,true,true,{oneRoundPerTick:true}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Foreground waited for background')),5000);})]);
  assert.equal(calls,1);assert.equal(state.status,'waiting');assert.equal(state.error,null);assert.ok(runner.readyToAdvance(view.view.tick));
  release();const error=await settled;assert.equal(error instanceof Error,fail);assert.equal(state.status,'waiting');assert.equal(state.error,null);assert.ok(runner.readyToAdvance(view.view.tick));
 }finally{release();if(timer)clearTimeout(timer);store.close();}
});
