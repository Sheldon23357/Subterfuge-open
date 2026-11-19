import {test} from 'node:test';
import {resolveBotSettings} from '../packages/contracts/src/index.js';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {AiStore,SeatRunner,initialState,GameRequestError,GameTransportError,type AiSnapshot,type AgentRequest} from '../packages/ai/src/index.js';
import {botStep} from '../packages/ai/src/controller/local/bot-step.js';
import type {BotDecision} from '../packages/ai/src/controller/local/bot-planner.js';
import {generateBotCandidates} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
import {presentOutpostNames} from '../packages/ai/src/controller/presentation/outpost-references.js';

function setup():FleetSetup {
 const s=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 s.match={mode:'mining',neptuniumGoal:200};return s;
}
const snap=(o:AiSnapshot['observation']):AiSnapshot=>({observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:o.view.playerCount});
const request=():AgentRequest=>({model:'',prompt:'',signal:new AbortController().signal});

for(const outcome of ['accepted','rejected'] as const)test(`new threat after ${outcome} batch is retained until a fresh strategic decision`,async()=>{
 let room={state:createFleetScenario(setup()),scheduled:[]};
 const roomId=`lifecycle-${outcome}`,store=new AiStore(':memory:');
 const get=()=>snap(observation(room,0,roomId));
 const state=initialState(roomId,0,{model:'',personality:'sentinel',provider:'offline',bot:resolveBotSettings({maxSimulations:32,maxElapsedMs:10000})});
 let writes=0,routes=0,adapters=0,injected=false;
 const gateway={snapshot:async()=>structuredClone(get()),attackRoutes:async(o:AiSnapshot['observation'])=>{routes++;return attackRoutes(o);},request:async(path:string,body:unknown)=>{
  assert.equal(path,'/tool/order');writes++;
  const inject=()=>{room.state=submitFleetOrder(room.state,{id:'new-hostile',player:1,action:{kind:'launch',source:'红方矿场',destination:'蓝方工厂',drillers:11}}).state;injected=true;};
  if(outcome==='rejected'&&!injected){inject();throw new GameRequestError(409,get().observation,'REVISION_CONFLICT','Concurrent legal enemy launch');}
  room.state=submitFleetOrder(room.state,{...(body as {order:{id:string;action:unknown}}).order,player:0} as Parameters<typeof submitFleetOrder>[1]).state;
  if(!injected)inject();return get().observation;
 }};
 const provider:ConstructorParameters<typeof SeatRunner>[3]={step:async()=>{throw Error('No model transport');},computeLocal:async(r,compute)=>{adapters++;return compute(r);}};
 let runner=new SeatRunner(state,store,gateway,provider);
 try{
  await runner.poll(0,true,false,{oneRoundPerTick:true});
  assert.equal(state.error,null);assert.equal(state.sequence,1);assert.equal(adapters,1,'receipt-only finalization does not invoke the planner again');
  assert.equal(routes,1,'receipt-only finish must not prepare routes again');
  const wake=store.latest<{signals:{kind:string}[]}>(roomId,0,'wake-state')!;
  assert.ok(wake.signals.some(s=>s.kind==='threat-change'));
  assert.equal(runner.readyToAdvance(100),true,'a retained new cause must permit the completed tick to advance');
  const firstWrites=writes;
  if(outcome==='accepted')runner=new SeatRunner(state,store,gateway,provider); // The pending cause survives a restart.
  await runner.poll(5000,false,true,{eventCoalesceMs:1000,oneRoundPerTick:true});assert.equal(state.sequence,1,'same-tick changes do not reopen planning after restart');
  room.state=advanceFleetScenario(room.state,room.state.economy.tick+1);
  await runner.poll(6000,false,true,{eventCoalesceMs:1000,oneRoundPerTick:true});await runner.poll(7000,false,true,{eventCoalesceMs:1000,oneRoundPerTick:true});
  assert.equal(state.error,null);assert.equal(state.sequence,2);
  assert.equal(store.latest<{sequence:number}>(roomId,0,'mode-hybrid-decision')!.sequence,2,'fresh round must actually plan');
  assert.ok(writes>=firstWrites);assert.equal(store.latest<{signals:unknown[]}>(roomId,0,'wake-state')!.signals.length,0);
  await runner.poll(12000,false,true,{oneRoundPerTick:true});assert.equal(state.sequence,2,'own accepted effects must not create an endless review loop');
 }finally{store.close();}
});

test('ordinary rejected batch does not replay its failed child or untouched suffix',async()=>{
 const room={state:createFleetScenario(setup()),scheduled:[]},roomId='known-rejection',o=observation(room,0,roomId),store=new AiStore(':memory:');
 const state=initialState(roomId,0,{model:'',personality:'sentinel',provider:'offline',bot:resolveBotSettings({maxSimulations:32,maxElapsedMs:10000})});
 let writes=0,routes=0;
 const runner=new SeatRunner(state,store,{snapshot:async()=>snap(o),attackRoutes:async current=>{routes++;return attackRoutes(current);},request:async()=>{writes++;throw new GameRequestError(400,undefined,'NOT_ALLOWED','Known rejected action');}}, {step:async()=>{throw Error('No model');}});
 try{
  await runner.poll(0,true);assert.equal(state.error,null);assert.equal(writes,1);assert.equal(routes,1);
  const receipt=store.latest<{tool:string;result:{complete:boolean;results:{status:string}[]}}>(roomId,0,'batch-item-result');assert.ok(receipt);
  await runner.poll(6000,false,true);assert.equal(state.sequence,1);assert.equal(writes,1);assert.equal(runner.readyToAdvance(100),true);
 }finally{store.close();}
});

