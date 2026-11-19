import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {initialHybridState,type SituationBrief} from '../plugins/hybrid/src/contracts.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';
import {currentModelVision,filterOutsideModelFeedback} from '../plugins/hybrid/src/model-vision.js';
import {readPromptMaterial} from '../packages/contracts/src/index.js';
import type {CommanderThread,CommanderMessage} from '../packages/contracts/src/index.js';
import {hybridCommanderPrompt} from '../plugins/hybrid/src/commander.js';
const records=(t:any):any[]=>Array.isArray(t)?t:t?.rows?.map((r:any[])=>Object.fromEntries(t.columns.map((k:string,i:number)=>[k,r[i]])))??[];
function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;setup.match={mode:'mining',neptuniumGoal:200};setup.economy.initialTick=0;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'model-vision');
 o.view.outposts.push({id:'shadow',position:{x:20,y:20},owner:1,visibility:0,type:'mine',drillers:999,shield:99},{id:'known',position:{x:21,y:21},owner:1,visibility:1,type:'factory'},{id:'fog-neutral',position:{x:22,y:22},owner:null,visibility:0},{id:'seen',position:{x:1,y:1},owner:null,visibility:2,type:'generator',drillers:0,shield:0});
 o.outpostNames={...o.outpostNames,shadow:'SHADOW',known:'KNOWN',seen:'SEEN','fog-neutral':'FOG-NEUTRAL'};
 const state=initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'}),saved=initialHybridState(),snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 return {o,state,saved,snapshot};
}

for(const kind of ['strategy','diplomacy','commander'] as const)test(`${kind} provides every visible outpost and authorized fleet core record without queries`,()=>{
 const f=fixture(),post=f.o.view.outposts.find(p=>p.visibility===2)!;
 f.o.view.fleets.push({id:'default-own',owner:0,drillers:0,state:'moving',gift:false,position:post.position,destination:{kind:'outpost',id:post.id}},
  {id:'default-other',owner:1,drillers:17,state:'moving',gift:false,position:post.position,destination:{kind:'outpost',id:'seen'}});
 const before=structuredClone(f.o),m=makeBrief({id:kind,kind,scope:'overview',players:kind==='diplomacy'?[1]:[],posts:[],messageIds:[]},f.state,f.snapshot,f.saved),b=readPromptMaterial(m.prompt);
 const posts=records(b.global.identities);
 for(const p of f.o.view.outposts.filter(p=>p.visibility===2)){
  const row=posts.find(r=>r.name===f.o.outpostNames![p.id]);assert.ok(row);
  assert.deepEqual([row.owner,row.type,row.drillers,row.shield],[p.owner??null,p.type??null,p.drillers??null,p.shield??null]);
 }
 const own=records(b.global.ownFleets).find(f=>f.id==='default-own'),other=records(b.facts.fleets).find(f=>f.id==='default-other');
 assert.deepEqual([own.owner,own.drillers,own.state,own.destination.name],[0,0,'moving',f.o.outpostNames![post.id]]);
 assert.deepEqual([other.owner,other.drillers,other.state,other.destinationId],[1,17,'moving','SEEN']);
 assert.ok(!JSON.stringify(b).includes('"visibility"'));assert.equal((m.responseSchema as any).properties.needsInformation,undefined);
 for(const key of ['requestableInformation','requestedInformation','remainingInformationPasses'])assert.equal(b.facts[key],undefined);
 assert.deepEqual(f.o,before);
});

for(const kind of ['strategy','diplomacy','commander'] as const)test(`${kind} filters unseen and known-only map facts, queries and new target enums while preserving program state`,()=>{
 const f=fixture(),before=structuredClone(f.o),m=makeBrief({id:kind,kind,scope:'overview',players:kind==='diplomacy'?[1]:[],posts:['shadow','known','fog-neutral','seen'],messageIds:[]},f.state,f.snapshot,f.saved),wire=readPromptMaterial(m.prompt);
 assert.deepEqual(f.o,before);
 assert.equal(records(wire.global.identities).length,f.o.view.outposts.filter(p=>p.visibility===2).length);
 assert.ok(records(wire.global.identities).every(p=>!Object.hasOwn(p,'visibility')));
 const text=JSON.stringify(wire),schema=JSON.stringify(m.responseSchema);
 for(const name of ['SHADOW','KNOWN','FOG-NEUTRAL']){assert.ok(!text.includes(name),name+' must not reappear through geography, requested details or diplomacy');assert.ok(!schema.includes(name),name+' must not be a query/action candidate');}
 assert.ok(text.includes('SEEN'));assert.ok(m.permissions.visibleOutposts.includes('SEEN'));assert.ok(!schema.includes('SEEN'));
 assert.ok((m.brief.global as any).identities.some((r:any[])=>r[0]==='SHADOW'),'full internal guard remains available');
 assert.equal(m.contextSelection.visibility.rule,'current-visibility-2');
 assert.ok(m.contextSelection.visibility.omittedOutposts.includes('known'));
});

