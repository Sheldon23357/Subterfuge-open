import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {planBot,type BotPlannerOptions} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {closeBotForecastPool} from '../packages/ai/src/controller/analysis/tactical-forecast-pool.js';
import {validateTacticalProposal,TACTICAL_VALIDATION_MS} from '../plugins/hybrid/src/tactical-validation.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {AiStore,SeatRunner} from '../packages/ai/src/index.js';
import type {BotMode} from '../packages/ai/src/controller/contracts/bot-mode.js';
import {GameRequestError} from '../packages/ai/src/controller/transport/gateway.js';

after(()=>closeBotForecastPool());
function fixture(){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup,template=c.economy.outposts[0]!;
 c.size={width:80,height:80};c.match={mode:'domination',neptuniumGoal:200};
 const entries=[['home',0,0,0],['reserve',0,80,.1],['enemy',1,30,.8],['neutral',null,0,1.1]] as const;
 c.positions=Object.fromEntries(entries.map(([id,_owner,_drillers,x])=>[id,{x,y:0}]));
 c.economy.outposts=entries.map(([id,owner,drillers])=>({...template,id,owner,drillers,type:'generator',shield:0,shieldMax:0}));

 const game=createFleetScenario(c),original=observation({state:game,scheduled:[]},0,'multitick');
 const routes=attackRoutes(original,{attackTicks:144,localTicks:144,holdTicks:24});
 const candidate={id:'transfer',kind:'logistics' as const,commanderDirected:true as const,objective:'reinforce:home',targets:['home'],priority:0,reasons:[],drafts:[{id:'transfer-order',issueTick:original.view.tick,action:{kind:'launch',source:'reserve',destination:'home',drillers:40}}]};
 const proposal=planBot(original,routes,{preludeCandidates:[candidate],preludeOnly:true,preludeIndependent:true,maxElapsedMs:5000,maxSimulations:32});
 assert.equal(proposal.selected.id,candidate.id,JSON.stringify(proposal.assessments));
 const current=observation({state:advanceFleetScenario(game,game.economy.tick+3),scheduled:[]},0,'multitick');
 current.secondsSinceLastTick=300;
 const currentRoutes=attackRoutes(current,{attackTicks:144,localTicks:144,holdTicks:24});
 return {original,proposal,current,currentRoutes};
}

test('a proposal survives three ticks and is revalidated at current issue time without rediscovery',async()=>{
 const f=fixture(),saved=structuredClone(f.proposal);
 const result=await validateTacticalProposal(f.proposal,f.current,f.currentRoutes,{});
 assert.equal(result.selected.id,f.proposal.selected.id);
 assert.equal(result.basisRevision,f.current.revision);assert.equal(result.observedTick,f.current.view.tick);
 assert.equal(result.selected.drafts[0]!.issueTick,f.current.view.tick);
 assert.deepEqual(result.selected.drafts[0]!.action,f.proposal.selected.drafts[0]!.action);
 assert.ok(result.assessments.every(a=>['hold','transfer'].includes(a.candidate.id)));
 assert.equal(result.policyDiagnostics?.executionPhase,'independent');
 assert.deepEqual(f.proposal,saved,'search evidence must retain its original time and score');
});

test('validation receives a separate bounded budget and retains current strategic constraints',async()=>{
 const f=fixture(),guidance={forbiddenPlayers:[1],protectedSources:[],reserves:[],objectives:[],rotation:0};
 let received:BotPlannerOptions|undefined;
 await validateTacticalProposal(f.proposal,f.current,f.currentRoutes,{guidance},async(o,r,options)=>{
  received=options;return planBot(o,r,options);
 });
 assert.equal(received!.maxElapsedMs,TACTICAL_VALIDATION_MS);
 assert.equal(received!.maxSimulations,32);assert.deepEqual(received!.guidance,guidance);
 assert.equal(received!.internalTransfers,undefined);
});

test('source loss and troop shortage invalidate a delayed proposal without resizing or selecting another action',async()=>{
 for(const lost of [false,true]){
  const f=fixture(),source=f.current.view.outposts.find(p=>p.id==='reserve')!;
  if(lost)source.owner=1;else source.drillers=1;
  const checked=await validateTacticalProposal(f.proposal,f.current,attackRoutes(f.current,{attackTicks:144,localTicks:144,holdTicks:24}),{});
  assert.equal(checked.selected.id,'hold');
  assert.ok(checked.assessments.every(a=>['hold','transfer'].includes(a.candidate.id)));
 }
});

test('new reserves reject the old proposal and cancellation still aborts validation',async()=>{
 const f=fixture();
 const checked=await validateTacticalProposal(f.proposal,f.current,f.currentRoutes,{guidance:{forbiddenPlayers:[],protectedSources:[],reserves:[{source:'reserve',drillers:70}],objectives:[],rotation:0}});
 assert.equal(checked.selected.id,'hold');
 const controller=new AbortController();controller.abort(Error('paused'));
 await assert.rejects(async()=>validateTacticalProposal(f.proposal,f.current,f.currentRoutes,{signal:controller.signal}),/paused/);
});

