import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {HybridBackground} from '../plugins/hybrid/src/background.js';
import {botStep} from '../packages/ai/src/controller/local/bot-step.js';
import {botPlanMemory} from '../packages/ai/src/controller/local/plan-memory.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import type {BotModeInput,BotModeServices,BotBackgroundServices} from '../packages/ai/src/controller/contracts/bot-mode.js';
import type {BotDecision} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {resolveBotSettings} from '../packages/contracts/src/index.js';

function fixture(){
 const state=initialState('model-free',0,{mode:'hybrid',provider:'offline',model:'',personality:'schemer'});state.enabled=true;
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;setup.match={mode:'mining',neptuniumGoal:200};
 const room={state:createFleetScenario(setup),scheduled:[]};
 const o=observation(room,0,state.roomId),snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const input={state,snapshot,feedback:[],history:[],routes:attackRoutes(o),efficiency:{},suffix:''} as unknown as BotModeInput;
 return {state,snapshot,input};
}
function services(){
 const records=new Map<string,Record<string,unknown>>();let assessed=0;
 const port:BotModeServices & Pick<BotBackgroundServices,'model'>={model:{step:async()=>assert.fail('Unconfigured hybrid must not invoke a model')},local:async(r,compute)=>compute(r),latest:<T>(key:string)=>records.get(key) as T|undefined,record:(key,value)=>{records.set(key,value);},markAssessed:()=>{assessed++;}};
 return {port,records,get assessed(){return assessed;}};
}

test('unconfigured hybrid retains the configured local review cadence',()=>{
 const {state}=fixture(),review=hybridMode.tacticalReviewAfterTicks;
 assert.equal(typeof review,'function');if(typeof review!=='function')return;
 assert.equal(review(state.settings)+1,6);
 state.settings.bot=resolveBotSettings({schemaVersion:2,reviewIntervalTicks:2});
 assert.equal(review(state.settings)+1,2);
 assert.equal(review({...state.settings,provider:'codex',model:'configured'})+1,2);
});
test('model-free hybrid retains the former local planner decision and simulation coverage',async()=>{
 const f=fixture(),local=services(),hybrid=services(),request={model:'',prompt:'',signal:new AbortController().signal};
 const before=await botStep(request,f.state,f.snapshot,f.input.routes,[],decision=>{local.port.record('decision',{decision});local.port.markAssessed();});
 const after=await hybridMode.prepare(f.input).run(request,hybrid.port);
 assert.deepEqual(after.reply,before.reply);
 const a=local.records.get('decision')!.decision as BotDecision,b=hybrid.records.get('decision')!.decision as BotDecision;
 assert.deepEqual(b.selected,a.selected);assert.equal(b.coverage.simulations,a.coverage.simulations);
 assert.equal((hybrid.records.get('local-plan')!.plan as {objective:string}).objective,a.selected.objective);
 assert.equal(hybrid.assessed,1);assert.equal(hybridMode.prepare(f.input).context.prompt,'');
});

