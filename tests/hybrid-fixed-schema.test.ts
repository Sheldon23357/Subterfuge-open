import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {initialHybridState,type IntentTask,type StrategicAssessment} from '../plugins/hybrid/src/contracts.js';
import {makeBrief,type BriefTask} from '../plugins/hybrid/src/brief.js';
import {assertModelPermissions,modelAuthorization} from '../plugins/hybrid/src/model-permissions.js';
import {decodeModelResponse,fixedModelResponseSchema} from '../plugins/hybrid/src/model-wire.js';
import {normalizeIntentResult} from '../plugins/hybrid/src/intent-compatibility.js';
import {parseIntentResult} from '../plugins/hybrid/src/intent-protocol.js';
import {resolveIntentNames} from '../plugins/hybrid/src/model-names.js';
import {expandModelReferences} from '../plugins/hybrid/src/model-material.js';
import {publishHybridResult} from '../plugins/hybrid/src/publication.js';
import {codexGenerationSchema} from '../packages/ai/src/application/providers/codex-schema.js';
import {geminiGenerationSchema} from '../packages/ai/src/application/providers/gemini-schema.js';
import {codexInput} from '../packages/ai/src/application/providers/codex-input.js';
import {readPromptMaterial} from '../packages/contracts/src/index.js';

const hash=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function fixture(){
 const setup:FleetSetup={size:{width:80,height:80},positions:{a:{x:0,y:0},r:{x:2,y:0},b:{x:8,y:0},c:{x:12,y:0},d:{x:16,y:0}},economy:{initialTick:100,teamSize:0,
  players:Array.from({length:4},()=>({active:true,neptunium:20,minesCreated:0})),outposts:['a','r','b','c','d'].map((id,i)=>({id,owner:[0,0,1,2,3][i]!,type:'generator',drillers:100,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))}};
 const room={state:createFleetScenario(setup),scheduled:[]};
 const o=observation(room,0,'fixed-schema'),names={a:'ALPHA',r:'RALLY',b:'BRAVO',c:'CHARLIE',d:'DELTA'};
 const refresh=()=>{Object.assign(o,observation(room,0,'fixed-schema'));o.outpostNames=names;for(const p of o.view.outposts)p.visibility=2;};refresh();
 const state=initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'}),saved=initialHybridState();
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:4,roster:[0,1,2,3].map(player=>({gamePlayer:player,chatPlayer:player,displayName:'Player '+player}))};
 const task=(kind:BriefTask['kind']='strategy',peer=1):BriefTask=>({id:kind==='strategy'?'overview':kind,kind,scope:kind==='diplomacy'?String(peer):'overview',players:kind==='diplomacy'?[peer]:[],posts:[],messageIds:[]});
 const propose=(id:string,from=1,to=0)=>{room.state=submitFleetOrder(room.state,{id,player:from,action:{kind:'propose-agreement',peer:to,terms:{kind:'joint-attack',enemy:2},subsidy:null,counterTo:null}}).state;refresh();};
 const sign=(id:string,player=0)=>{room.state=submitFleetOrder(room.state,{id:'accept-'+id,player,action:{kind:'respond-agreement',agreementId:id,response:'accept'}}).state;refresh();};
 const intent=(id:string,status:IntentTask['status']='pending',authority:IntentTask['authority']='model',until=300,origin?:IntentTask['origin']):IntentTask=>({id,version:1,authority,commanderVersion:0,status,spec:{kind:'capture',target:'c',until,priority:50,reason:'bounded plan'},createdAt:100,updatedAt:100,reason:'pending',...(origin?{origin}:{})});
 const fleet=(id='p0-'+'a'.repeat(64))=>{o.view.fleets.push({id,owner:0,drillers:12,state:'moving',gift:false,canReturn:true,position:{x:1,y:0},source:'a',destination:{kind:'outpost',id:'r'}});return id;};
 const material=(t=task())=>makeBrief(t,state,snapshot,saved);
 return {o,state,saved,snapshot,task,propose,sign,intent,fleet,material};
}
type Fixture=ReturnType<typeof fixture>;
const capture=(target='CHARLIE')=>({kind:'capture',target,until:300,priority:50});
function parse(f:Fixture,reply:Record<string,unknown>,task=f.task(),m=f.material(task)){
 const raw={summary:'',tasks:[],cancel:[],reviewOn:[],...(task.kind==='commander'?{forbiddenPlayers:[],protectedSources:[],reserves:[]}:{}),...reply};
 const restored=resolveIntentNames(decodeModelResponse(expandModelReferences(raw,m.modelReferences),task.kind,[],{peer:m.permissions.diplomacy.peer}),f.o);
 const normalized=normalizeIntentResult(restored,f.saved.intents??[],task.kind,f.o.view.tick,f.saved.intents??[],!!f.o.diplomacy);
 const a=parseIntentResult(normalized.value,task.kind,f.o.view.playerCount,new Set(f.o.view.outposts.map(p=>p.id)),new Set(f.o.view.fleets.filter(p=>p.owner===0).map(p=>p.id)));
 return {a,m};
}
function validate(f:Fixture,reply:Record<string,unknown>,task=f.task()){
 const {a,m}=parse(f,reply,task);assertModelPermissions(a,m.permissions,f.o.outpostNames??{});return a;
}
function publish(f:Fixture,task:BriefTask,a:StrategicAssessment,captured=f.snapshot){
 publishHybridResult({saved:f.saved,snapshot:f.snapshot,port:{state:f.state,latest:()=>undefined,record:()=>{},wake:()=>{},model:{step:async()=>{throw Error('No model call expected');}}},persist:()=>{},enqueue:()=>{}},task,a,captured);
}