for(const status of ['accepted','rejected','not-executed','unknown','accepted-other-action'] as const)test(`scout history requires an accepted matching child, not ${status==='accepted'?'only a proposal':status}`,async()=>{
 const s=setup();s.economy.outposts[2]!.owner=0;s.economy.outposts[2]!.drillers=30;
 const o=observation({state:createFleetScenario(s),scheduled:[]},0,'scout-receipts'),target=o.view.outposts.find(p=>p.owner===1)!;
 target.visibility=0;delete target.drillers;delete target.shield;
 const scout=generateBotCandidates(o,attackRoutes(o)).find(c=>c.kind==='scout')!;assert.ok(scout);
 const state=initialState(o.roomId,0,{model:'',personality:'sentinel',provider:'offline'});state.sequence=7;
 const decision={selected:scout,situation:{phase:'expansion'},basisRevision:o.revision} as BotDecision;
 const actions=scout.drafts.map(d=>({tool:'order',arguments:{action:presentOutpostNames(d.action,o.outpostNames??{})}}));
 if(status==='accepted-other-action')(actions[0]!.arguments.action as Record<string,unknown>).drillers=2;
 const feedback=[{tool:'batch',arguments:{actions},result:{complete:status==='accepted',results:[{index:0,tool:'order',status:status==='accepted-other-action'?'accepted':status,commandReceipt:{status:'accepted'}}]}}];
 const result=await botStep(request(),state,snap(o),undefined,feedback,()=>assert.fail('receipt-only call must not plan'),{sequence:7,decision});
 const args=result.reply.arguments as {notebook:{set:{text:string}[]}};
 assert.equal(JSON.parse(args.notebook.set[0]!.text).scoutedTargets.includes(target.id),status==='accepted');
 if(status==='accepted'){
  const later=structuredClone(o);later.view.tick+=200;later.view.self.activity!.lastCheckinTime=later.view.tick*600;
  const next={...snap(later),notebook:[{id:'bot-plan',kind:'plan' as const,priority:'high' as const,text:args.notebook.set[0]!.text,updatedAt:0,expiresAt:null}]};
  const retained=await botStep(request(),state,next,undefined,[{tool:'order',result:{}}],()=>assert.fail('No replan'));
  assert.ok(JSON.parse((retained.reply.arguments as typeof args).notebook.set[0]!.text).scoutedTargets.includes(target.id),'accepted scout one-time semantics remain');
 }
});

test('urgent military review takes precedence over repeating failed housekeeping',async()=>{
 const o=observation({state:createFleetScenario(setup()),scheduled:[]},0,'urgent-maintenance');o.view.self.activity!.inactivityWarningCount=1;
 const lostSource=o.view.outposts.find(p=>p.owner===1)!;
 o.scheduled=[{id:'obsolete',player:0,issueTick:o.view.tick+2,status:'pending',action:{kind:'launch',source:lostSource.id,destination:o.view.outposts.find(p=>p.owner===0)!.id,drillers:1}}];
 const snapshot={...snap(o),notebook:[{id:'bot-plan',kind:'plan' as const,priority:'high' as const,text:JSON.stringify({format:'bot-plan/1',ownedSchedules:['obsolete']}),updatedAt:0,expiresAt:null}],task:{category:'military' as const,scope:'local' as const,weight:'medium' as const,reasons:['New threat'],entities:[],deferred:[],triggers:[{key:'threat',kind:'threat-change' as const,category:'military' as const,reason:'New threat',entities:[],urgent:true}]}};
 const state=initialState(o.roomId,0,{model:'',personality:'sentinel',provider:'offline',bot:resolveBotSettings({maxSimulations:2,maxElapsedMs:10000})});let planned=false;
 const result=await botStep(request(),state,snapshot,attackRoutes(o),[],()=>{planned=true;});
 assert.equal(planned,true);assert.notEqual(result.reply.tool,'order','do not repeat housekeeping before assessing the threat');
});


test('an unknown write still stops the round without finish or a fresh-identity retry',async()=>{
 const room={state:createFleetScenario(setup()),scheduled:[]},roomId='unknown-lifecycle',o=observation(room,0,roomId),store=new AiStore(':memory:');
 const state=initialState(roomId,0,{model:'',personality:'sentinel',provider:'offline',bot:resolveBotSettings({maxSimulations:32,maxElapsedMs:10000})});let writes=0;
 const runner=new SeatRunner(state,store,{snapshot:async()=>snap(o),attackRoutes:async current=>attackRoutes(current),request:async()=>{writes++;throw new GameTransportError();}},{step:async()=>{throw Error('No model');}});
 try{
  await runner.poll(0,true);assert.equal(writes,1);assert.equal(state.status,'error');assert.equal(runner.readyToAdvance(100),false);
  assert.equal(store.latest(roomId,0,'completed'),null);assert.ok(store.latest(roomId,0,'tool-unknown'));
 }finally{store.close();}
});
