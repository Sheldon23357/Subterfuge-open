import {protocolHarness,createOwnerProtocolHost} from './player-protocol-test-helpers.js';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiStore,SeatRunner,initialState} from '../packages/ai/src/index.js';
import {AI_PERSONALITIES} from '../packages/contracts/src/index.js';
import {LabAi} from './helpers/scripted-lab.js';
import {validateLabAi} from '../packages/server/src/lab-ai.js';
import {SerialExecutor} from '../packages/server/src/player-access.js';
import {ChatStore} from '../packages/server/src/chat.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {advanceRoom,type LabRoom} from '../packages/server/src/planning.js';
import {createEightPlayerScenario} from '../packages/server/src/eight-player.js';

test('AI history paginates without mixing rooms or seats and preserves existing records',()=>{
  const store=new AiStore(':memory:');
  try{
    const state=initialState('room-a',1,{model:'',personality:'schemer'});
    for(let i=0;i<65;i++)store.save(state,'tool-intent',{summary:`decision-${i}`});
    store.save({...state,roomId:'room-b'},'tool-intent',{summary:'other room'});
    store.save({...state,lobbySeat:2},'tool-intent',{summary:'other seat'});
    const first=store.historyPage('room-a',1);
    assert.equal(first.entries.length,30);assert.ok(first.nextCursor);
    store.save(state,'tool-result',{summary:'new event'});
    const second=store.historyPage('room-a',1,first.nextCursor!);
    const third=store.historyPage('room-a',1,second.nextCursor!);
    assert.equal(third.nextCursor,null);
    const all=[...first.entries,...second.entries,...third.entries];
    assert.equal(all.length,65);assert.equal(new Set(all.map(e=>e.id)).size,65);
    assert.deepEqual(all.at(-1)!.payload,{summary:'decision-0'});
    assert.throws(()=>store.historyPage('room-a',1,0));
    assert.deepEqual(store.historyPage('room-a',0).entries,[]);
  }finally{store.close();}
});

test('test-room AI configuration allows seat zero and rejects duplicates, out-of-range and malformed settings',()=>{
  const settings={model:'',personality:'schemer'};
  assert.equal(validateLabAi([{seat:1,settings}],2).length,1);
  assert.equal(validateLabAi([{seat:0,settings},{seat:1,settings}],2).length,2);
  assert.equal(Object.keys(AI_PERSONALITIES).length,9);
  for(const personality of Object.keys(AI_PERSONALITIES)) assert.equal(validateLabAi([{seat:1,settings:{...settings,personality}}],2)[0]!.settings.personality,personality);
  for(const raw of [[{seat:-1,settings}],[{seat:2,settings}],[{seat:1,settings},{seat:1,settings}], [{seat:1,settings:{...settings,personality:'unknown'}}]]) assert.throws(()=>validateLabAi(raw,2));
});

test('only automatic test stepping supplies a 1-second window to programmatic seats',async t=>{
  const store=new AiStore(':memory:');
  const room:LabRoom={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[],playerRoomId:'coalescing-routing'};
  const polls:{seat:number;args:Parameters<SeatRunner['poll']>}[]=[];
  t.mock.method(SeatRunner.prototype,'poll',async function(this:SeatRunner,...args:Parameters<SeatRunner['poll']>){polls.push({seat:this.state.lobbySeat,args});});
  const ai=new LabAi({room:()=>room},store,{step:async()=>{throw Error('No provider calls in a scheduling test');}});
  const windows=()=>polls.map(({seat,args})=>({seat,eventCoalesceMs:args[3]?.eventCoalesceMs??15_000}));
  try{
    ai.reset(validateLabAi([
      {seat:0,settings:{model:'',personality:'sentinel',provider:'offline'}},
      {seat:1,settings:{model:'',personality:'schemer'}},
    ],2));
    ai.tick();
    assert.deepEqual(windows(),[{seat:0,eventCoalesceMs:15_000},{seat:1,eventCoalesceMs:15_000}]);
    polls.length=0;
    assert.equal(ai.readyToStep('automatic-test',100),false);
    assert.deepEqual(windows(),[{seat:0,eventCoalesceMs:1_000},{seat:1,eventCoalesceMs:1_000}]);
    assert.ok(polls.every(({args})=>args[0]===100&&args[1]===false&&args[2]===true),'automatic stepping refreshes observations without forcing a decision');
    polls.length=0;
    room.clock={format:'realtime-clock/1',anchorMs:0,anchorTick:room.state.economy.tick};
    ai.readyToStep('real-time',101);
    assert.deepEqual(windows(),[{seat:0,eventCoalesceMs:15_000},{seat:1,eventCoalesceMs:15_000}]);
    polls.length=0;delete room.clock;ai.tick();
    assert.deepEqual(windows(),[{seat:0,eventCoalesceMs:15_000},{seat:1,eventCoalesceMs:15_000}],'returning to ordinary polling cannot retain the short window');
  }finally{await ai.stop();store.close();}
});

