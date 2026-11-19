import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {AiStore,initialState,DEFAULT_EVENT_COALESCE_MS,type AiSnapshot,type SeatPollOptions} from '../packages/ai/src/index.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';

function latch(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
function fixture(beforeReply: (call:number)=>Promise<void> = async()=>{},onSnapshot:()=>void=()=>{}) {
  const room={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]};
  const snapshot:AiSnapshot={observation:observation(room,0,'coalescing'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
  const store=new AiStore(':memory:'),state=initialState('coalescing',0,{model:'',personality:'sentinel'});
  let calls=0;
  const runner=new SeatRunner(state,store,{
    advanceVersion:()=>'v1',snapshot:async()=>{onSnapshot();return structuredClone(snapshot);},request:async()=>snapshot.observation,
  },{step:async()=>{await beforeReply(++calls);return {tokens:0,reply:{tool:'finish',arguments:{},summary:'完成测试复核'}};}});
  const ordinaryEvent=()=>{
    const own=snapshot.observation.view.outposts.find(post=>post.owner===0)!;
    own.shieldsEnabled=own.shieldsEnabled===false;
    snapshot.observation.revision+='-changed';
  };
  return {snapshot,store,state,runner,ordinaryEvent,get calls(){return calls;},close:()=>{runner.pause();store.close();}};
}

const windows:{name:string;duration:number;options:SeatPollOptions}[]=[
  {name:'default 15-second',duration:15_000,options:{}},
  {name:'explicit 1-second',duration:1_000,options:{eventCoalesceMs:1_000}},
];

for(const {name,duration,options} of windows)test(`${name} window measures from the first event and blocks advance until work settles`,{timeout:10000},async t=>{
  t.mock.timers.enable({apis:['Date'],now:0});
  const entered=latch(),gate=latch();
  const f=fixture(async call=>{if(call===2){entered.release();await gate.promise;}});
  let running:Promise<void>|undefined;
  try{
    assert.equal(DEFAULT_EVENT_COALESCE_MS,15_000);
    await f.runner.poll(0);
    await f.runner.poll(1,false,true);
    const ready=()=>f.runner.readyToAdvance(f.snapshot.observation.view.tick,'v1');
    assert.equal(ready(),true);
    const first=100,deadline=first+duration;
    f.ordinaryEvent();await f.runner.poll(first,false,true,options);
    assert.equal(f.calls,1);assert.equal(ready(),false,'pending signals must block advance');
    assert.ok(f.store.latest<{signals:unknown[]}>('coalescing',0,'wake-state')!.signals.length>0);
    f.ordinaryEvent();await f.runner.poll(first+Math.floor(duration/2),false,true,options);
    await f.runner.poll(deadline-1,false,true,options);
    assert.equal(f.calls,1);assert.equal(ready(),false,'the full coalescing window must elapse');
    running=f.runner.poll(deadline,false,true,options);
    await Promise.race([entered.promise,running.then(()=>{throw Error('deadline poll ended without a decision');})]);
    assert.equal(f.calls,2,'a later event must not restart the first-event timer');
    assert.equal(ready(),false,'in-flight decision must block advance');
    assert.ok(f.store.latest<{inFlight:unknown}>('coalescing',0,'wake-state')!.inFlight);
    gate.release();await running;
    assert.equal(ready(),false,'a completed decision still requires a completed idle observation');
    await f.runner.poll(deadline+1,false,true,options);
    assert.equal(ready(),true);assert.equal(f.calls,2);
  }finally{gate.release();await running;f.close();}
});

test('a coalescing override is poll-local and does not replace the ordinary polling interval',async t=>{
  t.mock.timers.enable({apis:['Date'],now:0});
  const f=fixture();
  try{
    await f.runner.poll(0);
    f.ordinaryEvent();await f.runner.poll(100,false,true,{eventCoalesceMs:1_000});
    await f.runner.poll(1_100,false,false,{eventCoalesceMs:1_000});
    assert.equal(f.calls,1,'the normal five-second polling throttle is unchanged');
    await f.runner.poll(1_100,false,true);
    assert.equal(f.calls,1,'an ordinary poll must not inherit the prior short window');
    await f.runner.poll(15_099,false,true);assert.equal(f.calls,1);
    await f.runner.poll(15_100,false,true);assert.equal(f.calls,2);
  }finally{f.close();}
});

test('invalid coalescing durations reject before observing or dispatching work',async()=>{
  const f=fixture();
  try{
    for(const eventCoalesceMs of [-1,0,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
      await assert.rejects(f.runner.poll(0,true,true,{eventCoalesceMs}),/eventCoalesceMs must be a positive safe integer/);
    }
    assert.equal(f.calls,0);assert.equal(f.runner.settling,false);
    await f.runner.poll(0);assert.equal(f.calls,1,'legacy callers remain compatible after rejection');
  }finally{f.close();}
});


test('slow observation consumes the coalescing window and starts one decision in the same poll',async t=>{
 t.mock.timers.enable({apis:['Date'],now:0});let observationMs=0;
 const f=fixture(undefined,()=>{t.mock.timers.tick(observationMs);});
 try{
  await f.runner.poll(0);assert.equal(f.calls,1);
  f.ordinaryEvent();observationMs=1500;
  await f.runner.poll(100,false,true,{eventCoalesceMs:1000});
  assert.equal(f.calls,2,'the finished observation already consumed the merge window');
 }finally{f.close();}
});
