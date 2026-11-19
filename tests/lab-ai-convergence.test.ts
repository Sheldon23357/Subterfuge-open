import {protocolHarness,createOwnerProtocolHost} from './player-protocol-test-helpers.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AiStore,GameTransportError,type AgentProvider} from '../packages/ai/src/index.js';
import {ProviderError} from '../packages/ai/src/controller/contracts/provider-error.js';
import {LabAi} from './helpers/scripted-lab.js';
import {validateLabAi} from '../packages/server/src/lab-ai.js';
import {SerialExecutor} from '../packages/server/src/player-access.js';
import {ChatStore} from '../packages/server/src/chat.js';
import {createFleetScenario,submitFleetOrder} from '../packages/engine/src/index.js';
import type {LabRoom} from '../packages/server/src/planning.js';
const finish=()=>({tokens:1,reply:{tool:'finish',arguments:{},summary:'完成'}});
const delay=()=>new Promise(resolve=>setTimeout(resolve,10));
async function fixture(t:import('node:test').TestContext,provider:AgentProvider,seats=[0,1]){
  const dir=mkdtempSync(join(tmpdir(),'subterfuge-convergence-')),store=new AiStore(join(dir,'ai.sqlite'));
  const chat=new ChatStore(join(dir,'chat.json'));await chat.load();
  let room:LabRoom={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[],playerRoomId:'convergence'};
  room.state=createFleetScenario({...room.state.initial,economy:{...room.state.initial.economy,initialTick:96}});
  const serial=new SerialExecutor();
  const h=protocolHarness(t,{room,roomId:room.playerRoomId!}),protocol=await createOwnerProtocolHost(h,{serial,chat:()=>chat});
  const ai=new LabAi({room:()=>room,protocol,chat:()=>chat},store,provider);
  await ai.start();ai.reset(validateLabAi(seats.map(seat=>({seat,settings:{model:'',personality:'schemer'}})),2));
  let wall=Date.now()+100000,lastCheck=0;
  // The synthetic scheduling clock advances faster than real time. Keep actual
  // HTTP polling inside the real protocol budget, so this convergence fixture
  // does not accidentally test 429 recovery instead of chat pagination.
  const check=async()=>{
    const wait=200-(Date.now()-lastCheck);if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
    lastCheck=Date.now();return serial.run(()=>ai.readyToStep('auto',wall+=1000));
  };
  const converge=async()=>{for(let i=0;i<300;i++){if(await check())return;await delay();}assert.fail('AI did not converge');};
  return {ai,chat,store,serial,room:()=>room,setRoom:(next:LabRoom)=>{h.store.commit(next,h.store.load()!.revision);room=next;},check,converge,close:async()=>{await ai.stop();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('same-tick diplomatic replies propagate across already idle seats until all replies execute',async t=>{
  const calls=[0,0],said=[false,false];
  const f=await fixture(t,{step:async request=>{
    const seat=JSON.parse(request.prompt).snapshot.observation.view.player;assert.ok(Number.isInteger(seat));calls[seat]=(calls[seat]??0)+1;
    if(request.prompt.includes('"diplomacy-message"')&&!said[seat]){
      said[seat]=true;
      return {tokens:1,reply:{tool:'say',arguments:{to:1-seat,text:seat===1?'收到，改成12小时停战':'同意，保持12小时停战'},summary:'回复具体条件'}};
    }
    return finish();
  }});
  try{
    await f.converge();assert.deepEqual(calls,[1,1]);
    const tick=f.room().state.economy.tick;
    await f.chat.sendFromSeat(0,{id:'proposal',to:1,text:'请核对边界提案'},2,tick);
    assert.equal(await f.check(),false,'same tick new chat invalidates the old idle check');
    await f.converge();
    assert.deepEqual(said,[true,true]);assert.deepEqual(calls,[3,4]);
    assert.equal(f.chat.cursorForSeat(0),3);assert.equal(f.room().state.economy.tick,tick);
    assert.equal(await f.check(),true,'no extra five second delay after convergence');
  }finally{await f.close();}
});

test('same-tick world commands and an observation still queued on the room executor block advance',async t=>{
  let calls=0;const f=await fixture(t,{step:async()=>{calls++;return finish();}},[0]);
  let release:()=>void=()=>{};
  try{
    await f.converge();assert.equal(calls,1);
    const room=f.room();
    f.setRoom({...room,state:submitFleetOrder(room.state,{id:'same-tick',player:0,action:{kind:'launch',source:room.state.economy.outposts[0]!.id,destination:room.state.economy.outposts[1]!.id,drillers:1}}).state});
    let entered!:()=>void;const entering=new Promise<void>(r=>entered=r);
    const blocker=f.serial.run(async()=>{entered();await new Promise<void>(r=>release=r);});await entering;
    assert.equal(f.ai.readyToStep('auto',Date.now()+200000),false);
    await delay();assert.equal(f.ai.readyToStep('auto',Date.now()+201000),false,'queued observation is not completed work');
    release();await blocker;await f.converge();
    assert.equal(f.room().state.economy.tick,96);assert.equal(f.room().state.commands.at(-1)?.id,'same-tick');
  }finally{release();await f.close();}
});

test('chat read marks and private conversations invisible to the active seat do not invalidate it',async t=>{
  const f=await fixture(t,{step:async()=>finish()},[0]);
  try{
    await f.converge();
    await f.chat.markSeenFromSeat(0,'public',0);assert.equal(await f.check(),true);
    // A third lobby identity is allowed in ChatStore, but its private message is not visible to seat zero.
    await f.chat.sendFromSeat(1,{id:'private',to:2,text:'私下讨论'},3,96);
    assert.equal(await f.check(),true);
  }finally{await f.close();}
});

test('unread pages of self messages cannot certify convergence or strand the chat cursor',async t=>{
  let calls=0;const f=await fixture(t,{step:async()=>{calls++;return finish();}},[0]);
  try{
    await f.converge();
    await f.chat.seed(Array.from({length:101},(_,i)=>({id:`own-${i}`,from:0,to:1,text:'历史发言',tick:96,sentAt:i})));
    assert.equal(await f.check(),false);await delay();
    await f.converge();assert.equal(calls,1);
    await f.chat.sendFromSeat(1,{id:'after-pages',to:0,text:'请回答新条件'},2,96);
    await f.converge();assert.equal(calls,2,JSON.stringify(f.store.decisionPage('convergence',0).entries.map(entry=>entry.payload)));
    assert.equal(f.store.load('convergence',0)?.chatCursor,102);
  }finally{await f.close();}
});

test('scheduled recovery retains unfinished work and prevents advance until successful execution',async t=>{
  let calls=0;const f=await fixture(t,{step:async()=>{if(++calls<=2)throw new GameTransportError({requestId:'read-failure',method:'GET',path:'/tool/observation',origin:'http://localhost',timeoutMs:1000,elapsedMs:1000,stage:'read-response',failure:'timeout',outcome:'read-only'});return finish();}},[0]);
  try{
    assert.equal(await f.check(),false);
    for(let i=0;i<200&&f.ai.status().seats[0]?.status!=='error';i++)await delay();
    assert.equal(f.ai.status().seats[0]?.recovering,true);
    assert.equal(await f.check(),false,'backoff is unfinished work, never an idle seat');
    await f.converge();assert.equal(calls,3);assert.equal(f.ai.status().seats[0]?.status,'waiting');
  }finally{await f.close();}
});

test('permanent AI failure stops automatic advancement with a visible reason; pausing excludes it',async t=>{
  const f=await fixture(t,{step:async()=>{throw new ProviderError('authentication');}},[0]);
  try{
    assert.equal(await f.check(),false);
    for(let i=0;i<200&&f.ai.status().seats[0]?.status!=='error';i++)await delay();
    await assert.rejects(f.check(),/第1席AI未完成.*登录/);
    f.ai.command({seat:0,action:'pause'});assert.equal(await f.check(),true);
  }finally{await f.close();}
});
