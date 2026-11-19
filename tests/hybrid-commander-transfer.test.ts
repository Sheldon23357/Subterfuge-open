import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup,type FleetOrder} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes,forecastKnownPath} from '../packages/prediction/src/index.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {initialHybridState,basisOf,type IntentSpec,type OperationState} from '../plugins/hybrid/src/contracts.js';
import {applyIntentEdits,reconcileIntents,configurationCandidates,intentBindings} from '../plugins/hybrid/src/intents.js';
import {commanderProtectedFleets,commanderPlanIssue,validateCommanderEdits,validateCommanderTransferSources} from '../plugins/hybrid/src/commander-commitments.js';
import {operationGuidance,reconcileOperations} from '../plugins/hybrid/src/operations.js';
import {planBot,tacticalGuidanceAllows} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {parseIntentResult,intentSchemaFor} from '../plugins/hybrid/src/intent-protocol.js';
import {resolveIntentNames,namedBrief} from '../plugins/hybrid/src/model-names.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {compactHybrid} from '../plugins/hybrid/src/compact.js';

function fixture(){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 c.size={width:80,height:80};c.economy.outposts[0]!.drillers=92;c.economy.outposts[1]!.drillers=0;
 c.economy.outposts[2]!.owner=0;c.positions['红方后方']={x:.1,y:0};
 c.economy.outposts.push({...c.economy.outposts[0]!,id:'rally',drillers:15});c.positions.rally={x:3,y:3};

 let game=createFleetScenario(c);
 const observe=()=>observation({state:game,scheduled:[]},0,'commander-transfer');
 const o=observe(),saved=initialHybridState(),state=initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'});state.sequence=1;
 const source='蓝方工厂',target='rally',enemy='红方矿场',near='红方后方';
 const transfer:IntentSpec={kind:'transfer',source,target,drillers:20,priority:95,until:500,reason:'指定来源向集结点交付'};
 const add=(spec:IntentSpec)=>applyIntentEdits(saved,{upsert:[{id:null,task:spec}],cancel:[]},'commander',0,o);
 const execute=(action:FleetOrder['action'],id='trip')=>{game=submitFleetOrder(game,{id,player:0,action}).state;};
 const advance=(tick:number)=>{game=advanceFleetScenario(game,tick);};
 return {o,saved,state,source,target,enemy,near,transfer,add,observe,execute,advance};
}
function launched(f:ReturnType<typeof fixture>){
 f.add(f.transfer);const c=configurationCandidates(f.o,attackRoutes(f.o),f.saved,[])[0]!;assert.ok(c);
 f.execute(c.drafts[0]!.action as FleetOrder['action']);
 const op:OperationState={id:'transport',basis:basisOf(f.o),strategyVersion:0,status:'accepted',objective:c.objective,phase:'internal',drafts:c.drafts,intentBindings:intentBindings(f.saved,c),orders:['trip'],fleets:['trip'],issues:[],commands:[{draftId:c.drafts[0]!.id,requestId:'receipt',fleetId:'trip',orderId:'trip',state:'accepted'}]};
 return {c,op};
}