test('opening rival geometry cannot disclose a hidden source even when its target is visible',()=>{
 const f=fixture();for(const p of f.o.view.outposts)if(p.owner===1)p.visibility=0;
 const m=makeBrief({id:'opening',kind:'strategy',scope:'overview',players:[],posts:['seen'],messageIds:[]},f.state,f.snapshot,f.saved),wire=readPromptMaterial(m.prompt),opening=records(wire.global.opening);
 assert.ok(opening.length);assert.ok(opening.every(p=>p.rivalSource===null&&p.rivalDistance===null&&p.rivalPlayer===null));
 assert.ok(opening.every(p=>p.zone==='unknown'),'unseen rivals do not become a fabricated safe own-side zone');
});

test('authored references, existing tasks and receipts remain exact without providing their unseen map facts',()=>{
 const f=fixture(),text='暂不进攻 SHADOW，原指示保留。';f.state.commanderDirectives={version:1,text};
 f.saved.chat=[{id:'message',from:1,to:0,text:'之前提到 SHADOW，不代表现在能看到。',tick:0,sentAt:0}];
 f.saved.intents=[{id:'intent-hidden',version:1,authority:'model',status:'pending',createdAt:0,updatedAt:0,spec:{kind:'capture',target:'shadow',until:100,priority:50,maxDrillersPerPlan:20,reason:'past objective'},reason:'pending'} as any];
 const m=makeBrief({id:'strategy',kind:'strategy',scope:'overview',players:[],posts:[],messageIds:['message']},f.state,f.snapshot,f.saved),wire=readPromptMaterial(m.prompt);
 assert.equal(wire.guidance.commander.text,text);assert.equal(wire.evidence.messages[0].text,f.saved.chat[0]!.text);
 const task=records(wire.guidance.intentTasks.byKind.capture)[0];assert.equal(task.target,'SHADOW');assert.equal(task.until,100);
 const evaluation=wire.guidance.executionFeasibility.find((e:any)=>e.taskId==='intent-hidden');assert.equal(evaluation.mapFacts,'outside-current-vision');
 assert.equal(evaluation.currentStaticMinimum,undefined);assert.ok(!records(wire.facts.taskTargets).some(p=>p.name==='SHADOW'));
});

test('conditional feedback cannot bypass visibility through action tuples or historical goals',()=>{
 const f=fixture(),brief={global:{feedback:{actionColumns:['kind','source','destination','drillers'],selected:{actions:[['launch','HOME','SHADOW',1]]},conditionalAlternatives:[{targets:['SEEN'],differenceFromSelected:{add:[],remove:[]}}],unverified:[{goals:[{kind:'capture',target:'KNOWN'}]},{targets:['SEEN']}]}}} as unknown as SituationBrief;
 filterOutsideModelFeedback(brief,f.o);const feedback=(brief.global as any).feedback;
 assert.deepEqual(feedback.selected,{status:'outside-current-vision'});assert.deepEqual(feedback.conditionalAlternatives,[]);assert.deepEqual(feedback.unverified,[{targets:['SEEN']}]);
 assert.ok(currentModelVision(f.o).view.outposts.every(p=>p.visibility===2));
});

test('commander discussion preserves player wording but does not answer with unseen identity or location data',()=>{
 const f=fixture(),message:CommanderMessage={id:'question',role:'player',text:'看看 SHADOW，当前是什么情况？',references:[{kind:'outpost',id:'shadow'}] as any,tick:0,sentAt:0,status:'queued'},thread:CommanderThread={roomId:f.o.roomId,player:0,messages:[message],directives:{version:0,text:'',appliedVersion:0}};
 const before=structuredClone(f.o),prompt=hybridCommanderPrompt({mode:'discuss',state:f.state,thread,message,observation:f.o,roster:[],latest:<T>()=>undefined as T|undefined}),wire=readPromptMaterial(prompt);
 assert.deepEqual(f.o,before);assert.equal(wire.currentMessage.text,message.text);
 assert.ok(wire.identities.every((p:any)=>!Object.hasOwn(p,'visibility')));
 assert.ok(!wire.relevantFacts.some((p:any)=>p.name==='SHADOW'||p.id==='shadow'));
 assert.ok(!wire.attackAssessment?.targets.some((p:any)=>p.target==='SHADOW'));
});
