import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,type FleetSetup,type FleetOrder} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes,forecastKnownPath} from '../packages/prediction/src/index.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {initialHybridState,basisOf,type InternalTransferPhase,type OperationState} from '../plugins/hybrid/src/contracts.js';
import {initialState,type AgentRequest,type AgentResult,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import type {BotModeInput,BotModeServices} from '../packages/ai/src/controller/contracts/bot-mode.js';
import type {BotDecision} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {planBot,botWeightedActionAllowed} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {internalTransferPrelude} from '../packages/ai/src/controller/analysis/internal-transfers.js';
import {closeBotForecastPool} from '../packages/ai/src/controller/analysis/tactical-forecast-pool.js';

function fixture(twoDonors=false){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup,template=c.economy.outposts[0]!;
 c.size={width:80,height:80};c.match={mode:'domination',neptuniumGoal:200};

 const entries=[['home',0,0,0],['reserve',0,twoDonors?40:100,.1],['backup',0,twoDonors?40:0,.15],['enemy',1,90,.8],['rear',1,0,1.1]] as const;
 c.positions=Object.fromEntries(entries.map(([id,_owner,_drillers,x])=>[id,{x,y:0}]));
 c.economy.outposts=entries.map(([id,owner,drillers])=>({...template,id,owner,drillers,type:'generator',shield:['reserve','backup'].includes(id)?200:0,shieldMax:['reserve','backup'].includes(id)?200:0}));
 let game=submitFleetOrder(createFleetScenario(c),{id:'hostile',player:1,action:{kind:'launch',source:'enemy',destination:'home',drillers:60}}).state;
 const state=initialState('hybrid-internal',0,{mode:'hybrid',provider:'codex',model:'fake',personality:'sentinel'});state.sequence=1;
 const records=new Map<string,unknown>();let refreshes=0;
 const snapshot=():AiSnapshot=>({observation:observation({state:game,scheduled:[]},0,state.roomId),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2});
 const input=(feedback:unknown[]=[]):BotModeInput=>{const s=snapshot();return {state,snapshot:s,history:[],feedback,efficiency:{cacheReports:true,cacheRoutes:true},suffix:'',routes:attackRoutes(s.observation,{attackTicks:144,localTicks:144,holdTicks:24})};};
 const services:BotModeServices={model:{step:async()=>{throw Error('Unexpected model call in local fixture');}},local:async(request,compute)=>compute(request),
  latest:<T>(kind:string)=>records.get(kind) as T|undefined,record:(kind,data)=>{records.set(kind,structuredClone(data));},markAssessed:()=>{},refreshSnapshot:async()=>{refreshes++;return snapshot();}};
 const request:AgentRequest={prompt:'',model:'fake',signal:new AbortController().signal};
 const run=(feedback:unknown[]=[])=>hybridMode.prepare(input(feedback)).run(request,services);
 const decision=()=>(records.get('decision') as {decision:BotDecision}).decision;
 const receipt=(reply:AgentResult,statuses:string[]=[],execute=false,id='ai-0-1-0')=>{
  const args=typeof reply.reply.arguments==='string'?JSON.parse(reply.reply.arguments):reply.reply.arguments as Record<string,unknown>;
  const drafts=decision().selected.drafts;
  const results=drafts.map((d,index)=>{
   const status=statuses[index]??'accepted';let orderId=`internal-command-${index}`;
   if(execute&&status==='accepted'){
    const before=new Set(game.fleets.map(f=>f.id));
    game=submitFleetOrder(game,{id:orderId,player:0,action:d.action as FleetOrder['action']}).state;
    orderId=game.fleets.find(f=>!before.has(f.id)&&f.used)!.id;
   }
   return {index,id:id+'-'+index,status,...status==='accepted'?{protocolReceipt:{effects:{orderId}}}:{outcome:status==='unknown'?'unknown':'rejected',code:'REVISION_CONFLICT'}};
  });
  return {id,tool:'batch',arguments:args,result:{results}};
 };
 return {state,records,snapshot,input,run,decision,receipt,refreshes:()=>refreshes};
}

test('hybrid compares internal reinforcement with strategic choices using the shared weighted rule',async()=>{
 const f=fixture();
 try{
  const first=await f.run();assert.equal(first.reply.tool,'batch');
  const decision=f.decision(),candidate=decision.assessments.find(a=>a.candidate.id===decision.selected.id)!,baseline=decision.assessments.find(a=>a.candidate.id==='hold')!;
  assert.ok(candidate.score&&baseline.score);
  assert.ok(botWeightedActionAllowed(candidate.score,baseline.score,candidate.stress,baseline.stress,1));
  assert.deepEqual(decision.policyDiagnostics?.selection,{ordinary:0.6,pressure:0.4,minimumGain:1});
  const ack=f.receipt(first,[],true),prior=structuredClone(decision);
  assert.equal((await f.run([ack])).reply.tool,'finish');
  const before=f.refreshes();
  assert.equal((await f.run([ack])).reply.tool,'finish');assert.equal(f.refreshes(),before);
  assert.deepEqual(f.decision(),prior);
 }finally{closeBotForecastPool();}
});

for(const kind of ['rejected','unknown','partial','unrelated'] as const)test(`hybrid ${kind} weighted-action receipts never replay the selected batch`,async()=>{
 const f=fixture(true);
 try{
  const first=await f.run();assert.equal(first.reply.tool,'batch');assert.ok(f.decision().selected.drafts.length);
  assert.ok(f.decision().selected.drafts.length>=2);
  const ack=f.receipt(first,kind==='partial'?['accepted','rejected']:kind==='unrelated'?[]:[kind,kind]);
  if(kind==='unrelated')ack.arguments={actions:[]};
  const before=f.refreshes(),last=structuredClone(f.decision());
  if(kind==='rejected'){
   const retry=await f.run([ack]);assert.equal(retry.reply.tool,'batch');
   assert.equal((f.records.get('repair-attempt') as {sequence:number}).sequence,1);
   const rejected=f.receipt(retry,['rejected','rejected'],false,'ai-0-1-1');
   assert.equal((await f.run([ack,rejected])).reply.tool,'finish');
   const after=f.refreshes();assert.equal((await f.run([ack,rejected])).reply.tool,'finish');assert.equal(f.refreshes(),after);
   return;
  }
  assert.equal((await f.run([ack])).reply.tool,'finish');assert.equal(f.refreshes(),before);assert.deepEqual(f.decision(),last);
  assert.equal(f.records.has('repair-attempt'),false,'internal rejections do not receive the strategic revision-conflict retry');
  assert.equal((await f.run([ack])).reply.tool,'finish');assert.equal(f.refreshes(),before);
 }finally{closeBotForecastPool();}
});

test('internal candidate generation respects hybrid source protection and maximum combined reserves',()=>{
 const f=fixture(true),input=f.input(),o=input.snapshot.observation,routes=input.routes!;
 const guidance={forbiddenPlayers:[],protectedSources:['reserve'],reserves:[{source:'backup',drillers:10},{source:'backup',drillers:30}],objectives:[],rotation:0};
 const candidates=internalTransferPrelude(o,routes,144,undefined,guidance);
 assert.ok(candidates.length>0);
 for(const c of candidates)for(const d of c.drafts){assert.notEqual(d.action.source,'reserve');assert.equal(d.action.source,'backup');assert.ok(Number(d.action.drillers)<=10);}
 const decision=planBot(o,routes,{internalTransfers:true,preludeIndependent:true,guidance:{...guidance,protectedSources:['reserve','backup']},maxSimulations:8,maxElapsedMs:30000});
 assert.notEqual(decision.policyDiagnostics?.executionPhase,'independent');
});

test('autonomous internal candidates cannot bypass the shared gain threshold',()=>{
 const f=fixture(),input=f.input();
 const decision=planBot(input.snapshot.observation,input.routes!,{internalTransfers:true,preludeIndependent:true,
  settings:{schemaVersion:2,minActionGain:20},preludeOnly:true,maxSimulations:32,maxElapsedMs:30000});
 const chosen=decision.assessments.find(a=>a.candidate.id===decision.selected.id)!,base=decision.assessments.find(a=>a.candidate.id==='hold')!;
 if(decision.selected.id!=='hold')assert.ok(botWeightedActionAllowed(chosen.score!,base.score!,chosen.stress,base.stress,20));
 assert.ok(decision.assessments.some(a=>a.candidate.id.startsWith('internal-')),'the gain gate must examine a real internal candidate');
});

test('independent internal transfers require a completed delivery within the forecast horizon',()=>{
 const f=fixture(),i=f.input();
 const d=planBot(i.snapshot.observation,i.routes!,{internalTransfers:true,preludeIndependent:true,horizonTicks:1,maxSimulations:8,maxElapsedMs:30000});
 assert.notEqual(d.policyDiagnostics?.executionPhase,'independent');
 assert.ok(!d.selected.id.startsWith('internal-'));
});
