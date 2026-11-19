import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';import {AiStore,initialState,executeTool,PlayerGateway,codexArguments,type AiSnapshot,type AgentRequest} from '../packages/ai/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation,createPlayerApi} from '../packages/server/src/player-api.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {classifyChanges} from '../packages/ai/src/controller/runtime/decision.js';

function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.match={mode:'mining',neptuniumGoal:200};
 const room={state:createFleetScenario(cfg),scheduled:[]};
 const snapshot:AiSnapshot={observation:observation(room,0,'room'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 snapshot.observation.outpostNames=Object.fromEntries(snapshot.observation.view.outposts.map(p=>[p.id,p.id]));
 return {room,snapshot};
}
const finish={tokens:1,reply:{tool:'finish',arguments:'{}',summary:'已处理'}};

test('visible reinforcement of an actual attack target wakes review even at the same tick; unrelated growth does not',()=>{
 const {snapshot}=fixture(),before=snapshot.observation;
 const target=before.view.outposts.find(o=>o.owner===1)!;
 target.drillers=5;target.shield=0;
 before.view.fleets.push({id:'attack',owner:0,source:before.view.outposts.find(o=>o.owner===0)!.id,position:{x:0,y:0},state:'waiting',drillers:29,gift:false,destination:{kind:'outpost',id:target.id}});
 const after=structuredClone(before);after.view.outposts.find(o=>o.id===target.id)!.drillers=25;
 const signal=classifyChanges(before,after).important.find(s=>s.key===`attack-target:${target.id}`)!;
 assert.equal(after.view.tick,before.view.tick);assert.equal(signal.category,'military');assert.equal(signal.urgent,true);assert.ok(signal.entities.includes('attack'));
 const unrelated=structuredClone(before);unrelated.view.outposts.push({id:'remote',owner:1,visibility:2,position:{x:10,y:10},drillers:5,shield:0});
 const changed=structuredClone(unrelated);changed.view.outposts.at(-1)!.drillers=25;
 assert.equal(classifyChanges(unrelated,changed).important.some(s=>s.key.startsWith('attack-target:')),false);
 const hidden=structuredClone(before);delete hidden.view.outposts.find(o=>o.id===target.id)!.drillers;
 assert.equal(classifyChanges(before,hidden).important.some(s=>s.key.startsWith('attack-target:')),true);
 const gift=structuredClone(before);gift.view.fleets[0]!.gift=true;
 const giftAfter=structuredClone(gift);giftAfter.view.outposts.find(o=>o.id===target.id)!.drillers=25;
 assert.equal(classifyChanges(gift,giftAfter).important.some(s=>s.key.startsWith('attack-target:')),false);
});
test('known construction and dispatch costs are plan changes rather than military damage',()=>{
 const {snapshot}=fixture(),before=snapshot.observation,after=structuredClone(before);
 const post=after.view.outposts.find(o=>o.owner===0)!;post.drillers!-=50;post.minePending=true;
 const build=classifyChanges(before,after);assert.equal(build.important.some(s=>s.category==='military'),false);assert.equal(build.important.some(s=>s.category==='plan'),true);
 post.minePending=false;post.drillers=before.view.outposts.find(o=>o.id===post.id)!.drillers!-10;
 after.view.fleets.push({id:'dispatch',owner:0,source:post.id,position:post.position,state:'waiting',drillers:10,gift:false,destination:null});
 assert.equal(classifyChanges(before,after).important.some(s=>s.category==='military'),false);
});


function contestedFixture(){
 const {snapshot}=fixture(),target=snapshot.observation.view.outposts.find(o=>o.owner===1)!;
 target.owner=null;target.drillers=0;target.shield=0;
 snapshot.observation.view.fleets=[{id:'own-14',owner:0,position:{x:0,y:0},state:'moving',drillers:14,gift:false,destination:{kind:'outpost',id:target.id}}];
 return {snapshot,target};
}

test('new opposing fleets competing for our neutral target wake military review; irrelevant contacts and gifts do not',()=>{
 const {snapshot,target}=contestedFixture(),before=structuredClone(snapshot.observation);
 snapshot.observation.view.fleets.push({id:'rival-30',owner:1,position:{x:1,y:0},state:'moving',drillers:30,gift:false,destination:{kind:'outpost',id:target.id}});
 const after=snapshot.observation,signals=classifyChanges(before,after).important;
 const signal=signals.find(s=>s.key===`contested-target:${target.id}`)!;
 assert.equal(signal.category,'military');assert.equal(signal.urgent,true);
 assert.deepEqual(signal.entities,[target.id,'rival-30','own-14']);
 const unchanged=structuredClone(after);unchanged.view.fleets[1]!.position.x+=0.1;
 assert.equal(classifyChanges(after,unchanged).important.some(s=>s.key.startsWith('contested-target:')),false);
 const unrelated=structuredClone(after);unrelated.view.fleets[1]!.destination={kind:'outpost',id:'unrelated'};
 assert.equal(classifyChanges(before,unrelated).important.some(s=>s.key.startsWith('contested-target:')),false);
 const gift=structuredClone(after);gift.view.fleets[0]!.gift=true;
 assert.equal(classifyChanges(before,gift).important.some(s=>s.key.startsWith('contested-target:')),false);
 const launching=structuredClone(after);launching.view.fleets[1]!.state='launching';
 assert.equal(classifyChanges(launching,after).important.some(s=>s.key.startsWith('contested-target:')),false);
 const resized=structuredClone(after);resized.view.fleets[1]!.drillers=40;
 assert.ok(classifyChanges(after,resized).important.some(s=>s.key.startsWith('contested-target:')));
});

test('observed enemy departure from our attack target wakes review, with wrapped source inference and no disappearance guess',()=>{
 const {snapshot}=fixture(),before=snapshot.observation,target=before.view.outposts.find(o=>o.owner===1)!;
 before.view.fleets=[{id:'attack',owner:0,position:{x:0,y:0},state:'waiting',drillers:29,gift:false,destination:{kind:'outpost',id:target.id}},
 {id:'defender',owner:1,position:{x:target.position.x+before.view.size.width,y:target.position.y},state:'waiting',drillers:34,gift:false,destination:{kind:'outpost',id:before.view.outposts.at(-1)!.id}}];
 for(const state of ['launching','moving'] as const){
   const after=structuredClone(before);after.view.fleets[1]!.state=state;
   const signal=classifyChanges(before,after).important.find(s=>s.key===`attack-departure:${target.id}`)!;
   assert.equal(signal.category,'military');assert.equal(signal.urgent,true);assert.ok(signal.entities.includes('defender'));
   assert.equal(classifyChanges(after,structuredClone(after)).important.some(s=>s.key.startsWith('attack-departure:')),false);
 }
 const gone=structuredClone(before);gone.view.fleets.pop();
 assert.equal(classifyChanges(before,gone).important.some(s=>s.key.startsWith('attack-departure:')),false);
 const unrelated=structuredClone(before);unrelated.view.fleets[0]!.destination={kind:'outpost',id:'elsewhere'};
 const departed=structuredClone(unrelated);departed.view.fleets[1]!.state='moving';
 assert.equal(classifyChanges(unrelated,departed).important.some(s=>s.key.startsWith('attack-departure:')),false);
 const gift=structuredClone(before);gift.view.fleets[0]!.gift=true;
 const giftAfter=structuredClone(gift);giftAfter.view.fleets[1]!.state='moving';
 assert.equal(classifyChanges(gift,giftAfter).important.some(s=>s.key.startsWith('attack-departure:')),false);
});