for(const kind of ['strategy','diplomacy','commander'] as const)test(`${kind} keeps source/provider schema and fixed rules identical through permission and phase changes`,()=>{
 const f=fixture(),t=f.task(kind),first=f.material(t),before=structuredClone(f.o);
 assert.deepEqual(f.o,before,'building materials cannot mutate the observation');
 f.propose('received');f.sign('received');
 f.fleet();f.saved.intents=[f.intent('intent-new'),f.intent('intent-commander','pending','commander')];
 f.o.view.tick+=11;f.o.view.outposts.find(p=>p.id==='a')!.owner=1;f.o.view.outposts.find(p=>p.id==='d')!.visibility=0;
 f.o.intel.find(p=>p.player===3)!.active=false;
 const second=f.material(t),p1=codexInput(first.prompt),p2=codexInput(second.prompt);
 assert.deepEqual(second.responseSchema,first.responseSchema);
 assert.equal(hash(codexGenerationSchema(second.responseSchema)),hash(codexGenerationSchema(first.responseSchema)));
 assert.equal(hash(geminiGenerationSchema(second.responseSchema)),hash(geminiGenerationSchema(first.responseSchema)));
 assert.ok(p1.instructions.length>0&&p2.instructions.length>0,'fixed rules remain a separate developer prefix');
 assert.equal(p1.instructions,p2.instructions);
 assert.ok(p2.instructions.length<=12000);assert.notEqual(first.prompt,second.prompt);
 assert.notDeepEqual(first.permissions,second.permissions);
 assert.equal(JSON.stringify(second.responseSchema).includes('intent-new'),false);
 const body=readPromptMaterial(second.prompt);assert.equal(body.facts.permissions.version,'hybrid-permissions/1');
 assert.equal(body.facts.permissions.visibleOutposts.includes('DELTA'),false);
 assert.equal(body.facts.permissions.diplomacy.enemies.includes(3),false);
});

test('the same role schema is independent of player/conversation identity and survives all task/proposal transitions',()=>{
 const f=fixture(),t=f.task('diplomacy'),materials=[f.material(t)];
 f.propose('received');materials.push(f.material(t));
 f.sign('received');materials.push(f.material(t));
 f.saved.intents=[f.intent('contract','pending','model',300,{kind:'diplomacy',conversation:'1',agreementId:'received'})];materials.push(f.material(t));
 f.saved.intents[0]!.status='completed';f.o.diplomacy!.agreements[0]!.fulfilled[1]=true;materials.push(f.material(t));
 f.o.diplomacy!.agreements[0]!.status='expired';materials.push(f.material(t));
 materials.push(f.material(f.task('diplomacy',3)));
 assert.equal(new Set(materials.map(m=>hash(m.responseSchema))).size,1);
 assert.equal(new Set(materials.map(m=>hash(codexInput(m.prompt).instructions))).size,1);
 assert.ok(new Set(materials.map(m=>hash(m.permissions))).size>=5);
});