test('a definitely rejected batch reuses the saved search and binds execution to the validated observation',async()=>{
 const f=fixture(),records=new Map<string,unknown>([['search',{sequence:1,decision:f.proposal}]]);
 const state=initialState('multitick',0,{mode:'hybrid',model:'mock',personality:'sentinel'});state.sequence=1;
 const snapshot:AiSnapshot={observation:f.current,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const input={state,snapshot,history:[],feedback:[{id:'rejected',tool:'batch',arguments:{},result:{results:[{status:'rejected',outcome:'rejected',code:'REVISION_CONFLICT'}]}}],efficiency:{cacheReports:true,cacheRoutes:true},suffix:'',routes:f.currentRoutes};
 const result=await hybridMode.prepare(input).run({model:'mock',prompt:'',signal:new AbortController().signal},{model:{step:async()=>{throw Error('Unexpected model call in local fixture');}},local:async(r,compute)=>compute(r),
  latest:<T>(kind:string)=>records.get(kind) as T|undefined,record:(kind,value)=>{records.set(kind,structuredClone(value));},
  refreshSnapshot:async()=>snapshot,markAssessed:()=>{},
 });
 assert.equal(result.reply.tool,'batch');
 assert.equal(result.executionObservation!.revision,f.current.revision);
 const search=records.get('search') as {decision:typeof f.proposal};
 assert.equal(search.decision.observedTick,f.original.view.tick,'conflict retry must not restart broad discovery');
 const validation=records.get('validation') as {decision:typeof f.proposal};
 assert.equal(validation.decision.observedTick,f.current.view.tick);
 assert.equal(validation.decision.selected.id,'transfer');
});

test('fresh facts reaching the controller cannot relabel a locally validated order',async()=>{
 const f=fixture(),store=new AiStore(':memory:'),state=initialState('multitick',0,{mode:'hybrid',model:'',personality:'sentinel'});
 const snapshot:AiSnapshot={observation:structuredClone(f.original),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const validated=structuredClone(snapshot.observation);let calls=0;const attempted:string[]=[];
 const mode:BotMode={...hybridMode,needsAnalysis:()=>false,prepare:input=>({
  ...hybridMode.prepare(input),run:async(request,services)=>{
   await request.beforeSend?.();
   if(calls++===0){
    snapshot.observation.revision='later-observation';
    await services.refreshSnapshot!();
    return {tokens:0,executionObservation:validated,reply:{tool:'order',arguments:{action:{kind:'check-in'}},summary:'local proposal'}};
   }
   return {tokens:0,reply:{tool:'finish',arguments:{},summary:'done'}};
  },
 })};
 const runner=new SeatRunner(state,store,{snapshot:async()=>structuredClone(snapshot),request:async(_path,body)=>{
  const revision=(body as {revision:string}).revision;attempted.push(revision);
  assert.equal(revision,validated.revision);
  throw new GameRequestError(409,snapshot.observation,'REVISION_CONFLICT');
 }},{step:async()=>{throw Error('No model');}},1000,{},()=>mode);
 try{await runner.poll(0,true);assert.deepEqual(attempted,[validated.revision]);assert.equal(state.status,'waiting');}
 finally{runner.pause();store.close();}
});

test('an invalid delayed proposal keeps existing actions without resetting the search review clock',async()=>{
 const f=fixture(),records=new Map<string,unknown>([['search',{sequence:1,decision:f.proposal}]]);
 f.current.view.outposts.find(p=>p.id==='reserve')!.drillers=1;
 const state=initialState('multitick',0,{mode:'hybrid',model:'mock',personality:'sentinel'});state.sequence=1;
 const snapshot:AiSnapshot={observation:f.current,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const result=await hybridMode.prepare({state,snapshot,history:[],feedback:[{id:'rejected',tool:'batch',arguments:{},result:{results:[{status:'rejected',outcome:'rejected',code:'REVISION_CONFLICT'}]}}],efficiency:{cacheReports:true,cacheRoutes:true},suffix:'',routes:undefined}).run({model:'mock',prompt:'',signal:new AbortController().signal},{model:{step:async()=>{throw Error('Unexpected model call in local fixture');}},local:async(r,compute)=>compute(r),
  latest:<T>(kind:string)=>records.get(kind) as T|undefined,record:(kind,value)=>{records.set(kind,structuredClone(value));},
  refreshSnapshot:async()=>snapshot,markAssessed:()=>{},
 });
 assert.equal(result.reply.tool,'finish');
 const args=result.reply.arguments as {reminders:{set:{atWorldDay:number}[]}};
 assert.deepEqual(args.reminders.set,[]);
 assert.equal(records.has('operations')&&(records.get('operations') as {operations:{status:string}[]}).operations.some(o=>o.status==='proposed'),false);
});

test('autonomous transfers do not inherit commander execution priority when their weighted gain is negative',()=>{
 const f=fixture(),candidate=structuredClone(f.proposal.selected);
 delete candidate.commanderDirected;
 const routes=attackRoutes(f.original,{attackTicks:144,localTicks:144,holdTicks:24});
 const decision=planBot(f.original,routes,{preludeCandidates:[candidate],preludeOnly:true,preludeIndependent:true,maxSimulations:32,maxElapsedMs:5000});
 assert.equal(decision.selected.id,'hold');
 const assessment=decision.assessments.find(a=>a.candidate.id===candidate.id)!;
 assert.equal(assessment.status,'evaluated');assert.ok(assessment.stress,'autonomous transfers must complete required pressure tests');
});
