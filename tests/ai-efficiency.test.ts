import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {AiStore,initialState,executeTool,type AiSnapshot,type AgentRequest} from '../packages/ai/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';

function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const room={state:createFleetScenario(cfg),scheduled:[]};
 const snapshot:AiSnapshot={observation:observation(room,0,'room'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 snapshot.observation.outpostNames=Object.fromEntries(snapshot.observation.view.outposts.map(p=>[p.id,p.id]));
 return {snapshot,store:new AiStore(':memory:'),state:initialState('room',0,{model:'',personality:'schemer'})};
}
const reply=(tool:string,args:unknown)=>({tokens:1,reply:{tool,arguments:JSON.stringify(args),summary:'测试决策'}});

test('one finish atomically replaces notes, memory and reminders without any game request',async()=>{
 const f=fixture();let calls=0;f.state.memory.strategy='old strategy';
 f.store.save(f.state,'notebook-set',{id:'proposal',kind:'plan',text:'old offer',updatedAt:0,expiresAt:null});
 f.store.save(f.state,'reminder-set',{id:'old',atSeconds:60600,note:'old'});
 try{
  const runner=new SeatRunner(f.state,f.store,{snapshot:async()=>structuredClone(f.snapshot),request:async()=>{throw Error('No game writes');}},{step:async()=>{
   calls++;return reply('finish',{memory:{strategy:'accepted treaty'},notebook:{remove:['proposal'],set:[{id:'proposal',kind:'agreement',text:'confirmed',expiresWorldDay:null}]},reminders:{cancel:['old'],set:[{id:'next',atWorldDay:102,note:'verify treaty',category:'plan',entities:[]}]}});
  }});
  await runner.poll(0,true);
  assert.equal(calls,1);assert.equal(f.state.status,'waiting');assert.equal(f.store.load('room',0)!.memory.strategy,'accepted treaty');
  assert.equal(f.store.notebook('room',0,60000)[0]!.text,'confirmed');
  assert.deepEqual(f.store.reminders('room',0).map(r=>r.id),['next']);
  assert.equal(f.store.latest<any>('room',0,'memory-archived').memory.strategy,'old strategy');
 }finally{f.store.close();}
});

test('invalid finalization changes neither memory nor notes and a corrected finish can recover',async()=>{
 const f=fixture();f.state.memory.strategy='keep';let calls=0;
 try{
  const runner=new SeatRunner(f.state,f.store,{snapshot:async()=>structuredClone(f.snapshot),request:async()=>{throw Error('No writes');}},{step:async()=>++calls===1?reply('finish',{
   memory:{strategy:'must not save'},notebook:{set:[{id:'bad',kind:'plan',text:'must not save'}]},reminders:{set:[{id:'bad',atWorldDay:102,note:'bad',entities:['hidden-entity']}]}
  }):reply('finish',{})});
  await runner.poll(0,true);
  assert.equal(calls,2);assert.equal(f.state.memory.strategy,'keep');assert.deepEqual(f.store.notebook('room',0,60000),[]);
  assert.deepEqual(f.store.reminders('room',0),[]);assert.equal(f.state.status,'waiting');
  assert.match(f.store.latest<any>('room',0,'tool-rejected').result.error,/reminder entities/);
 }finally{f.store.close();}
});

test('local multi-event commit rolls back all notes and state if any payload fails',()=>{
 const f=fixture();f.store.save(f.state,'before');
 try{
  assert.throws(()=>f.store.saveEvents({...f.state,memory:{...f.state.memory,strategy:'must roll back'}},[
   {kind:'notebook-set',details:{id:'partial',kind:'plan',text:'must roll back',updatedAt:0,expiresAt:null}},
   {kind:'invalid',details:BigInt(1)},
  ]));
  assert.deepEqual(f.store.notebook('room',0,60000),[]);assert.equal(f.store.load('room',0)!.memory.strategy,'');
  assert.equal(f.store.latest('room',0,'invalid'),null);
 }finally{f.store.close();}
});

test('private audit retains exact own query arguments and isolates rooms and seats without a model recall',async()=>{
 const f=fixture(),other=initialState('room',1,{model:'',personality:'schemer'});
 const c={...f,gateway:{snapshot:async()=>f.snapshot,request:async()=>{throw Error('No query rerun');}},id:'current',spoken:0,now:60000,readToolResult:(id:string)=>f.store.queryResult('room',0,id)};
 try{
  f.store.save(f.state,'tool-intent',{id:'own',tool:'compare',arguments:{targetTick:112,plans:[{id:'a'}]}});
  f.store.save(f.state,'tool-result',{id:'own',tool:'compare',result:{basisRevision:'old',scenarios:[{id:'a',forecast:{exact:'saved forecast'}}]}});
  f.store.save(other,'tool-result',{id:'foreign',tool:'compare',result:{secret:'other'}});
  f.store.save({...other,roomId:'another'},'tool-result',{id:'other-room',tool:'compare',result:{secret:'other room'}});
  const value=f.store.queryResult('room',0,'own') as any;
  assert.equal(value.result.basisRevision,'old');assert.equal(value.arguments.targetTick,112);assert.equal(value.result.scenarios[0].forecast.exact,'saved forecast');
  for(const id of ['foreign','other-room'])assert.equal(f.store.queryResult('room',0,id),undefined);
  await assert.rejects(executeTool('recall',{id:'own'},c),/Tool not available/);
 }finally{f.store.close();}
});


test('strategy replacement rejects retired edits and remains atomic with reminder validation',async()=>{
 const f=fixture();f.state.memory.strategy='北线：守住。\n东线：待出兵。';f.state.memory.agreements='有效协议';let step=0;
 const c={...f,gateway:{snapshot:async()=>f.snapshot,request:async()=>{throw Error('No writes');}},id:'edit',spoken:0,now:60000};
 try{
  for(const memoryEdits of [[{field:'strategy',find:'不存在',replace:'误改'}],[{field:'strategy',find:'线',replace:'误改'}]])
   await assert.rejects(executeTool('finish',{memoryEdits},c),/Invalid tool fields/);
  await assert.rejects(executeTool('finish',{memory:{strategy:'覆盖'},memoryEdits:[{field:'strategy',find:'北线',replace:'南线'}]},c),/Invalid tool fields/);
  const memory={strategy:'北线：守住。\n东线：已接受出兵，等待实际抵达。'};
  await new SeatRunner(f.state,f.store,c.gateway,{step:async()=>++step===1?reply('finish',{memory,reminders:{set:[{id:'bad',atWorldDay:102,note:'bad',entities:['hidden']}]}}):reply('finish',{memory})}).poll(0,true);
  assert.equal(step,2);assert.equal(f.state.memory.strategy,'北线：守住。\n东线：已接受出兵，等待实际抵达。');
  assert.equal(f.state.memory.agreements,'有效协议');assert.equal(f.store.latest<any>('room',0,'memory-archived').memory.strategy,'北线：守住。\n东线：待出兵。');
  assert.deepEqual(f.store.reminders('room',0),[]);
 }finally{f.store.close();}
});
