import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiStore,initialState} from '../packages/ai/src/index.js';
import {LobbyAi} from '../packages/server/src/ai-lobby.js';
import type {LobbyStore} from '../packages/server/src/lobby-store.js';
import {PlayerControl} from '../packages/server/src/player-control.js';

test('explicit external control durably pauses compacted legacy seat across service restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'control-legacy-')),path=join(dir,'ai.sqlite');
 let storage=new AiStore(path);let calls=0;
 const current={lobby:{access:{roomId:'lobby'},status:'started',seats:[1,0,0,1]},runtime:{status:'in-progress'},start:{prepared:{seatMapping:[{lobbySeat:0,gameSeat:0},{lobbySeat:3,gameSeat:1}],access:{roomId:'game'}}}};
 const lobby={load:()=>current} as unknown as LobbyStore;
 const state=initialState('lobby',3,{model:'',personality:'schemer'});storage.save(state,'configured');
 let ai=new LobbyAi(lobby,storage,{step:async()=>{calls++;throw Error('Unexpected model call');}});
 try{
  let writes=0;const save=storage.save.bind(storage);storage.save=(state,kind,details)=>{writes++;return save(state,kind,details);};
  assert.equal(ai.hostedActive("game",1),true);assert.equal(ai.hostedActive("game",0),false);assert.equal(ai.hostedActive("wrong-room",1),false);
  const control=new PlayerControl();ai.setControl(control);
  control.command('game',1,{action:'acquire',sessionId:'agent-session-000001'});ai.externalControl('game',1);
  assert.equal(storage.load('lobby',3)!.enabled,false);assert.equal(storage.load('lobby',3)!.status,'paused');assert.equal(ai.hostedActive('game',1),false);
  assert.equal(writes,1);ai.externalControl('game',1);ai.externalControl('game',1);ai.tick();assert.equal(writes,1);
  await ai.stop();storage.close();storage=new AiStore(path);
  ai=new LobbyAi(lobby,storage,{step:async()=>{calls++;throw Error('Unexpected model call');}});
  ai.setControl(new PlayerControl());ai.tick();
  assert.equal(storage.load('lobby',3)!.enabled,false);assert.equal(calls,0);
  const fresh=new PlayerControl();assert.throws(()=>fresh.assertWrite('game',1,{'x-subterfuge-controller':'agent','x-subterfuge-control-session':'agent-session-000001'}));
 }finally{await ai.stop();storage.close();rmSync(dir,{recursive:true,force:true});}
});

test('hosted control retains enabled error and recovery ownership until explicit pause',async()=>{
 const storage=new AiStore(':memory:');
 const current={lobby:{access:{roomId:'game'},status:'started',seats:[1,1]},start:{prepared:{access:{roomId:'game'},seatMapping:[{lobbySeat:0,gameSeat:0},{lobbySeat:1,gameSeat:1}]}}};
 const ai=new LobbyAi({load:()=>current} as unknown as LobbyStore,storage);
 const state=initialState('game',1,{model:'',personality:'schemer'});
 try{
  for(const status of ['waiting','thinking','paused','error','ended'] as const){
   state.status=status;state.enabled=true;storage.save(state);assert.equal(ai.hostedActive('game',1),status!=='ended');
   state.enabled=false;storage.save(state);assert.equal(ai.hostedActive('game',1),false);
  }
 }finally{await ai.stop();storage.close();}
});