test('private local memory takes precedence over model-authored notebook scouting claims',()=>{
 const f=fixture(),enemy=f.snapshot.observation.view.outposts.filter(p=>p.owner!==0);
 f.snapshot.notebook=[{id:'bot-plan',kind:'plan',priority:'high',text:JSON.stringify({format:'bot-plan/1',scoutedTargets:[enemy[0]!.id]}),updatedAt:0,expiresAt:null}];
 const trusted={format:'bot-plan/1',scoutedTargets:[enemy[1]!.id]};
 const memory=botPlanMemory(f.snapshot,()=>undefined,[],trusted);
 assert.equal(memory.scoutedTargets.has(enemy[0]!.id),false);assert.equal(memory.scoutedTargets.has(enemy[1]!.id),true);
});
test('unconfigured hybrid background neither queues nor invokes a model',async()=>{
 const f=fixture(),s=services();const background=new HybridBackground({state:f.state,model:s.port.model,latest:s.port.latest,record:s.port.record,wake:()=>assert.fail('No model background wake')});
 background.observe(f.snapshot);await background.drain();assert.equal(background.settling,false);assert.equal(s.records.size,0);
});
test('unconfigured hybrid durably ingests authorized chat before its cursor advances',async()=>{
 const f=fixture(),s=services();f.snapshot.chat=[{id:'offer',from:1,to:0,text:'可以协商边界吗？',tick:100,sentAt:0}];
 const background=new HybridBackground({state:f.state,model:s.port.model,latest:s.port.latest,record:s.port.record,wake:()=>assert.fail('No tactical wake for chat ingestion')});
 background.observe(f.snapshot);background.observe(f.snapshot);await background.drain();
 const saved=s.records.get('state') as unknown as {chat:unknown[];tasks:unknown[]};
 assert.deepEqual(saved.chat,f.snapshot.chat);assert.deepEqual(saved.tasks,[]);assert.equal(background.settling,false);
 f.snapshot.chat[0]!.text='source changed';assert.notEqual((saved.chat[0] as {text:string}).text,f.snapshot.chat[0]!.text);
});
test('model-free hybrid acknowledges unknown write feedback without searching or replaying it',async()=>{
 const f=fixture(),s=services();f.input.feedback=[{tool:'batch',summary:'unknown receipt',result:{status:'unknown'}}];
 const result=await hybridMode.prepare(f.input).run({model:'',prompt:'',signal:new AbortController().signal},s.port);
 assert.equal(result.reply.tool,'finish');assert.equal(s.assessed,0);assert.equal(hybridMode.needsAnalysis(f.input.feedback,{state:f.state,latest:s.port.latest}),false);
});
test('unparsed commander requirements are reported without an attempted model call or autonomous order',async()=>{
 const f=fixture(),s=services();f.state.commanderDirectives={version:1,text:'集中进攻红方矿场'};
 const result=await hybridMode.prepare(f.input).run({model:'',prompt:'',signal:new AbortController().signal},s.port);
 assert.equal(result.reply.tool,'finish');assert.match(result.reply.summary,/未配置模型/);assert.equal(s.assessed,0);
});

test('configured hybrid evaluates urgent defense before optional activity maintenance',async()=>{
 const f=fixture(),s=services();f.state.settings={...f.state.settings,provider:'inherited',model:'mock'};
 assert.ok(f.snapshot.observation.view.self.activity);
 f.snapshot.observation.view.self.activity.inactivityWarningCount=1;
 f.snapshot.task={category:'military',weight:'heavy',scope:'local',reasons:['urgent defense'],entities:[],deferred:[],triggers:[{key:'incoming',category:'military',urgent:true,reason:'incoming',entities:[]}]} as never;
 const result=await hybridMode.prepare(f.input).run({model:'mock',prompt:'',signal:new AbortController().signal},s.port);
 const args=result.reply.arguments as Record<string,unknown>;
 assert.ok(result.reply.tool!=='order'||!['check-in','cancel-inactivity-warning'].includes(String((args.action as {kind?:string})?.kind)));
 assert.equal(s.assessed,1);
});

test('activity warnings do not cause standalone check-ins in either hybrid mode',async()=>{
 for(const configured of [false,true]){
  const f=fixture(),s=services();
  if(configured)f.state.settings={...f.state.settings,provider:'inherited',model:'mock'};
  f.snapshot.observation.view.self.activity!.inactivityWarningCount=1;
  const result=await hybridMode.prepare(f.input).run({model:'mock',prompt:'',signal:new AbortController().signal},s.port);
  const args=result.reply.arguments as Record<string,unknown>;
  assert.ok(result.reply.tool!=='order'||!['check-in','cancel-inactivity-warning'].includes(String((args.action as {kind?:string})?.kind)));
  assert.equal(s.assessed,1);
  const reminders=args.reminders as {set?:{id:string}[]}|undefined;
  assert.ok(!reminders?.set?.some(r=>r.id==='bot-activity'));
 }
});

test('disabling the model cancels in-flight background work without scheduling a replacement',async()=>{
 const f=fixture(),s=services();f.state.settings={...f.state.settings,provider:'inherited',model:'mock'};
 let calls=0,aborted=false;
 s.port.model.step=request=>new Promise((_resolve,reject)=>{calls++;request.signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled'));},{once:true});});
 const background=new HybridBackground({state:f.state,model:s.port.model,latest:s.port.latest,record:s.port.record,wake:()=>{}});
 background.observe(f.snapshot);assert.equal(calls,1);
 f.state.settings.model='';background.observe(f.snapshot);await background.drain();
 assert.equal(aborted,true);background.observe(f.snapshot);assert.equal(calls,1);assert.equal(background.settling,false);
});