test('fixed generation keeps all role-appropriate action branches without dynamic IDs or zero-capacity removal',()=>{
 for(const kind of ['strategy','diplomacy','commander'] as const){
  const schema=fixedModelResponseSchema(kind,true),variants=schema.properties.tasks.items.anyOf;
  assert.equal(schema.properties.tasks.maxItems,12);assert.equal(schema.properties.cancel.maxItems,12);
  assert.ok(variants.some((v:any)=>v.properties.kind.enum[0]==='return-fleet'));
  assert.equal(variants.some((v:any)=>v.properties.kind.enum[0]==='focus'),kind==='commander');
  for(const v of variants)if(v.properties.target)assert.equal(v.properties.target.enum,undefined);
 }
});

test('generic diplomacy identifiers stay typed references instead of undefined singleton enums',()=>{
 const source=fixedModelResponseSchema('diplomacy',true);
 assert.deepEqual(source.properties.peer,{type:'integer',minimum:0,maximum:9});
 assert.deepEqual(source.properties.agreementId,{type:['string','null'],maxLength:120});
 const walk=(value:any)=>{
  if(!value||typeof value!=='object')return;
  if(value.enum)assert.ok(value.enum.every((v:unknown)=>v!==undefined),'all enum entries must survive JSON transport');
  Object.values(value).forEach(walk);
 };
 for(const schema of [source,codexGenerationSchema(source),geminiGenerationSchema(source)]){
  walk(schema);assert.deepEqual(JSON.parse(JSON.stringify(schema)),schema);
 }
});

test('captured permissions accept valid targets and reject unseen targets, enemy allocations and unauthorized task IDs',()=>{
 const f=fixture();f.o.view.outposts.find(p=>p.id==='d')!.visibility=0;
 f.saved.intents=[f.intent('old','expired'),f.intent('commander','pending','commander'),f.intent('live')];
 assert.doesNotThrow(()=>validate(f,{tasks:[capture()]}));
 assert.doesNotThrow(()=>validate(f,{tasks:[{...capture(),id:'live'}],cancel:[]}));
 for(const reply of [
  {tasks:[capture('DELTA')]},
  {tasks:[{kind:'configure',target:'BRAVO',until:300,priority:50,minDrillers:1}]},
  {tasks:[{kind:'transfer',source:'BRAVO',target:'ALPHA',until:300,priority:50,drillers:1}]},
  {tasks:[{...capture(),id:'invented'}]},
  {tasks:[{...capture(),id:'old'}]},
  {tasks:[{...capture(),id:'commander'}]},
  {cancel:['old']},{cancel:['commander']},{cancel:['invented']},
 ])assert.throws(()=>validate(f,reply),/permission denied/);
});

test('fixed fleet fields retain exact short-reference restoration and cannot reuse a removed fleet',()=>{
 const f=fixture(),id=f.fleet(),t=f.task(),m=f.material(t),short=Object.entries(m.modelReferences).find(([,full])=>full===id)![0];
 const {a}=parse(f,{tasks:[{kind:'return-fleet',fleetId:short,until:300}]},t,m);
 assert.equal((a.intentEdits!.upsert[0]!.task as {fleetId:string}).fleetId,id);
 assertModelPermissions(a,m.permissions,f.o.outpostNames??{});
 f.o.view.fleets[0]!.canReturn=false;
 assert.throws(()=>publish(f,t,a),/permission denied/);
 f.o.view.fleets=[];
 const before=structuredClone(f.saved);assert.throws(()=>publish(f,t,a),/permission denied/);assert.deepEqual(f.saved,before);
});

