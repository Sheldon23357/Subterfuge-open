import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {AiStore,initialState,type AiSnapshot} from '../packages/ai/src/index.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';

test('advance certificates reject a version changed during an asynchronous snapshot and require a complete idle poll',async()=>{
  const store=new AiStore(':memory:'),state=initialState('certificate',0,{model:'',personality:'sentinel'});
  const room={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]};
  const snapshot:AiSnapshot={observation:observation(room,0,'certificate'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
  let version='v1',release:()=>void=()=>{},calls=0,gate=Promise.resolve();
  const runner=new SeatRunner(state,store,{advanceVersion:()=>version,snapshot:async()=>{await gate;return structuredClone(snapshot);},request:async()=>{throw Error('Unexpected write');}},{step:async()=>{calls++;return {tokens:1,reply:{tool:'finish',arguments:{},summary:'完成'}};}});
  try{
    await runner.poll(0);assert.equal(runner.readyToAdvance(100,'v1'),false,'model completion alone cannot certify observation');
    await runner.poll(1,false,true);assert.equal(runner.readyToAdvance(100,'v1'),true);
    version='v2';assert.equal(runner.readyToAdvance(100,'v2'),false);
    gate=new Promise<void>(r=>release=r);const checking=runner.poll(2,false,true);
    assert.equal(runner.readyToAdvance(100,'v2'),false,'in-flight observation blocks');
    version='v3';release();await checking;
    assert.equal(runner.readyToAdvance(100,'v3'),false,'mixed versions cannot certify a check');
    await runner.poll(3,false,true);assert.equal(runner.readyToAdvance(100,'v3'),true);
    snapshot.hasMore=true;version='v4';await runner.poll(4,false,true);
    assert.equal(runner.readyToAdvance(100,'v4'),false,'unread notification/chat pages block');
    snapshot.hasMore=false;await runner.poll(5,false,true);assert.equal(runner.readyToAdvance(100,'v4'),true);
    assert.equal(calls,1,'checks never force thinking');
  }finally{release();runner.pause();store.close();}
});
