import {expandSchemaReferences} from './helpers/schema.js';
import {hybridBriefPrompt} from '../plugins/hybrid/src/prompts.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {initialHybridState,basisOf,type IntentSpec,type OperationState,type TacticalFeedback} from '../plugins/hybrid/src/contracts.js';
import {applyIntentEdits,reconcileIntents,intentGuidance,configurationCandidates,intentBindings} from '../plugins/hybrid/src/intents.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';
import {parseIntentResult} from '../plugins/hybrid/src/intent-protocol.js';
import {namedBrief,resolveIntentNames,mentionedOutposts} from '../plugins/hybrid/src/model-names.js';
import {constraints} from '../plugins/hybrid/src/operations.js';
import {diplomacyNeeds,updateDiplomacyPressure} from '../plugins/hybrid/src/diplomacy-pressure.js';
import {planBot} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {conversationEvidence} from '../plugins/hybrid/src/conversation-evidence.js';
import {commanderPlanIssue} from '../plugins/hybrid/src/commander-commitments.js';
import {publishHybridResult} from '../plugins/hybrid/src/publication.js';
import type {StrategicAssessment} from '../plugins/hybrid/src/contracts.js';
function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'intent-tests');
 const state=initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'}),saved=initialHybridState();
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 return {o,state,saved,snapshot,own:o.view.outposts.find(p=>p.owner===0)!,enemy:o.view.outposts.find(p=>p.owner===1)!};
}
const configure=(target:string):Extract<IntentSpec,{kind:'configure'}>=>({kind:'configure',target,minDrillers:120,maxDrillers:null,maintain:false,priority:70,until:200,reason:'战略集结'});
const wire=()=>({summary:'保留经济路线并退出高成本争夺',tasks:{upsert:[],cancel:[]},reviewOn:['对手获胜时钟恶化']});

test('current deadline is enforced atomically at publication without a tick-dependent generation schema',()=>{
 const f=fixture();f.o.secondsSinceLastTick=300;
 const now=f.o.view.tick+0.5;
 for(const until of [now-1,now]){
  const before=structuredClone(f.saved);
  assert.throws(()=>applyIntentEdits(f.saved,{upsert:[{id:null,task:{...configure(f.own.id),until}}],cancel:[]},'model',0,f.o),/must be in the future/);
  assert.deepEqual(f.saved,before);
 }
 applyIntentEdits(f.saved,{upsert:[{id:null,task:{...configure(f.own.id),until:now+1}}],cancel:[]},'model',0,f.o);
 assert.equal(f.saved.intents![0]!.spec.until,now+1);
});

test('commander adoption changes model task authority without replaying identical accepted work',()=>{
 for(const status of ['pending','running'] as const){
  const f=fixture();f.enemy.owner=0;f.o.outpostNames=Object.fromEntries(f.o.view.outposts.map(p=>[p.id,p.id]));
  const spec:IntentSpec={kind:'transfer',source:f.own.id,target:f.enemy.id,drillers:25,priority:95,until:200,reason:'指定运输'};
  applyIntentEdits(f.saved,{upsert:[{id:null,task:spec}],cancel:[]},'model',1,f.o);
  const task=f.saved.intents![0]!;task.status=status;
  f.saved.commanderVersion=1;f.saved.commanderText=`将${f.own.id}现有可调兵力集中撤往${f.enemy.id}集结。`;
  assert.match(commanderPlanIssue(f.saved,f.o)!,/指定运输未落实/);
  applyIntentEdits(f.saved,{upsert:[{id:task.id,task:spec}],cancel:[]},'commander',1,f.o);
  const adopted=f.saved.intents![0]!;
  assert.equal(adopted.authority,'commander');assert.equal(adopted.commanderVersion,1);
  assert.equal(adopted.version,task.version);assert.equal(adopted.status,status);assert.equal(commanderPlanIssue(f.saved,f.o),null);
  assert.throws(()=>applyIntentEdits(f.saved,{upsert:[{id:adopted.id,task:spec}],cancel:[]},'model',1,f.o),/commander task/);
 }
});
test('commander publication accepts an explicitly adopted model transport and still validates the resulting plan',()=>{
 const f=fixture();f.enemy.owner=0;f.o.outpostNames=Object.fromEntries(f.o.view.outposts.map(p=>[p.id,p.id]));
 const text=`将${f.own.id}现有可调兵力集中撤往${f.enemy.id}集结。`;
 f.state.commanderDirectives={version:1,text};f.saved.commanderVersion=1;f.saved.commanderText=text;
 const spec:IntentSpec={kind:'transfer',source:f.own.id,target:f.enemy.id,drillers:25,priority:95,until:200,reason:'指定运输'};
 applyIntentEdits(f.saved,{upsert:[{id:null,task:spec}],cancel:[]},'model',1,f.o);
 const id=f.saved.intents![0]!.id;
 const assessment:StrategicAssessment={summary:'执行指定运输',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],message:null,agreement:{status:'none',summary:'',forbidAttack:false,forbiddenTargets:[],internalIntent:'',expiresWorldDay:null},intentEdits:{upsert:[{id,task:{...spec,drillers:30}}],cancel:[]}};
 let persisted=false;
 publishHybridResult({saved:f.saved,snapshot:f.snapshot,port:{state:f.state,latest:()=>undefined,record:()=>{},wake:()=>{},model:{step:async()=>{throw Error('not called');}}},persist:()=>{persisted=true;},enqueue:()=>{}},{id:'commander-0',kind:'commander',scope:'commander',posts:[],messageIds:[],players:[],commanderPart:{index:0,count:1,text}},assessment,f.snapshot);
 assert.equal(persisted,true);assert.equal(f.saved.directive!.commanderVersion,1);assert.equal(commanderPlanIssue(f.saved,f.o),null);
 assert.equal(f.saved.intents![0]!.authority,'commander');assert.equal(f.saved.intents![0]!.version,2);
});