test('diplomacy cannot self-grant tasks, change peer, attack a participant or sign third-party/hidden posts',()=>{
 const f=fixture(),t=f.task('diplomacy');f.o.view.outposts.find(p=>p.id==='r')!.visibility=0;
 assert.equal(f.material(t).permissions.maxTasks,0);
 for(const reply of [
  {tasks:[capture()]},
  {action:'joint-attack',peer:3,enemy:2},
  {action:'joint-attack',peer:1,enemy:1},
  {action:'joint-attack',peer:1,enemy:0},
  {action:'ceasefire',peer:1,outposts:['CHARLIE']},
  {action:'ceasefire',peer:1,outposts:['RALLY']},
  {action:'ceasefire',peer:1,outposts:['ALPHA'],subsidy:{payer:3,amount:1}},
 ])assert.throws(()=>validate(f,reply,t),/permission denied/);
 assert.doesNotThrow(()=>validate(f,{action:'ceasefire',peer:1,outposts:['ALPHA','BRAVO']},t));
});

test('proposal replies and counteroffers retain per-proposal actor permissions',()=>{
 const f=fixture(),t=f.task('diplomacy');f.propose('received');f.propose('sent',0,1);
 assert.doesNotThrow(()=>validate(f,{action:'accept',agreementId:'received'},t));
 assert.doesNotThrow(()=>validate(f,{action:'withdraw',agreementId:'sent'},t));
 for(const reply of [
  {action:'accept',agreementId:'sent'},{action:'withdraw',agreementId:'received'},
  {action:'reject',agreementId:'invented'},
  {action:'joint-attack',peer:1,enemy:2,counterTo:'sent'},
 ])assert.throws(()=>validate(f,reply,t),/permission denied/);
 assert.doesNotThrow(()=>validate(f,{action:'joint-attack',peer:1,enemy:2,counterTo:'received'},t));
});

test('only an omitted peer can bind to an authenticated single conversation, with an audit entry',()=>{
 const f=fixture(),task=f.task('diplomacy'),audit:any[]=[];
 const decoded=decodeModelResponse({action:'ceasefire',outposts:['ALPHA']},'diplomacy',audit,{peer:1}) as any;
 assert.equal(decoded.diplomacyAction.peer,1);assert.deepEqual(audit,[{path:'$.peer',rule:'bind-conversation-peer',value:1}]);
 assert.doesNotThrow(()=>validate(f,{action:'ceasefire',outposts:['ALPHA']},task));
 assert.throws(()=>validate(f,{action:'ceasefire',peer:3,outposts:['ALPHA']},task),/permission denied/);
 const publicTask={...task,scope:'public',players:[]};
 assert.throws(()=>validate(f,{action:'ceasefire',outposts:['ALPHA']},publicTask),/diplomacy integer|permission denied/);
 const explicit=decodeModelResponse({action:'ceasefire',peer:3,outposts:['ALPHA']},'diplomacy',[],{peer:1}) as any;
 assert.equal(explicit.diplomacyAction.peer,3,'an explicit incorrect identity is never rewritten');
});

test('permission catalog and deterministic diplomacy facts share the same aligned-identity fallback',()=>{
 const f=fixture(),task=f.task('diplomacy');delete f.snapshot.roster;f.propose('received');
 const m=f.material(task),facts=(m.brief.guidance as any).communicationFacts;
 assert.deepEqual(facts.peers,[m.permissions.diplomacy.peer]);assert.equal(facts.scopeContracts[0].id,'received');
 assert.equal(facts.scopeContracts[0].allowedActions,'accept,reject,counter');
 assert.doesNotThrow(()=>validate(f,{action:'accept',agreementId:'received'},task));
});

test('an explicit roster never guesses an absent conversation identity from aligned self IDs',()=>{
 const f=fixture(),task=f.task('diplomacy');f.snapshot.roster=f.snapshot.roster!.filter(r=>r.chatPlayer!==1);
 const m=f.material(task);
 assert.equal(m.permissions.diplomacy.peer,null);
 assert.deepEqual((m.brief.guidance as any).communicationFacts.peers,[]);
 assert.throws(()=>validate(f,{action:'ceasefire',peer:1,outposts:['ALPHA']},task),/permission denied/);
});