test('all eight AI seats start together while each seat remains single-flight',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'subterfuge-ai-concurrency-'));
  const store=new AiStore(join(dir,'ai.sqlite'));
  const chat=new ChatStore(join(dir,'chat.json'));await chat.load();
  const room:LabRoom={state:createEightPlayerScenario(),scheduled:[],playerRoomId:'concurrency-test'};
  let calls=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const h=protocolHarness(t,{room,roomId:room.playerRoomId!}),protocol=await createOwnerProtocolHost(h,{chat:()=>chat});
  const ai=new LabAi({room:()=>room,protocol,chat:()=>chat},store,{step:async()=>{calls++;await gate;return{reply:{tool:'finish',arguments:'{}',summary:'等待'},tokens:1};}});
  try{
    await ai.start();
    ai.reset(validateLabAi(Array.from({length:8},(_,i)=>({seat:i,settings:{model:'',personality:'schemer'}})),8));
    assert.equal(ai.status().concurrency,24);
    ai.tick();
    for(let i=0;i<100&&calls<8;i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(calls,8);
    ai.tick();assert.equal(calls,8);
    release();
    for(let i=0;i<100&&ai.status().seats.some(s=>s.status==='thinking');i++)await new Promise(resolve=>setTimeout(resolve,20));
  }finally{release();await ai.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('test-room bots use filtered player API, can pause, and reset invalidates old work',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'subterfuge-lab-ai-'));
  const store=new AiStore(join(dir,'ai.sqlite'));
  const chat=new ChatStore(join(dir,'chat.json'));await chat.load();
  let room:LabRoom={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[],playerRoomId:'lab-ai-test'};
  const prompts:string[]=[];
  const h=protocolHarness(t,{room,roomId:room.playerRoomId!}),protocol=await createOwnerProtocolHost(h,{chat:()=>chat});
  const ai=new LabAi({room:()=>room,protocol,chat:()=>chat},store,{step:async request=>{prompts.push(request.prompt);return {reply:{tool:'finish',arguments:'{}',summary:'等待'},tokens:5};}});
  try{
    await ai.start();
    ai.reset(validateLabAi([{seat:1,settings:{model:'test-model',personality:'schemer'}}],2));
    assert.equal(ai.hasEnabledSeat(),true);
    ai.tick();
    for(let i=0;i<100&&ai.status().seats[0]!.calls===0;i++)await new Promise(resolve=>setTimeout(resolve,20));
    for(let i=0;i<100&&ai.status().seats[0]!.status==='thinking';i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(prompts.length,1);
    assert.equal(ai.status().seats[0]!.status,'waiting');
    assert.equal(ai.status().seats[0]!.tokens,0);
    assert.deepEqual(ai.history(1).agent?.memory,{strategy:'',relations:'',agreements:'',deceptions:''});
    assert.equal(ai.history(0).agent,null);
    assert.equal(ai.history(1).screening,undefined);
    assert.ok(ai.history(1,undefined,true).screening);
    assert.equal(ai.history(0,undefined,true).screening,null);
    assert.throws(()=>ai.history(2));
    assert.ok(!JSON.stringify(ai.status()).includes('credentials'));
    const beforeResume=store.load('lab-ai-test',1)!.nextReview;
    ai.command({seat:1,action:'pause'});assert.equal(ai.status().seats[0]!.enabled,false);assert.equal(ai.hasEnabledSeat(),false);
    ai.command({seat:1,action:'resume',settings:{model:'replacement-model',personality:'sentinel'}});assert.equal(ai.status().seats[0]!.enabled,true);
    assert.deepEqual(ai.status().seats[0]!.settings,{mode:'hybrid',model:'replacement-model',personality:'sentinel'});
    assert.equal(store.load('lab-ai-test',1)!.nextReview,beforeResume);
    const countBefore=prompts.length;ai.tick();
    await new Promise(resolve=>setTimeout(resolve,40));assert.equal(prompts.length,countBefore);
    ai.reset();assert.equal(ai.status().seats[0]!.status,'paused');
    room={...room,playerRoomId:'new-test-room'};ai.reset();assert.equal(ai.status().seats.length,0);
  }finally{await ai.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

function latch(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

async function verifyAutomaticStepping(t:TestContext,slowObservation=false){
  const dir=mkdtempSync(join(tmpdir(),'subterfuge-auto-ai-'));
  const store=new AiStore(join(dir,'ai.sqlite'));
  const chat=new ChatStore(join(dir,'chat.json'));await chat.load();
  const room:LabRoom={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[],playerRoomId:'auto-ai-test'};
  const clockSetup={...room.state.initial,economy:{...room.state.initial.economy,initialTick:96}};room.state=createFleetScenario(clockSetup);
  const wall=1_000_000;let now=wall,calls=0,runner:SeatRunner|undefined;
  t.mock.method(Date,'now',()=>now);
  const modelEntered=latch(),modelGate=latch(),readGate=latch(),serial=new SerialExecutor();
  const polls:Promise<void>[]=[];
  const originalPoll=SeatRunner.prototype.poll;
  t.mock.method(SeatRunner.prototype,'poll',function(this:SeatRunner,...args:Parameters<SeatRunner['poll']>){
    const pending=originalPoll.apply(this,args);
    if(this.state.roomId==='auto-ai-test'){
      runner=this;polls.push(pending);
      // Preserve the rejection for drain, while handling an early rejection
      // before the test reaches its barrier (never use a detached finally).
      void pending.catch(()=>{});
    }
    return pending;
  });
  const drain=async()=>{
    // Include every observer, not just the latest poll which may have returned
    // early because another observer is still in flight. Do not poll for ready.
    let failure:PromiseRejectedResult|undefined;
    while(polls.length){
      const settled=await Promise.allSettled(polls.splice(0));
      failure??=settled.find((result):result is PromiseRejectedResult=>result.status==='rejected');
    }
    if(failure)throw failure.reason;
    if(runner)assert.equal(runner.settling,false,'all started observation/model work must have settled');
  };
  const h=protocolHarness(t,{room,roomId:room.playerRoomId!}),protocol=await createOwnerProtocolHost(h,{serial,chat:()=>chat});
  const ai=new LabAi({room:()=>room,protocol,chat:()=>chat},store,{step:async()=>{
    calls++;modelEntered.release();await modelGate.promise;
    return {reply:{tool:'finish',arguments:'{}',summary:'平静局面稍后复查'},tokens:1};
  }});
  // This test drives the real scheduler through readyToStep. Its independent
  // five-second periodic tick is covered elsewhere and must not race this drive.
  t.mock.method(ai,'tick',()=>{});
  const expectImmediateReady=()=>assert.equal(ai.readyToStep('auto',now),true,'an uneventful tick needs no extra idle delay');
  try{
    await ai.start();ai.reset(validateLabAi([{seat:1,settings:{model:'',personality:'schemer'}}],2));
    assert.equal(ai.readyToStep('auto',now),false);
    assert.equal(polls.length,1);
    await Promise.race([modelEntered.promise,polls[0]!.then(()=>{throw Error('initial poll ended without entering the model');})]);
    assert.equal(calls,1);
    now=wall+100;assert.equal(ai.readyToStep('auto',now),false);
    assert.equal(ai.status().seats[0]!.status,'thinking');
    now=wall+5100;assert.equal(ai.readyToStep('auto',now),false,'in-flight model blocks test-room automatic stepping');
    modelGate.release();await drain();
    now=wall+5200;ai.readyToStep('auto',now); // Start the required idle check once.
    await drain();
    assert.equal(ai.readyToStep('auto',now),true,'advance immediately after a complete idle check at the same wall time');
    const initialTick=room.state.economy.tick;
    for(let elapsed=1;elapsed<=6;elapsed++){
      room.state=advanceRoom(room,initialTick+elapsed).state;h.store.commit(room,h.store.load()!.revision);
      now=wall+elapsed*20000;
      let blocked:Promise<void>|undefined;
      if(slowObservation&&elapsed===1){
        const entered=latch();
        blocked=serial.run(async()=>{entered.release();await readGate.promise;});
        await entered.promise;
      }
      assert.equal(ai.readyToStep('auto',now),false,'new tick must first be observed');
      if(blocked){
        // Reproduce a real authenticated read taking longer than the old 80ms
        // sleep. Real elapsed time is not permission to advance strategy time.
        const began=performance.now();await new Promise(resolve=>setTimeout(resolve,120));
        assert.ok(performance.now()-began>=80);
        assert.equal(Date.now(),now);assert.equal(runner!.settling,true);
        assert.equal(ai.readyToStep('auto',now),false,'a read held past 80ms is still incomplete');
        readGate.release();await blocked;
      }
      await drain();
      assert.equal(calls,1,'game hours do not invoke the model without an explicit reminder');
      expectImmediateReady(); // No +100ms allowance, no repeated readiness wait.
      if(blocked){
        // Negative control: retain the real readiness checks and add a 1ms
        // strategy delay. The exact same acceptance assertion must reject it,
        // even though observation I/O already consumed over 80ms of real time.
        const originalReady=runner!.readyToAdvance,allowedAt=now+1;
        const delayed=t.mock.method(runner!,'readyToAdvance',function(this:SeatRunner,...args:Parameters<SeatRunner['readyToAdvance']>){
          return originalReady.apply(this,args)&&Date.now()>=allowedAt;
        });
        try{assert.throws(expectImmediateReady,{name:'AssertionError',message:/an uneventful tick needs no extra idle delay/});}
        finally{delayed.mock.restore();}
        await drain();expectImmediateReady();assert.equal(calls,1);
      }
    }
    ai.command({seat:1,action:'pause'});now=wall+200000;
    assert.equal(ai.readyToStep('paused',now),true,'paused AI must not stop the clock');
  }finally{
    modelGate.release();readGate.release();
    try{await drain();}finally{await ai.stop();store.close();rmSync(dir,{recursive:true,force:true});}
  }
}

test('automatic stepping waits for AI thinking and observation without forcing a model call every tick',{timeout:30000},async t=>{
  await verifyAutomaticStepping(t);
});
test('slow authenticated observation exceeds 80ms without permitting any additional strategy idle delay',{timeout:30000},async t=>{
  await verifyAutomaticStepping(t,true);
});


test('decision pages pair outcomes across noisy records and paginate whole rounds',()=>{
 const store=new AiStore(':memory:');
 try{
  const state=initialState('rounds',1,{model:'',personality:'sentinel'});
  for(let sequence=1;sequence<=10;sequence++){
   store.save(state,'started',null);
   store.save(state,'call-reserved',{sequence,step:0});
   const id=`ai-1-${sequence}-0`;
   store.save(state,'tool-intent',{id,tool:'order',summary:'defend',arguments:{action:{kind:'check-in'}}});
   for(let i=0;i<35;i++)store.save(state,'usage',{tokens:1});
   store.save(state,'tool-rejected',{id,tool:'order',result:{error:'stale-observation'}});
   store.save(state,'completed');store.save(state,'paused');
  }
  store.save({...state,lobbySeat:2},'started',{sequence:999});
  const first=store.decisionPage('rounds',1);
  assert.equal(first.entries.length,8);
  assert.equal(first.entries[0]!.payload.sequence,10);
  assert.equal(first.entries[0]!.payload.status,'completed');
  assert.deepEqual(first.entries[0]!.payload.stats,{tokens:35,durationMs:null,durationComplete:false});
  assert.equal(first.entries[0]!.payload.steps.length,1);
  assert.equal(first.entries[0]!.payload.steps[0]!.status,'rejected');
  const last=store.decisionPage('rounds',1,first.nextCursor!);
  assert.deepEqual(last.entries.map(e=>e.payload.sequence),[2,1]);
  assert.equal(last.nextCursor,null);
  assert.equal(store.decisionPage('elsewhere',1).entries.length,0);
 }finally{store.close();}
});

test('decision statistics isolate rounds and include failed attempt elapsed time',()=>{
 const store=new AiStore(':memory:');
 try{
  const state=initialState('stats',1,{model:'',personality:'sentinel'});
  store.save(state,'started',{sequence:1});
  store.save(state,'call-failed',{durationMs:120000,roundElapsedMs:120050});
  store.save(state,'call-completed',{durationMs:10000,roundElapsedMs:130100});
  store.save(state,'usage',{tokens:1200});
  store.save(state,'usage',{tokens:300});
  store.save(state,'completed',{durationMs:135500});
  store.save(state,'paused');
  store.save(state,'started',{sequence:2});
  store.save(state,'call-completed',{durationMs:2000,roundElapsedMs:2100});
  store.save(state,'usage',{tokens:0});
  store.save({...state,lobbySeat:2},'usage',{tokens:99999});
  const rounds=store.decisionPage('stats',1).entries;
  assert.deepEqual(rounds[0]!.payload.stats,{tokens:0,durationMs:2100,durationComplete:false});
  assert.deepEqual(rounds[1]!.payload.stats,{tokens:1500,durationMs:135500,durationComplete:true});
  store.save(state,'started',{sequence:3});
  assert.deepEqual(store.decisionPage('stats',1).entries[0]!.payload.stats,{tokens:null,durationMs:null,durationComplete:false});
 }finally{store.close();}
});


test('AI history uses one world cut for campaign and notebook projections',async()=>{
 const store=new AiStore(':memory:');
 const room:LabRoom={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[],playerRoomId:'single-history-cut'};
 let reads=0;
 const ai=new LabAi({room:()=>{reads++;return room;}},store,{step:async()=>{throw Error('No model call');}});
 try{
  ai.reset([{seat:0,settings:{model:'',personality:'schemer'}}]);
  store.save(store.load(room.playerRoomId!,0)!,'campaign-state',{plans:[]});
  reads=0;
  const result=ai.history(0,undefined,true);
  assert.equal(reads,1);assert.deepEqual(result.campaigns,{plans:[]});
  assert.equal(result.roomId,room.playerRoomId);assert.ok(result.agent);
 }finally{await ai.stop();store.close();}
});