test('diplomacy reuses conversation notes while preserving every unread message and latest two-sided evidence',()=>{
 const messages=Array.from({length:12},(_,i)=>({id:'m'+i,from:i%2,to:i%2===0?1:0,text:'谈判'+i,tick:100+i,sentAt:0}));
 const ids=conversationEvidence(messages,messages.slice(0,10).map(m=>m.id),0);
 assert.deepEqual(ids,['m10','m11']);
 assert.deepEqual(conversationEvidence(messages,messages.slice(0,5).map(m=>m.id),0),messages.slice(5).map(m=>m.id));
 const onlyOwn=messages.filter(m=>m.from===0);assert.deepEqual(conversationEvidence(onlyOwn,onlyOwn.map(m=>m.id),0),['m10']);
});

test('three task skills load only their instructions and keep program-derived goals out of the model edit interface',()=>{
 const f=fixture(),strategy=hybridBriefPrompt('strategy',false,false,false,{}),diplomacy=hybridBriefPrompt('diplomacy',false,false,false,{}),commander=hybridBriefPrompt('commander',false,false,false,{});
 assert.match(strategy,/统筹胜利路径/);assert.ok(!strategy.includes('外交决策要果断'));
 assert.match(diplomacy,/评估当前会话/);assert.match(diplomacy,/假意接受/);assert.match(diplomacy,/两线夹击/);
 assert.match(commander,/只转译完整已确认/);assert.match(commander,/已确认指挥官要求/);assert.ok(!commander.includes('口吻示例'));
 assert.ok(!strategy.includes('外交有共同利益')); assert.ok(diplomacy.includes('外交有共同利益'));
 const task={id:'overview',kind:'strategy' as const,scope:'overview',posts:[],messageIds:[],players:[]};
 const material=makeBrief(task,f.state,f.snapshot,f.saved),b=material.brief as any;
 assert.ok(b.global.planning.candidates.rows.length>0);
 assert.ok(b.global.planning.estimates.forceSources.rows.length>0);
 assert.ok(!Object.hasOwn(material.responseSchema.properties,'objectives'));assert.ok(!Object.hasOwn(material.responseSchema.properties,'agreement'));
 assert.ok(!b.guidance.strategic?.objectives);assert.match(material.prompt,/不能当作执行指令/);
 assert.ok(b.global.planning.candidates.rows.every((c:any[])=>Object.values(f.o.outpostNames!).includes(c[0])));
});

