import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {initialState,type AiSnapshot,type AgentRequest,type AgentResult} from '../packages/ai/src/controller/contracts/types.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import type {BotDecision} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {closeBotForecastPool} from '../packages/ai/src/controller/analysis/tactical-forecast-pool.js';

after(()=>closeBotForecastPool());
for(const incoming of [false,true])for(const model of ['mock','']){
 test(`hybrid actual ${model?'guided':'autonomous'} search has the same 4-second, 80-simulation, 196-tick budget ${incoming?'with incoming pressure':'in a quiet scene'}`,async()=>{
  const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  setup.match={mode:'mining',neptuniumGoal:200};
  let world=createFleetScenario(setup);
  if(incoming)world=submitFleetOrder(world,{id:'budget-incoming',player:1,action:{kind:'launch',source:'红方矿场',destination:'蓝方工厂',drillers:2}}).state;
  const o=observation({state:world,scheduled:[]},0,'search-budget');
  const state=initialState(o.roomId,0,{mode:'hybrid',model,personality:'schemer'});state.sequence=1;
  const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:o.view.playerCount};
  const records=new Map<string,Record<string,unknown>>();let assessed=false;
  await hybridMode.prepare({state,snapshot,history:[],feedback:[],efficiency:{cacheReports:true,cacheRoutes:true},suffix:'',routes:attackRoutes(o,{attackTicks:144,localTicks:144,holdTicks:24})}).run(
   {model,prompt:'',signal:new AbortController().signal},
   {model:{step:async()=>{throw Error('Unexpected model call in local fixture');}},local:async(request:AgentRequest,compute:(r:AgentRequest)=>Promise<AgentResult>)=>compute(request),latest:<T>(kind:string)=>records.get(kind) as T|undefined,record:(kind,data)=>{records.set(kind,structuredClone(data));},markAssessed:()=>{assessed=true;}},
  );
  const decision=(records.get('search')??records.get('decision'))?.decision as BotDecision|undefined;
  assert.ok(assessed&&decision,'budget must reach a completed real planner search');
  assert.equal(decision.parameters.maxElapsedMs,4000);
  assert.equal(decision.parameters.maxSimulations,80);
  assert.equal(decision.parameters.horizonTicks,196);
  assert.ok(decision.coverage.simulations<=80);
 });
}
