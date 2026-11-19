
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,readdirSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {AiStore,SeatRunner,initialState,PlayerGateway,type AiSnapshot,type AgentRequest} from '../packages/ai/src/index.js';
import {createSessionProvider} from '../packages/ai/src/application/agent-provider.js';
import {botStep} from '../packages/ai/src/controller/local/bot-step.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {ChatStore} from '../packages/server/src/chat.js';
import type {LabRoom} from '../packages/server/src/planning.js';
import {computeBot} from '../packages/ai/src/controller/local/bot-worker.js';
import {AgentDiagnostics} from '../packages/ai/src/controller/diagnostics/agent-diagnostics.js';
import {BotDecisionSummary,type BotDecisionSummaryData} from '../packages/client/src/BotDecisionSummary.js';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

function fixture(){
  const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  setup.match={mode:'mining',neptuniumGoal:200};
  return {state:createFleetScenario(setup),scheduled:[]};
}
test('unconfigured hybrid has no usable model transport and rejects credentials',async()=>{
  const configured=createSessionProvider({kind:'offline'},undefined,{OPENAI_API_KEY:'should-not-be-read'});
  assert.deepEqual(configured.summary,{kind:'offline',model:'',hasKey:false});
  assert.throws(()=>createSessionProvider({kind:'offline',apiKey:'secret'}));
  await assert.rejects(configured.current.step({model:'',prompt:'',signal:AbortSignal.abort()}),/未配置模型/);
});
test('actual runner executes through player API, completes the round, and makes zero provider calls',async t=>{
  let room:LabRoom=fixture();
  const h=protocolHarness(t,{room}),credentials=h.ownerCredentials,access=h.ownerAccess,store=new AiStore(':memory:');
  const directory=mkdtempSync(join(tmpdir(),'bot-runner-')),chat=new ChatStore(join(directory,'chat.json'));await chat.load();
  const api=await createOwnerPlayerApi(h,{chat:()=>chat});
  api.listen(0,'127.0.0.1');await once(api,'listening');
  let modelCalls=0;
  try{
    const gateway=new PlayerGateway(`http://127.0.0.1:${(api.address() as {port:number}).port}`,credentials.credentials[0]!.token,access.roomId,0,2);
    const state=initialState(access.roomId,0,{model:'',personality:'sentinel',provider:'offline'});
    const runner=new SeatRunner(state,store,gateway,{step:async()=>{modelCalls++;throw Error('Unexpected model call');}});
    await runner.poll(0);
    assert.equal(state.error,null,JSON.stringify(store.latest(access.roomId,0,'error')));
    assert.equal(modelCalls,0);assert.equal(state.calls,0);assert.equal(state.tokens,0);
    assert.ok(h.store.load()!.room.state.fleets.some(f=>f.owner===0&&f.drillers>0));
    assert.ok(store.latest(access.roomId,0,'mode-hybrid-decision'));
    assert.equal(store.latest(access.roomId,0,'call-reserved'),null);
    assert.ok(store.latest(access.roomId,0,'tactical-search-completed'));
    assert.equal(store.reminders(access.roomId,0).some(r=>r.id==='bot-review'),false);
    assert.ok(store.notebook(access.roomId,0,room.state.economy.tick*600).some(n=>n.id==='bot-plan'&&JSON.parse(n.text).format==='bot-plan/1'));
    assert.equal(state.status,'waiting');
    const computation=store.latest<{step:number}>(access.roomId,0,'bot-compute-completed');
    assert.equal(computation?.step,0,'action receipt is finalized without another local computation');
    assert.equal(store.latest<{workset:unknown}>(access.roomId,0,'round-workset')?.workset,null);
    assert.equal(store.latest<{tool:string}>(access.roomId,0,'tool-result')?.tool,'finish');
    const diagnostics=new AgentDiagnostics(store,state,v=>v,observation=>hybridMode.diagnostics!({observation,latest:<T>(name:string)=>store.latest<T>(state.roomId,state.lobbySeat,'mode-hybrid-'+name)??undefined}));
    const summary=(diagnostics.read('notebook',{}) as {botDecision:BotDecisionSummaryData}).botDecision;
    assert.ok(summary.operations>0);assert.ok(summary.coverage.simulations>0);
    assert.equal('drafts' in summary,false);
    assert.equal('botDecision' in (diagnostics.read('notebook',{scope:'history'}) as object),false);
    const other=new AgentDiagnostics(store,initialState(access.roomId,1,{model:'',personality:'sentinel'}),v=>v);
    assert.equal('botDecision' in (other.read('notebook',{}) as object),false);
    const html=renderToStaticMarkup(createElement(BotDecisionSummary,{value:{...summary,current:false},names:{'红方矿场':'目标矿场'}}));
    assert.match(html,/战术决策/);assert.match(html,/历史判断，局势已变化/);
    assert.match(html,/静态估算，不代表战果/);
  }finally{store.close();api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));for(const file of readdirSync(directory))unlinkSync(join(directory,file));rmdirSync(directory);}
});
test('simulation runs off the control event loop and cancellation stops the worker',async()=>{
  const o=observation(fixture(),0,'worker'),routes=attackRoutes(o),controller=new AbortController();
  let heartbeat=false;
  const computation=computeBot(o,routes,{signal:controller.signal});
  const rejection=assert.rejects(computation,/test-cancel/);
  await new Promise<void>(resolve=>setTimeout(()=>{heartbeat=true;controller.abort(Error('test-cancel'));resolve();},0));
  await rejection;assert.equal(heartbeat,true);
});
test('restored write feedback is finished without planning or resubmitting; admission still runs',async()=>{
  const room=fixture(),o=observation(room,0,'room');
  const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
  const state=initialState('room',0,{model:'',personality:'sentinel',provider:'offline'});
  let admitted=0,computed=0;
  const request:AgentRequest={model:'',prompt:'ignored',signal:new AbortController().signal,beforeSend:()=>{admitted++;}};
  const result=await botStep(request,state,snapshot,undefined,[{tool:'batch',id:'old-stable-id',summary:'原已接受操作',result:{status:'accepted'}}],()=>{computed++;});
  assert.equal(admitted,1);assert.equal(computed,0);assert.equal(result.reply.tool,'finish');assert.equal(result.tokens,0);
  state.commanderDirectives={version:1,text:'不要离开本据点'};
  await assert.rejects(botStep(request,state,snapshot,attackRoutes(o),[],()=>{}),/自由文本/);
});