test('separate commander parts cannot combine source protection with a new transfer from that source',()=>{
 const f=fixture(),parts=[{upsert:[],cancel:[],protectedSources:[f.source]},{upsert:[{id:null,task:f.transfer}],cancel:[],protectedSources:[]}];
 const edits={upsert:parts.flatMap(p=>p.upsert),cancel:[]};
 assert.throws(()=>validateCommanderTransferSources(edits,parts.flatMap(p=>p.protectedSources)),/conflicts with protectedSources/);
 assert.doesNotThrow(()=>validateCommanderTransferSources(edits,[f.near]));
});
test('directed transfer resolves all names, validates exact routes and rejects malformed parameters',()=>{
 const f=fixture(),schema=intentSchemaFor('commander',Object.values(f.o.outpostNames!));
 assert.ok(schema.properties.tasks.properties.upsert.items.properties.task.anyOf.some((s:any)=>s.properties.kind.enum[0]==='transfer'));
 const wire=(spec:IntentSpec)=>({summary:'集结',tasks:{upsert:[{id:null,task:spec}],cancel:[]},reviewOn:[],constraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]}});
 const named=namedBrief(f.transfer,f.o),resolved=resolveIntentNames(wire(named),f.o);
 assert.deepEqual(parseIntentResult(resolved,'commander',2,new Set(f.o.view.outposts.map(p=>p.id))).intentEdits!.upsert[0]!.task,f.transfer);
 assert.throws(()=>parseIntentResult(wire({...f.transfer,drillers:0} as IntentSpec),'commander',2,new Set(f.o.view.outposts.map(p=>p.id))),/drillers/);
 assert.throws(()=>applyIntentEdits(f.saved,{upsert:[{id:null,task:{...f.transfer,target:f.enemy}}],cancel:[]},'commander',0,f.o),/friendly/);
});
test('transfer uses specified destination despite a nearer friendly receiver and cannot fall back',()=>{
 const f=fixture();f.add(f.transfer);
 const routes=attackRoutes(f.o),candidates=configurationCandidates(f.o,routes,f.saved,[]);
 assert.equal(candidates.length,1);assert.equal(candidates[0]!.drafts[0]!.action.destination,f.target);
 const d=planBot(f.o,routes,{preludeCandidates:candidates,preludeIndependent:true,preludeOnly:true,horizonTicks:144,maxSimulations:12,maxElapsedMs:10000,guidance:operationGuidance(f.o,null,[],0,f.saved)!});
 assert.equal(d.selected.objective,'transfer:intent-1',JSON.stringify(d.assessments.map(a=>({id:a.candidate.id,status:a.status,reasons:a.reasons}))));assert.equal(d.selected.drafts[0]!.action.destination,f.target);
 f.o.view.outposts.find(p=>p.id===f.target)!.owner=1;
 assert.deepEqual(configurationCandidates(f.o,routes,f.saved,[]),[]);assert.equal(f.saved.intents![0]!.status,'blocked');
});
test('remote unresolved arrival does not block a proved friendly commander delivery',()=>{
 const f=fixture();f.add({...f.transfer,drillers:1});
 f.o.view.outposts.find(p=>p.id===f.enemy)!.visibility=0;
 f.o.view.fleets.push({id:'remote-fogbound',owner:1,position:{...f.o.view.outposts.find(p=>p.id===f.enemy)!.position},
  drillers:1,state:'moving',gift:false,destination:{kind:'outpost',id:f.enemy}});
 const routes=attackRoutes(f.o),candidates=configurationCandidates(f.o,routes,f.saved,[]);
 assert.equal(candidates.length,1);
 const checked=forecastKnownPath(f.o,{targetTick:f.o.view.tick+144,drafts:candidates[0]!.drafts,predicates:[
  {id:'source',kind:'controlsThroughout',outpostId:f.source},{id:'target',kind:'controlsThroughout',outpostId:f.target}]});
 assert.ok(checked.path!.coverage.unknownReasons.includes('arrival-outcome-unknown'));
 assert.deepEqual(checked.path!.predicates.map(p=>p.truth),['true','true']);
 assert.ok(checked.path!.events.some(e=>e.kind==='unloaded'&&e.details.outpost===f.target));
 const options={preludeCandidates:candidates,preludeIndependent:true,preludeOnly:true,horizonTicks:144,maxSimulations:12,maxElapsedMs:10000,guidance:operationGuidance(f.o,null,[],0,f.saved)!};
 assert.equal(planBot(f.o,routes,options).selected.objective,'transfer:intent-1');
 // An unresolved moving actor can still intersect the route: retain the gate.
 f.o.view.fleets.push({id:'unknown-course',owner:1,position:{...f.o.view.outposts.find(p=>p.id===f.source)!.position},drillers:100,state:'moving',gift:false,destination:null});
 assert.equal(planBot(f.o,attackRoutes(f.o),options).selected.id,'hold');
});
test('fixed force waits for sufficient safe inventory; null sends current safe force once',()=>{
 const f=fixture();f.add({...f.transfer,drillers:1000} as IntentSpec);
 assert.equal(configurationCandidates(f.o,attackRoutes(f.o),f.saved,[]).length,0);
 applyIntentEdits(f.saved,{upsert:[{id:'intent-1',task:{...f.transfer,drillers:null} as IntentSpec}],cancel:[]},'commander',0,f.o);
 const c=configurationCandidates(f.o,attackRoutes(f.o),f.saved,[])[0]!;
 assert.ok(Number(c.drafts[0]!.action.drillers)>0&&Number(c.drafts[0]!.action.drillers)<=92);
 const op:OperationState={id:'pending',objective:c.objective,basis:basisOf(f.o),strategyVersion:0,status:'review',drafts:c.drafts,orders:[],fleets:[],issues:['未知回执'],intentBindings:intentBindings(f.saved,c)};
 assert.equal(configurationCandidates(f.o,attackRoutes(f.o),f.saved,[op]).length,0);
});
test('departure and disappearance cannot complete transfer; actual engine delivery does',()=>{
 const f=fixture(),{op}=launched(f);f.advance(102);
 const moving=f.observe();let ops=reconcileOperations([op],moving);reconcileIntents(moving,f.saved,ops);
 assert.equal(f.saved.intents![0]!.status,'running');
 const missing=structuredClone(moving);missing.view.fleets=[];missing.activity=[];
 reconcileIntents(missing,f.saved,reconcileOperations(ops,missing));assert.notEqual(f.saved.intents![0]!.status,'completed');
 f.advance(200);const arrived=f.observe();ops=reconcileOperations(ops,arrived);reconcileIntents(arrived,f.saved,ops);
 assert.equal(f.saved.intents![0]!.status,'completed');
});
test('return interrupts transfer and cannot be counted as delivery or trigger automatic replacement',()=>{
 const f=fixture(),{op}=launched(f);f.advance(102);f.execute({kind:'return-fleet',fleetId:'trip'},'recall');f.advance(110);
 const o=f.observe(),ops=reconcileOperations([op],o);reconcileIntents(o,f.saved,ops);
 assert.equal(f.saved.intents![0]!.status,'blocked');assert.equal(configurationCandidates(o,attackRoutes(o),f.saved,ops).length,0);
});
test('commander transport protection survives new rounds, blocks planning and final write admission',()=>{
 const f=fixture(),{op}=launched(f);f.advance(103);const o=f.observe();f.state.sequence=2;
 const saved=structuredClone(f.saved),operations=reconcileOperations([op],o);reconcileIntents(o,saved,operations);
 assert.deepEqual(commanderProtectedFleets(o,saved,operations),['trip']);
 const recall={id:'recall',kind:'logistics' as const,objective:'return:trip',targets:[],drafts:[{id:'recall',issueTick:o.view.tick,action:{kind:'return-fleet',fleetId:'trip'}}],priority:100,reasons:[]};
 const d=planBot(o,attackRoutes(o),{validationCandidate:recall,protectedFleetIds:commanderProtectedFleets(o,saved,operations),maxSimulations:12,maxElapsedMs:10000});
 assert.equal(d.selected.id,'hold');assert.equal(d.assessments.find(a=>a.candidate.id==='recall')!.status,'protected');
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 assert.throws(()=>hybridMode.beforeExecute!({state:f.state,snapshot,tool:'order',arguments:{action:recall.drafts[0]!.action},latest:<T>(k:string)=>(k==='state'?saved:k==='operations'?{operations}:undefined) as T|undefined}),/运输承诺/);
 assert.throws(()=>applyIntentEdits(saved,{upsert:[{id:null,task:{kind:'return-fleet',fleetId:'trip',until:400,reason:'软收益'}}],cancel:[]},'model',0,o),/Commander transfer/);
 applyIntentEdits(saved,{upsert:[{id:null,task:{kind:'return-fleet',fleetId:'trip',until:400,reason:'指挥官明确中止'}}],cancel:[]},'commander',0,o);
 const explicit:OperationState={id:'operation-2',phase:'fleet-intent',objective:'return',basis:basisOf(o),strategyVersion:0,status:'proposed',drafts:recall.drafts,orders:[],fleets:[],issues:[],intentBindings:[{id:'intent-2',version:1}]};
 assert.doesNotThrow(()=>hybridMode.beforeExecute!({state:f.state,snapshot,tool:'order',arguments:{action:recall.drafts[0]!.action},latest:<T>(k:string)=>(k==='state'?saved:k==='operations'?{operations:[...operations,explicit]}:undefined) as T|undefined}));
 applyIntentEdits(saved,{upsert:[],cancel:['intent-1']},'commander',0,o);assert.deepEqual(commanderProtectedFleets(o,saved,operations),[]);
});
test('configuration that ships troops out waits for delivery rather than empty-source completion',()=>{
 const f=fixture();f.add({kind:'configure',target:f.source,minDrillers:null,maxDrillers:0,maintain:false,priority:95,until:500,reason:'减少本点驻军'});
 const op:OperationState={id:'allocation',objective:'configure:intent-1',basis:basisOf(f.o),strategyVersion:0,status:'underway',drafts:[{id:'d',issueTick:100,action:{kind:'launch',source:f.source,destination:f.target,drillers:20}}],intentBindings:[{id:'intent-1',version:1}],orders:['trip'],fleets:['trip'],issues:[]};
 f.o.view.outposts.find(p=>p.id===f.source)!.drillers=0;reconcileIntents(f.o,f.saved,[op]);assert.equal(f.saved.intents![0]!.status,'running');
 for(const status of ['failed','ended','cancelled'] as const){op.status=status;reconcileIntents(f.o,f.saved,[op]);assert.equal(f.saved.intents![0]!.status,'blocked');}
});
test('destination loss releases transport for safety review without silently changing its route',()=>{
 const f=fixture(),{op}=launched(f);f.advance(102);const o=f.observe();o.view.outposts.find(p=>p.id===f.target)!.owner=1;
 assert.deepEqual(commanderProtectedFleets(o,f.saved,[op]),[]);reconcileIntents(o,f.saved,[op]);assert.equal(f.saved.intents![0]!.status,'blocked');
});
test('focus gates attack until delivery, confines attack origin and preserves independent restrictions',()=>{
 const f=fixture();f.saved.commanderText='只能从集结点攻击指定目标';f.add(f.transfer);f.add({kind:'focus',target:f.enemy,rally:f.target,until:500,reason:'先集结后单线进攻'});
 const allows=(source:string,destination:string)=>tacticalGuidanceAllows(f.o,[{id:'a',issueTick:100,action:{kind:'launch',source,destination,drillers:1}}],operationGuidance(f.o,null,[],0,f.saved)!);
 assert.equal(allows(f.target,f.enemy),false);assert.equal(allows(f.source,f.near),false);assert.equal(allows(f.source,f.target),true);
 f.saved.intents![0]!.status='completed';assert.equal(allows(f.target,f.enemy),true);assert.equal(allows(f.source,f.enemy),false);
 assert.equal(allows(f.target,f.near),false);assert.equal(allows(f.near,f.source),true,'independent friendly reinforcement remains possible');
 f.add({kind:'configure',target:f.target,minDrillers:10,maxDrillers:null,maintain:true,priority:80,until:500,reason:'持续最低留守'});
 assert.equal(allows(f.target,f.enemy),true,'satisfied maintained configuration does not keep the assembly phase blocked forever');
 f.add({kind:'avoid',target:f.enemy,until:500,reason:'禁攻尚未解除'});assert.equal(allows(f.target,f.enemy),false);
});
test('main effort locks its resources but permits one small safe opportunity from an independent source',()=>{
 const f=fixture();f.saved.commanderText='优先集结进攻，避免两线分散';f.add(f.transfer);f.add({kind:'focus',target:f.enemy,rally:f.target,until:500,reason:'主攻'});
 f.o.view.outposts.find(p=>p.id===f.near)!.drillers=60;f.o.view.self.drillers+=60;
 const guidance=operationGuidance(f.o,null,[],0,f.saved)!;
 const draft=(source:string,drillers:number)=>({id:'side',issueTick:100,action:{kind:'launch',source,destination:f.enemy,drillers}});
 assert.equal(tacticalGuidanceAllows(f.o,[draft(f.target,1)],guidance),false,'assembly incomplete');
 assert.equal(tacticalGuidanceAllows(f.o,[draft(f.source,1)],guidance),false,'transfer donor remains committed');
 assert.equal(tacticalGuidanceAllows(f.o,[draft(f.near,1)],guidance),true,'independent safe donor');
 assert.equal(tacticalGuidanceAllows(f.o,[draft(f.near,60)],guidance),false,'opportunity cannot consume main army');
 assert.equal(tacticalGuidanceAllows(f.o,[draft(f.near,1),{...draft(f.near,1),id:'second'}],guidance),false,'at most one opportunity');
 f.add({kind:'avoid',target:f.enemy,until:500,reason:'明确禁攻'});
 assert.equal(tacticalGuidanceAllows(f.o,[draft(f.near,1)],operationGuidance(f.o,null,[],0,f.saved)!),false);
});
test('incomplete commander route or single-front plans are rejected with actionable diagnostics',()=>{
 const f=fixture(),sourceName=f.o.outpostNames![f.source],targetName=f.o.outpostNames![f.target];
 const bad:IntentSpec={kind:'configure',target:f.source,minDrillers:null,maxDrillers:0,maintain:false,priority:95,until:500,reason:`${sourceName}转往${targetName}`};
 assert.throws(()=>validateCommanderEdits({upsert:[{id:null,task:bad}],cancel:[]},f.o),/transfer/);
 f.saved.commanderText='单线进攻';f.add({kind:'capture',target:f.enemy,priority:90,until:500,reason:'目标'});
 assert.match(commanderPlanIssue(f.saved,f.o)!,/focus/);f.add({kind:'focus',target:f.enemy,rally:f.target,until:500,reason:'单线'});assert.equal(commanderPlanIssue(f.saved,f.o),null);
});
test('explicit named commander route cannot be satisfied by historical empty-source configuration',()=>{
 const f=fixture(),a=f.o.outpostNames![f.source],b=f.o.outpostNames![f.target];
 f.saved.commanderText=`将${a}现有可调兵力集中撤往${b}集结`;
 f.add({kind:'configure',target:f.source,minDrillers:null,maxDrillers:0,maintain:false,priority:95,until:500,reason:'减少驻军'});
 f.saved.intents![0]!.status='completed';assert.match(commanderPlanIssue(f.saved,f.o)!,/transfer/);
 f.add(f.transfer);assert.equal(commanderPlanIssue(f.saved,f.o),null);
 f.saved.intents![1]!.status='completed';
 f.add({...f.transfer,reason:'重新整理同一条指令'});assert.equal(f.saved.intents!.filter(t=>t.spec.kind==='transfer').length,1,'rewording the same confirmed request cannot repeat an already delivered transfer');
 for(let i=0;i<20;i++){f.add({kind:'avoid',target:f.enemy,until:500+i,reason:'独立任务'+i});f.saved.intents!.at(-1)!.status='cancelled';}
 compactHybrid(f.saved,[],0);
 assert.ok(f.saved.intents!.some(t=>t.spec.kind==='transfer'&&t.status==='completed'));
 assert.equal(commanderPlanIssue(f.saved,f.o),null,'compaction preserves completed delivery evidence for the current commander version');
});
test('route capability checks preserve punctuation and whitespace in exact authorized names',()=>{
 const f=fixture();f.o.outpostNames![f.source]='ALPHA(1)';f.o.outpostNames![f.target]='BETA+2';
 assert.throws(()=>validateCommanderEdits({upsert:[],cancel:[]},f.o,'将ALPHA(1)的兵力撤往 BETA+2集结'),/transfer/);
 assert.doesNotThrow(()=>validateCommanderEdits({upsert:[{id:null,task:f.transfer}],cancel:[]},f.o,'将ALPHA(1)的兵力撤往 BETA+2集结'));
});