test('model interface uses exact names in facts, task targets and schema',()=>{
 const f=fixture(),name=f.o.outpostNames![f.enemy.id];
 const task={id:'overview',kind:'strategy' as const,scope:'overview',posts:[],messageIds:[],players:[]};
 const material=makeBrief(task,f.state,f.snapshot,f.saved),brief=material.brief as any;
 assert.ok(brief.global.identities.some((r:any[])=>r[0]===name));
 assert.ok(brief.facts.outposts.some((p:any)=>p.name===name));assert.equal(brief.facts.requestableInformation,undefined);
 assert.ok(material.permissions.tasks.find(v=>v.kind==='capture')!.targets!.includes(name!));
 const raw={...wire(),tasks:{upsert:[{id:null,task:{kind:'capture',target:name,priority:70,until:200,reason:'争夺长期收益'}}],cancel:[]}};
 assert.equal((parseIntentResult(resolveIntentNames(raw,f.o),'strategy',2,new Set(f.o.view.outposts.map(p=>p.id))).intentEdits!.upsert[0]!.task as Extract<IntentSpec,{kind:'capture'}>).target,f.enemy.id);
 assert.throws(()=>resolveIntentNames({...raw,tasks:{...raw.tasks,upsert:[{id:null,task:{...raw.tasks.upsert[0]!.task,target:f.enemy.id}}]}},f.o));
 assert.throws(()=>parseIntentResult({...wire(),message:null},'strategy',2,new Set()),/fields/);
});

test('commander reserve validation rejects prose with a usable correction and resolves valid sources',()=>{
 const f=fixture(),name=f.o.outpostNames![f.own.id];
 for(const reserve of ['KING','保留必要防守',null,{source:name,drillers:'10'}])assert.throws(()=>resolveIntentNames({constraints:{reserves:[reserve]}},f.o),/constraints.reserves must contain/);
 assert.deepEqual(resolveIntentNames({constraints:{reserves:[{source:name,drillers:10}]}},f.o).constraints.reserves,[{source:f.own.id,drillers:10}]);
});

test('diplomatic names bring related authorized facts into the same brief without ID requests',()=>{
 const f=fixture(),name=f.o.outpostNames![f.enemy.id];
 f.saved.chat=[{id:'offer',from:1,to:0,text:`提议不攻击${name}。`,tick:100,sentAt:0}];
 const m=makeBrief({id:'chat',kind:'diplomacy',scope:'1',posts:[],messageIds:['offer'],players:[1]},f.state,f.snapshot,f.saved);
 const b=m.brief as any;
 assert.ok(b.facts.outposts.some((p:any)=>p.name===name));
 assert.equal(b.facts.requestableInformation,undefined);
 assert.equal(b.evidence.messages[0].text,`提议不攻击${name}。`);
 assert.ok(!m.prompt.includes(`（ID${f.enemy.id}）`));
 assert.ok(m.contextPosts.includes(f.enemy.id));
 assert.deepEqual(mentionedOutposts('XSUIJINY',f.o),[]);
});

test('large name catalogs retain strict transport schemas without repeating schema metadata in prompts',()=>{
 const f=fixture();
 for(let i=0;i<100;i++){const id='catalog-'+i;f.o.view.outposts.push({...f.enemy,id});f.o.outpostNames![id]='远海港湾'+i;}
 const m=makeBrief({id:'catalog',kind:'strategy',scope:'overview',posts:[],messageIds:[],players:[]},f.state,f.snapshot,f.saved);
 assert.ok(m.prompt.length<20000);assert.ok(!m.prompt.includes('"additionalProperties"'));
 assert.ok(m.permissions.tasks.find(v=>v.kind==='capture')!.targets!.includes('远海港湾99'));assert.ok(!JSON.stringify(m.responseSchema).includes('远海港湾99'));
 assert.equal(m.responseSchema.additionalProperties,false);
});

test('name projection covers reserves, mines, incoming fleet table and preserves task identities',()=>{
 const f=fixture(),n=f.o.outpostNames![f.own.id];
 const result=namedBrief({intentTasks:[{id:'intent-1',spec:configure(f.own.id)}],mines:[{id:f.own.id}],reserves:[{source:f.own.id,drillers:10}],fleets:{columns:['id','source','destinationKind','destinationId'],rows:[['fleet-1',f.own.id,'outpost',f.own.id]]}},f.o) as any;
 assert.equal(result.intentTasks[0].id,'intent-1');assert.equal(result.intentTasks[0].spec.target,n);
 assert.equal(result.mines[0].name,n);
 assert.equal(result.reserves[0].source,n);assert.deepEqual(result.fleets.rows[0],['fleet-1',n,'outpost',n]);
 const linked=namedBrief({target:{id:f.own.id,zone:'own-near'},entities:[f.own.id,'fleet-1'],economy:{columns:['id','drillers'],ownPosts:[[f.own.id,100]]}},f.o) as any;
 assert.equal(linked.target.name,n);assert.deepEqual(linked.entities,[n,'fleet-1']);assert.equal(linked.economy.columns[0],'name');
});

