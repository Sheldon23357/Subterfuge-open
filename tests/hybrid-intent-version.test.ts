import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {initialHybridState,basisOf,type IntentSpec,type OperationState} from '../plugins/hybrid/src/contracts.js';
import {applyIntentEdits,configurationCandidates,reconcileIntents} from '../plugins/hybrid/src/intents.js';
import {guardHybridExecution} from '../plugins/hybrid/src/execution-guard.js';
import {operationGuidance} from '../plugins/hybrid/src/operations.js';
import {foregroundInputKey} from '../plugins/hybrid/src/foreground-input.js';
import {tacticalGuidanceAllows} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {parseIntentResult,intentSchemaFor} from '../plugins/hybrid/src/intent-protocol.js';
import {normalizeIntentResult} from '../plugins/hybrid/src/intent-compatibility.js';

function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'intent-version');
 const state=initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'}),saved=initialHybridState();
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const own=o.view.outposts.find(p=>p.owner===0)!,enemy=o.view.outposts.find(p=>p.owner===1)!;
 const spec:Extract<IntentSpec,{kind:'capture'}>={kind:'capture',target:enemy.id,priority:65,until:o.view.tick+100,reason:'旧战略理由'};
 const edit=(task:IntentSpec,id:string|null='intent-1')=>applyIntentEdits(saved,{upsert:[{id,task}],cancel:[]},'model',0,o);
 edit(spec,null);
 const op:OperationState={id:'operation-'+state.sequence,objective:'capture:'+enemy.id,basis:basisOf(o),strategyVersion:0,status:'proposed',drafts:[],orders:[],fleets:[],issues:[],intentBindings:[{id:'intent-1',version:1}]};
 const action=(n:number,source=own.id,destination=enemy.id)=>({kind:'launch',source,destination,drillers:n});
 const input={state,snapshot,tool:'batch',arguments:{actions:[{tool:'order',arguments:{action:action(10)}}]},latest:<T>(key:string)=>(key==='state'?saved:key==='operations'?{operations:[op]}:undefined) as T|undefined};
 return {o,saved,spec,edit,op,input,action,own,enemy};
}

test('background reason rewrite preserves the proposed batch binding and frontend inputs',()=>{
 const f=fixture(),before=foregroundInputKey(f.saved,f.o);f.saved.intents![0]!.status='running';
 f.o.secondsSinceLastTick+=1;
 const when=foregroundInputKey(f.saved,f.o);
 f.edit({...f.spec,reason:'集中有限投入，等待真实交付'});
 const t=f.saved.intents![0]!;
 assert.equal(t.version,1);assert.equal(t.status,'running');assert.equal(t.spec.reason,'集中有限投入，等待真实交付');
 assert.equal(t.updatedAt,f.o.view.tick+f.o.secondsSinceLastTick/600);
 assert.equal(foregroundInputKey(f.saved,f.o),when);assert.equal(before,when);
 assert.doesNotThrow(()=>guardHybridExecution(f.input));
});

test('changes to target, shortened deadline, priority or driller limit still invalidate an old proposal',()=>{
 for(const change of [{target:'another-target'},{until:199},{priority:66},{maxDrillersPerPlan:9}]){
  const f=fixture(),before=foregroundInputKey(f.saved,f.o);f.edit({...f.spec,...change});
  assert.equal(f.saved.intents![0]!.version,2);assert.notEqual(foregroundInputKey(f.saved,f.o),before);
  assert.throws(()=>guardHybridExecution(f.input),/意图已结束、到期或改变/);
 }
});

test('wording updates do not revive terminal tasks or reset a blocked task',()=>{
 for(const status of ['completed','cancelled','expired','blocked'] as const){
  const f=fixture();f.saved.intents![0]!.status=status;f.saved.intents![0]!.reason='原始程序状态';
  f.edit({...f.spec,reason:'新说明'});
  assert.equal(f.saved.intents![0]!.status,status);assert.equal(f.saved.intents![0]!.reason,'原始程序状态');assert.equal(f.saved.intents![0]!.version,1);
  if(status!=='blocked')assert.throws(()=>guardHybridExecution(f.input),/停止提交/);
 }
});

test('wording changes cannot replay accepted or completed one-shot transports',()=>{
 for(const status of ['accepted','completed'] as const){
  const f=fixture();f.enemy.owner=0;f.saved.intents=[];
  const spec:IntentSpec={kind:'transfer',source:f.own.id,target:f.enemy.id,drillers:5,priority:65,until:f.spec.until,reason:'指定运输'};
  f.edit(spec,null);const t=f.saved.intents![0]!;f.op.intentBindings=[{id:t.id,version:t.version}];
  f.op.status=status;f.op.drafts=[{id:'transport',issueTick:f.o.view.tick,action:f.action(5)}];
  f.op.commands=[{draftId:'transport',requestId:'real',state:status==='completed'?'completed':'accepted',...(status==='completed'?{evidenceId:1,reason:'实际抵达结算确认交付'}:{})}];
  reconcileIntents(f.o,f.saved,[f.op]);const taskStatus=t.status;
  f.edit({...spec,reason:'换一种说明'},null);
  assert.equal(f.saved.intents!.length,1);assert.equal(f.saved.intents![0]!.version,1);assert.equal(f.saved.intents![0]!.status,taskStatus);
  assert.equal(configurationCandidates(f.o,attackRoutes(f.o),f.saved,[f.op]).length,0);
 }
});

