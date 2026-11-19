import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AiStore,initialState} from '../packages/ai/src/index.js';

test('protocol timing appends audit evidence without reading or overwriting decision state',t=>{
 const store=new AiStore(':memory:');try{
  const state=initialState('timing-audit',0,{model:'',personality:'schemer'});
  state.enabled=true;store.save(state,'started');
  const paused={...state,enabled:false,status:'paused' as const,calls:17};store.save(paused,'paused');
  t.mock.method(store,'localDecisionView',()=>{throw Error('A timing must not read decision material');});
  t.mock.method(store,'localWriteBasis',()=>{throw Error('A timing must not compete with decision writes');});
  const timing={path:'/player/v2/sync',durationMs:25,startedAt:1000,status:200,sequence:1};
  store.recordTiming(state.roomId,state.lobbySeat,'protocol-request-timing',timing);
  assert.equal(store.latest(state.roomId,state.lobbySeat,'protocol-request-timing'),null);
  store.flushTimings();
  assert.deepEqual(store.load(state.roomId,state.lobbySeat),paused);
  assert.deepEqual(store.latest(state.roomId,state.lobbySeat,'protocol-request-timing'),timing);
  assert.equal(store.latest('another-room',0,'protocol-request-timing'),null);
 }finally{store.close();}
});

test('performance samples share one delayed transaction and close flushes remaining samples',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const store=new AiStore(':memory:');
 try{
  const db=(store as unknown as {db:import('node:sqlite').DatabaseSync}).db,exec=db.exec.bind(db);let commits=0;
  t.mock.method(db,'exec',(sql:string)=>{if(sql==='COMMIT')commits++;return exec(sql);});
  for(let i=0;i<100;i++)store.recordTiming('room',0,'protocol-request-timing',{i});
  store.recordTiming('room',0,'runtime-poll-timing',{snapshotMs:15});
  assert.equal(commits,0);t.mock.timers.tick(500);assert.equal(commits,1);
  assert.deepEqual(store.latest('room',0,'protocol-request-timing'),{i:99});
  assert.deepEqual(store.latest('room',0,'runtime-poll-timing'),{snapshotMs:15});
  store.recordTiming('room',0,'runtime-readiness-timing',{durationMs:20});
  store.close();assert.equal(commits,2);
 }catch(error){store.close();throw error;}
});