test('intent edits are atomic, deduplicate active targets and cannot change commander tasks',()=>{
 const f=fixture(),spec=configure(f.own.id);
 applyIntentEdits(f.saved,{upsert:[{id:null,task:spec}],cancel:[]},'commander',0,f.o);
 const before=structuredClone(f.saved);
 assert.throws(()=>applyIntentEdits(f.saved,{cancel:['intent-1'],upsert:[]},'model',0,f.o),/commander/);
 assert.deepEqual(f.saved,before);
 assert.throws(()=>applyIntentEdits(f.saved,{cancel:['intent-1'],upsert:[{id:null,task:configure(f.enemy.id)}]},'commander',0,f.o),/friendly/);
 assert.deepEqual(f.saved,before);
 applyIntentEdits(f.saved,{cancel:[],upsert:[{id:null,task:{...spec,reason:'同目标调整理由'}}]},'commander',0,f.o);
 assert.equal(f.saved.intents!.length,1);assert.equal(f.saved.intents![0]!.version,1);
});

test('one-shot configuration completes only on observed inventory and does not reactivate after drift',()=>{
 const f=fixture();applyIntentEdits(f.saved,{upsert:[{id:null,task:configure(f.own.id)}],cancel:[]},'model',0,f.o);
 const t=f.saved.intents![0]!;
 const op:OperationState={id:'op',objective:'configure:'+t.id,basis:basisOf(f.o),strategyVersion:0,status:'accepted',drafts:[],orders:['real-order'],fleets:[],issues:[],intentBindings:[{id:t.id,version:1}]};
 reconcileIntents(f.o,f.saved,[op]);assert.equal(t.status,'running');
 assert.ok(!configurationCandidates(f.o,attackRoutes(f.o),f.saved,[op]).length);
 f.own.drillers=120;reconcileIntents(f.o,f.saved,[op]);assert.equal(t.status,'completed');
 f.own.drillers=10;reconcileIntents(f.o,f.saved,[]);assert.equal(t.status,'completed');
 applyIntentEdits(f.saved,{upsert:[{id:null,task:configure(f.own.id)}],cancel:[]},'model',0,f.o);
 assert.equal(f.saved.intents!.length,1);assert.equal(t.status,'completed');
});

test('maintained reserves, expiring avoidance and capture completion derive from current facts',()=>{
 const f=fixture();applyIntentEdits(f.saved,{cancel:[],upsert:[{id:null,task:{...configure(f.own.id),maintain:true}},{id:null,task:{kind:'avoid',target:f.enemy.id,until:101,reason:'外交窗口'}},{id:null,task:{kind:'capture',target:f.enemy.id,priority:80,until:200,reason:'后续目标'}}]},'model',0,f.o);
 assert.equal(constraints(null,f.o,f.saved).reserves[0]!.drillers,120);
 assert.ok(intentGuidance(f.o,f.saved).forbiddenTargets.includes(f.enemy.id));
 f.o.view.tick=101;reconcileIntents(f.o,f.saved,[]);assert.equal(f.saved.intents![1]!.status,'expired');
 f.enemy.owner=0;reconcileIntents(f.o,f.saved,[]);assert.equal(f.saved.intents![2]!.status,'completed');
});

test('configuration candidates spend only safe donors and retain operation bindings',()=>{
 const f=fixture();f.enemy.owner=0;f.enemy.drillers=0;
 applyIntentEdits(f.saved,{cancel:[],upsert:[{id:null,task:{...configure(f.enemy.id),minDrillers:5}}]},'model',0,f.o);
 reconcileIntents(f.o,f.saved,[]);
 const candidates=configurationCandidates(f.o,attackRoutes(f.o),f.saved,[]);
 assert.ok(candidates.length);assert.ok(candidates[0]!.drafts.every(d=>Number(d.action.drillers)<=f.own.drillers!));
 assert.deepEqual(intentBindings(f.saved,candidates[0]!),[{id:'intent-1',version:1}]);
});

