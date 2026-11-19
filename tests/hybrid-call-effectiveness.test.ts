import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {initialHybridState,basisOf,type OperationState} from '../plugins/hybrid/src/contracts.js';
import {applyIntentEdits,reconcileIntents,configurationCandidates,intentBindings} from '../plugins/hybrid/src/intents.js';
import {intentReviewKey,intentFeasibility,hasNewIntentIssue} from '../plugins/hybrid/src/intent-feasibility.js';
import {strategyReviewKeys} from '../plugins/hybrid/src/strategy-review.js';
import {pressureReviewKey} from '../plugins/hybrid/src/diplomacy-review.js';
import {commanderTransportUnsafe} from '../plugins/hybrid/src/commander-commitments.js';
import {hybridPlanning} from '../plugins/hybrid/src/planning.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';
import {planBot} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {foregroundInputKey,foregroundNeedsUpdate} from '../plugins/hybrid/src/foreground-input.js';

function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'call-effectiveness'),saved=initialHybridState();
 const state=initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'});
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,roster:[{gamePlayer:0,chatPlayer:0},{gamePlayer:1,chatPlayer:1}]};
 return {o,saved,state,snapshot,own:o.view.outposts.find(p=>p.owner===0)!,enemy:o.view.outposts.find(p=>p.owner===1)!};
}

test('renewing a live deadline preserves accepted operation bindings and rejects actual parameter changes',()=>{
 const f=fixture();f.enemy.owner=0;
 const spec={kind:'transfer' as const,source:f.own.id,target:f.enemy.id,drillers:10,priority:80,until:200,reason:'增援'};
 applyIntentEdits(f.saved,{upsert:[{id:null,task:spec}],cancel:[]},'model',0,f.o);
 const op:OperationState={id:'accepted',objective:'transfer:intent-1',basis:basisOf(f.o),strategyVersion:0,status:'underway',drafts:[],orders:['real-order'],fleets:[],issues:[],intentBindings:[{id:'intent-1',version:1}]};
 reconcileIntents(f.o,f.saved,[op]);assert.equal(f.saved.intents![0]!.status,'running');
 const inputKey=foregroundInputKey(f.saved,f.o);
 const beforeExtension=structuredClone(f.saved);
 applyIntentEdits(f.saved,{upsert:[{id:'intent-1',task:{...spec,until:250}}],cancel:[]},'model',0,f.o);
 assert.equal(f.saved.intents![0]!.version,1);assert.equal(f.saved.intents![0]!.status,'running');
 assert.equal(foregroundNeedsUpdate(beforeExtension,f.saved,f.o),false,'an active extension does not wake military search');
 assert.deepEqual(configurationCandidates(f.o,attackRoutes(f.o),f.saved,[op]),[],'extension cannot resend the transport');
 applyIntentEdits(f.saved,{upsert:[{id:'intent-1',task:{...spec,drillers:20,until:250}}],cancel:[]},'model',0,f.o);
 assert.equal(f.saved.intents![0]!.version,2);
 assert.notEqual(foregroundInputKey(f.saved,f.o),inputKey);
 applyIntentEdits(f.saved,{upsert:[{id:'intent-1',task:{...spec,drillers:20,until:150}}],cancel:[]},'model',0,f.o);
 assert.equal(f.saved.intents![0]!.version,3,'shortening an execution window invalidates old unsubmitted proposals');
});

test('strategic execution facts expose insufficient capture caps, actual age and unknown history',()=>{
 const f=fixture();applyIntentEdits(f.saved,{upsert:[{id:null,task:{kind:'capture',target:f.enemy.id,priority:55,maxDrillersPerPlan:7,until:300,reason:'测试长期等待'}}],cancel:[]},'model',0,f.o);
 f.o.view.tick+=30;
 const planning=hybridPlanning(f.o,[f.enemy.id]),facts=intentFeasibility(f.o,f.saved,planning)[0] as any;
 assert.equal(facts.ageWorldDays,30);assert.equal(facts.currentStaticMinimum,20);assert.equal(facts.capBelowCurrentStaticMinimum,true);assert.equal(facts.lastRetainedAcceptedTick,null);
 const first=intentReviewKey(f.o,f.saved,[]);assert.notEqual(first,'[]');
 assert.equal(hasNewIntentIssue('[]',first),false,'finishing an issue cannot re-open the others');
 assert.equal(hasNewIntentIssue(first,first),false);
 f.saved.intents![0]!.status='blocked';assert.equal(intentReviewKey(f.o,f.saved,[]),first,'planner pending/blocked labels do not create a new strategic issue');
 applyIntentEdits(f.saved,{upsert:[{id:'intent-1',task:{...f.saved.intents![0]!.spec,until:350}}],cancel:[]},'model',0,f.o);
 assert.equal(intentReviewKey(f.o,f.saved,[]),first,'a renewal does not generate another blocked-task trigger');
 const material=makeBrief({id:'overview',kind:'strategy',scope:'overview',posts:[],messageIds:[],players:[]},f.state,f.snapshot,f.saved);
 const projected=(material.brief.guidance as any).executionFeasibility[0];assert.equal(projected.target,f.o.outpostNames![f.enemy.id]);assert.equal(projected.capBelowCurrentStaticMinimum,true);
 f.enemy.visibility=0;delete f.enemy.drillers;delete f.enemy.shield;
 assert.equal((intentFeasibility(f.o,f.saved,planning)[0] as any).currentStaticMinimum,null,'hidden defense is not zero');
});