test('diplomatic task IDs and fulfillment references stay within the signed conversation',()=>{
 const f=fixture(),t=f.task('diplomacy');f.propose('signed');f.sign('signed');
 f.saved.intents=[f.intent('bound','pending','model',300,{kind:'diplomacy',conversation:'1',agreementId:'signed'}),f.intent('independent'),f.intent('other','pending','model',300,{kind:'diplomacy',conversation:'3',agreementId:'other-contract'})];
 assert.doesNotThrow(()=>validate(f,{tasks:[{...capture(),id:'bound'}],fulfillAgreementId:'signed'},t));
 for(const reply of [{cancel:['independent']},{cancel:['other']},{tasks:[{...capture(),id:'other'}]},{fulfillAgreementId:'other-contract'}])assert.throws(()=>validate(f,reply,t),/permission denied/);
 f.o.diplomacy!.agreements[0]!.fulfilled[1]=true;
 assert.throws(()=>validate(f,{tasks:[capture()]},t),/permission denied/);
});

test('latest permissions reject changed ownership, visibility, cancelled tasks and expired deadlines before any publication',()=>{
 const cases=[
  {reply:{tasks:[capture()]},change:(f:Fixture)=>{f.o.view.outposts.find(p=>p.id==='c')!.visibility=0;}},
  {reply:{tasks:[capture()]},change:(f:Fixture)=>{f.o.view.outposts.find(p=>p.id==='c')!.destroyed=true;}},
  {reply:{tasks:[{kind:'configure',target:'ALPHA',until:300,priority:50,minDrillers:10}]},change:(f:Fixture)=>{f.o.view.outposts.find(p=>p.id==='a')!.owner=1;}},
  {reply:{cancel:['live']},change:(f:Fixture)=>{f.saved.intents![0]!.status='cancelled';}},
  {reply:{tasks:[capture()]},change:(f:Fixture)=>{f.o.view.tick=301;}},
 ];
 for(const item of cases){
  const f=fixture();f.saved.intents=[f.intent('live')];const t=f.task(),captured=structuredClone(f.snapshot),{a,m}=parse(f,item.reply,t);
  assertModelPermissions(a,m.permissions,f.o.outpostNames??{});item.change(f);
  const before=structuredClone(f.saved);assert.throws(()=>publish(f,t,a,captured),/permission denied/);assert.deepEqual(f.saved,before);
 }
});

test('a proposal expiring during inference cannot publish its message, summary or contract action',()=>{
 const f=fixture(),t=f.task('diplomacy');f.propose('received');
 const captured=structuredClone(f.snapshot),{a,m}=parse(f,{summary:'new summary',message:'同意这份协议。',action:'accept',agreementId:'received'},t);
 assertModelPermissions(a,m.permissions,f.o.outpostNames??{});f.o.diplomacy!.agreements[0]!.status='expired';
 const before=structuredClone(f.saved);assert.throws(()=>publish(f,t,a,captured),/permission denied/);assert.deepEqual(f.saved,before);
});

test('a captured valid acceptance becoming signed remains an idempotent publication without a duplicate command',()=>{
 const f=fixture(),t=f.task('diplomacy');f.propose('received');const captured=structuredClone(f.snapshot),{a,m}=parse(f,{action:'accept',agreementId:'received'},t);
 assertModelPermissions(a,m.permissions,f.o.outpostNames??{});f.sign('received');
 assert.doesNotThrow(()=>publish(f,t,a,captured));assert.equal(f.saved.contractCommands?.length??0,0);
});

test('empty authorization is fail-closed even though the fixed schema accepts reference strings',()=>{
 const f=fixture();for(const p of f.o.view.outposts)p.visibility=0;
 assert.throws(()=>validate(f,{tasks:[capture()]}),/permission denied/);
 const p=modelAuthorization(f.task(),f.snapshot,f.saved).permissions;assert.deepEqual(p.visibleOutposts,[]);
});