test('cancelled, superseded or expired intent operations cannot pass actual write admission',()=>{
 const f=fixture();applyIntentEdits(f.saved,{cancel:[],upsert:[{id:null,task:{kind:'capture',target:f.enemy.id,priority:70,until:200,reason:'战略目标'}}]},'model',0,f.o);
 const t=f.saved.intents![0]!,op:OperationState={id:'operation-'+f.state.sequence,objective:'capture:'+f.enemy.id,basis:basisOf(f.o),strategyVersion:0,status:'proposed',drafts:[],orders:[],fleets:[],issues:[],intentBindings:[{id:t.id,version:1}]};
 const input={state:f.state,snapshot:f.snapshot,tool:'order',arguments:{action:{kind:'launch',source:f.own.id,destination:f.enemy.id,drillers:1,}},latest:<T>(key:string)=>(key==='state'?f.saved:key==='operations'?{operations:[op]}:undefined) as T|undefined};
 assert.doesNotThrow(()=>hybridMode.beforeExecute!(input));
 t.status='cancelled';assert.throws(()=>hybridMode.beforeExecute!(input),/停止提交/);
 t.status='pending';t.version=2;assert.throws(()=>hybridMode.beforeExecute!(input),/停止提交/);
 t.version=1;f.o.view.tick=200;assert.throws(()=>hybridMode.beforeExecute!(input),/停止提交/);
});

test('stalemate requires assessed alternatives, three distinct ticks and resets after a valuable action',()=>{
 const f=fixture(),d=planBot(f.o,attackRoutes(f.o),{maxSimulations:4,maxElapsedMs:1000});
 const hold=d.assessments.find(a=>a.candidate.kind==='hold')!;d.selected=hold.candidate;
 d.assessments=[hold,{...hold,candidate:{...hold.candidate,id:'attempt',kind:'attack',objective:'capture-attempt'},status:'evaluated'}];
 const needs=diplomacyNeeds(f.o,d,f.saved,[]).filter(n=>n.kind==='stalemate');assert.equal(needs.length,1);
 const feedback=():TacticalFeedback=>({basis:basisOf(f.o),strategyVersion:0,coverage:d.coverage,objects:[],proposals:[],selected:'hold',limitations:[],diplomacyNeeds:needs});
 assert.equal(updateDiplomacyPressure(f.saved,feedback(),f.o,0).length,0);
 assert.equal(updateDiplomacyPressure(f.saved,feedback(),f.o,0).length,0);
 f.o.view.tick++;assert.equal(updateDiplomacyPressure(f.saved,feedback(),f.o,0).length,0);
 f.o.view.tick++;assert.equal(updateDiplomacyPressure(f.saved,feedback(),f.o,0).length,1);
 updateDiplomacyPressure(f.saved,{...feedback(),selected:'capture',diplomacyNeeds:[]},f.o,0);assert.equal(f.saved.diplomacyPressure!.streaks.stalemate,undefined);
 d.assessments=[hold];assert.ok(!diplomacyNeeds(f.o,d,f.saved,[]).some(n=>n.kind==='stalemate'));
});


test('active task strategic reasons remain in stored notes without a query channel',()=>{
 const f=fixture();applyIntentEdits(f.saved,{upsert:[{id:null,task:{kind:'avoid',target:f.enemy.id,until:f.o.view.tick+100,reason:'保留边界以换取领先者方向的夹击'}}],cancel:[]},'model',0,f.o);
 const m=makeBrief({id:'overview',kind:'strategy',scope:'overview',posts:[],messageIds:[],players:[]},f.state,f.snapshot,f.saved);
 assert.equal(f.saved.intents![0]!.spec.reason,'保留边界以换取领先者方向的夹击');
 assert.equal((m.responseSchema as any).properties.needsInformation,undefined);
});


test('explicit adoption links an unchanged strategy task and subsequent same-goal edits preserve the commitment',()=>{
 const f=fixture(),spec={kind:'capture' as const,target:f.enemy.id,priority:70,until:200,reason:'战略目标'};
 applyIntentEdits(f.saved,{upsert:[{id:null,task:spec}],cancel:[]},'model',0,f.o);
 const id=f.saved.intents![0]!.id;
 applyIntentEdits(f.saved,{upsert:[{id,task:spec}],cancel:[]},'model',0,f.o,{kind:'diplomacy',conversation:'1'});
 assert.equal(f.saved.intents![0]!.origin?.conversation,'1');
 applyIntentEdits(f.saved,{upsert:[{id,task:{...spec,priority:80}}],cancel:[]},'model',0,f.o);
 assert.equal(f.saved.intents![0]!.origin?.conversation,'1');
});