test('strategic threat identity ignores fleet IDs while structural changes and large force changes remain visible',()=>{
 const f=fixture();f.o.view.fleets.push({id:'wave-a',owner:1,drillers:30,state:'underway',gift:false,position:f.own.position,destination:{kind:'outpost',id:f.own.id}});
 const first=strategyReviewKeys(f.o,0,null);f.o.view.fleets[0]!.id='wave-b';
 assert.deepEqual(strategyReviewKeys(f.o,0,null),first);
 f.o.view.fleets[0]!.drillers=90;const larger=strategyReviewKeys(f.o,0,null);assert.notEqual(larger.threat,first.threat);assert.equal(larger.urgent,first.urgent);
 f.own.type='mine';assert.notEqual(strategyReviewKeys(f.o,0,null).urgent,first.urgent);
});

test('diplomacy does not re-review unchanged pressure after unrelated territorial changes',()=>{
 const f=fixture();f.o.intel.push({...f.o.intel[1]!,player:2});
 const need={id:'defense',kind:'defense-pressure' as const,targets:[f.own.id],opponents:[1],evidence:{actualIncoming:[{id:'a',owner:1,drillers:300}],arrivalShortfall:50},limits:[]};
 const first=pressureReviewKey(f.snapshot,f.saved,[need],1);
 f.o.intel[2]!.numOutposts+=1;f.o.intel[2]!.npPerDay+=1;f.o.intel[0]!.numOutposts+=1;
 assert.equal(pressureReviewKey(f.snapshot,f.saved,[need],1),first);
 need.evidence.actualIncoming[0]!.id='replacement';assert.equal(pressureReviewKey(f.snapshot,f.saved,[need],1),first);
 need.evidence.actualIncoming[0]!.drillers=700;assert.notEqual(pressureReviewKey(f.snapshot,f.saved,[need],1),first);
});

test('a threatened receiver can be reinforced only when joint prediction confirms friendly delivery',()=>{
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup,template=setup.economy.outposts[0]!;
 setup.size={width:80,height:80};setup.match={mode:'domination',neptuniumGoal:200};
 const entries=[['receiver',0,1,0],['donor',0,100,.1],['enemy',1,90,.8],['rear',1,0,1.1]] as const;
 setup.positions=Object.fromEntries(entries.map(([id,_owner,_force,x])=>[id,{x,y:0}]));
 setup.economy.outposts=entries.map(([id,owner,drillers])=>({...template,id,owner,drillers,type:'generator',shield:id==='donor'?200:0,shieldMax:id==='donor'?200:0}));
 const game=submitFleetOrder(createFleetScenario(setup),{id:'enemy-attack',player:1,action:{kind:'launch',source:'enemy',destination:'receiver',drillers:60}}).state;
 const o=observation({state:game,scheduled:[]},0,'rescue-test'),saved=initialHybridState();
 assert.equal(commanderTransportUnsafe(o,'receiver'),true,'baseline really has a visible arrival deficit');
 applyIntentEdits(saved,{upsert:[{id:null,task:{kind:'transfer',source:'donor',target:'receiver',drillers:70,priority:100,until:240,reason:'救援'}}],cancel:[]},'model',0,o);
 reconcileIntents(o,saved,[]);assert.notEqual(saved.intents![0]!.status,'blocked');
 const routes=attackRoutes(o),candidates=configurationCandidates(o,routes,saved,[]);assert.equal(candidates.length,1);
 const decision=planBot(o,routes,{preludeCandidates:candidates,preludeIndependent:true,preludeOnly:true,horizonTicks:144,maxSimulations:12,maxElapsedMs:10000});
 assert.equal(decision.selected.objective,'transfer:intent-1',JSON.stringify(decision.assessments));assert.deepEqual(intentBindings(saved,decision.selected),[{id:'intent-1',version:1}]);
 // A convoy too small to save the receiver must still fail full path checks.
 const tooSmall=structuredClone(candidates);tooSmall[0]!.drafts[0]!.action.drillers=1;
 const rejected=planBot(o,routes,{preludeCandidates:tooSmall,preludeIndependent:true,preludeOnly:true,horizonTicks:144,maxSimulations:12,maxElapsedMs:10000});
 assert.equal(rejected.selected.kind,'hold');
});