test('same execution version still checks latest avoidance and source constraints',()=>{
 const f=fixture();f.edit({...f.spec,reason:'新说明'});
 f.edit({kind:'avoid',target:f.enemy.id,until:f.spec.until,reason:'真实禁攻'},null);
 assert.throws(()=>guardHybridExecution(f.input),/禁止此行动/);
});

test('capture driller limits cover all sources in a whole plan and actual batch admission',()=>{
 const f=fixture();f.edit({...f.spec,maxDrillersPerPlan:26});f.op.intentBindings![0]!.version=2;
 f.o.view.outposts.push({...f.own,id:'second-source'});f.o.outpostNames!['second-source']='第二来源';
 const guidance=operationGuidance(f.o,null,[],0,f.saved)!;
 const drafts=(a:number,b:number)=>[f.action(a),f.action(b,'second-source')].map((action,i)=>({id:String(i),issueTick:f.o.view.tick,action}));
 assert.equal(tacticalGuidanceAllows(f.o,drafts(13,13),guidance),true);
 assert.equal(tacticalGuidanceAllows(f.o,drafts(13,14),guidance),false);
 f.input.arguments.actions=drafts(13,14).map(d=>({tool:'order',arguments:{action:d.action}}));
 assert.throws(()=>guardHybridExecution(f.input),/目标投入上限/);
 f.input.arguments.actions=drafts(13,13).map(d=>({tool:'order',arguments:{action:d.action}}));
 assert.doesNotThrow(()=>guardHybridExecution(f.input));
 f.edit({...f.spec,reason:'没有再次填写上限'});
 assert.equal(f.saved.intents![0]!.version,2);assert.equal((f.saved.intents![0]!.spec as typeof f.spec).maxDrillersPerPlan,26);
 f.edit({...f.spec,maxDrillersPerPlan:null});assert.equal(f.saved.intents![0]!.version,3);
 assert.equal(operationGuidance(f.o,null,[],0,f.saved)!.targetDrillerLimits.length,0);
});

test('zero cap blocks new launches and expiration releases the constraint',()=>{
 const f=fixture();f.edit({...f.spec,maxDrillersPerPlan:0});
 const drafts=[{id:'launch',issueTick:f.o.view.tick,action:f.action(1)}];
 assert.equal(tacticalGuidanceAllows(f.o,drafts,operationGuidance(f.o,null,[],0,f.saved)!),false);
 f.o.view.tick=f.spec.until;
 assert.equal(tacticalGuidanceAllows(f.o,drafts,operationGuidance(f.o,null,[],0,f.saved)!),true);
});

test('model schema and parser accept numeric caps without inferring quantities from prose',()=>{
 const f=fixture(),raw={summary:'总投入不要超过26',tasks:{upsert:[{id:null,task:{...f.spec,maxDrillersPerPlan:26}}],cancel:[]},reviewOn:[]};
 const parse=(value:unknown)=>parseIntentResult(value,'strategy',2,new Set([f.enemy.id]));
 assert.equal((parse(raw).intentEdits!.upsert[0]!.task as typeof f.spec).maxDrillersPerPlan,26);
 for(const n of [-1,1.5,1000001,'26'])assert.throws(()=>parse({...raw,tasks:{...raw.tasks,upsert:[{id:null,task:{...f.spec,maxDrillersPerPlan:n}}]}}),/maxDrillersPerPlan/);
 const normalized=normalizeIntentResult({...raw,tasks:{...raw.tasks,upsert:[{id:null,task:{...f.spec,maxDrillersPerPlan:'26'}}]}},[],'strategy',f.o.view.tick);
 assert.equal((parse(normalized.value).intentEdits!.upsert[0]!.task as typeof f.spec).maxDrillersPerPlan,26);
 assert.equal((parse({...raw,tasks:{...raw.tasks,upsert:[{id:null,task:f.spec}]}}).intentEdits!.upsert[0]!.task as typeof f.spec).maxDrillersPerPlan,undefined);
 const schema=intentSchemaFor('strategy',[f.enemy.id]).properties.tasks.properties.upsert.items.properties.task.anyOf.find((s:any)=>s.properties.kind.enum[0]==='capture');
 assert.ok(schema.properties.maxDrillersPerPlan);assert.ok(!schema.required.includes('maxDrillersPerPlan'));
});
