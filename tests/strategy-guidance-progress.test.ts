import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {forecastKnownPath,type KnownPathEvidence} from '../packages/prediction/src/index.js';
import {strategicProgress} from '../packages/ai/src/controller/analysis/strategic-progress.js';
import {tacticalGuidanceAllows} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {constraints,operationGuidance} from '../plugins/hybrid/src/operations.js';
import {initialHybridState,basisOf,type StrategicDirective,type StrategicAssessment} from '../plugins/hybrid/src/contracts.js';
import {reconcileStrategy,currentObjectives} from '../plugins/hybrid/src/strategy-freshness.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
function fixture(){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup,t=c.economy.outposts[0]!;
 c.match={mode:'mining',neptuniumGoal:200};c.size={width:80,height:80};c.economy.initialTick=20;
 c.economy.players=[0,1].map(()=>({active:true,neptunium:0,minesCreated:0}));
 c.economy.outposts=[['home',0],['repair',0],['claim',null],['enemy',1]].map(([id,owner])=>({...t,id:String(id),owner:owner as number|null,type:'generator',drillers:20,shield:0,shieldMax:0}));
 c.positions={home:{x:0,y:0},repair:{x:.3,y:0},claim:{x:2,y:0},enemy:{x:30,y:30}};

 const o=observation({state:createFleetScenario(c),scheduled:[]},0,'strategic-progress');
 const forecast=forecastKnownPath(o,{targetTick:120});assert.ok(forecast.path);
 const d:StrategicDirective={version:1,basis:basisOf(o),summary:'先守备再扩张',summaryBasis:basisOf(o),objectives:[{id:'overview:claim',kind:'capture',targets:['claim'],priority:94,reason:'扩大领土'}],forbiddenPlayers:[],protectedSources:['home'],reserves:[],reviewOn:[],commanderVersion:0,commanderConstraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]},agreements:[]};
 return {o,path:forecast.path!,d};
}

test('strategic reward depends on extra control time, never repeated goal matching',()=>{
 const {o,path}=fixture(),goals=[{kind:'capture',targets:['claim'],priority:94}];
 const baseline:KnownPathEvidence={...path,actualTargetTick:120,events:[{tick:41,fraction:0,sequence:1,kind:'outpost-captured',subject:'claim',details:{before:null,owner:0}}]};
 const duplicate=structuredClone(baseline);
 duplicate.events.push({tick:70,fraction:0,sequence:2,kind:'unloaded',subject:'one-more-troop',details:{outpost:'claim',owner:0}});
 const before=strategicProgress(o,baseline,goals,100),after=strategicProgress(o,duplicate,goals,100);
 assert.deepEqual(after,before);assert.equal(Object.values(after)[0],37.6);
 const sooner=structuredClone(baseline);sooner.events[0]!.tick=31;
 assert.ok(Math.abs(Object.values(strategicProgress(o,sooner,goals,100))[0]!-Object.values(before)[0]!-4.7)<1e-9);
 assert.deepEqual(strategicProgress(o,duplicate,[...goals,...goals,{...goals[0]!,kind:'expand'}],100),after);
 assert.deepEqual(strategicProgress(o,{...duplicate,basisRevision:'stale'},goals,100),{});
});

test('mine and defense credit use completed construction and continuous conditional holding',()=>{
 const {o,path}=fixture(),goals=[{kind:'mine',targets:['repair'],priority:100}];
 const pending={...path,actualTargetTick:120,events:[]};assert.equal(Object.values(strategicProgress(o,pending,goals,100))[0],0);
 const built={...pending,events:[{tick:41,fraction:0,sequence:1,kind:'mine-created',subject:'repair',details:{owner:0}}]};
 assert.equal(Object.values(strategicProgress(o,built,goals,100))[0],40);
 const lost={...pending,events:[{tick:71,fraction:0,sequence:1,kind:'outpost-captured',subject:'repair',details:{before:0,owner:1}}]};
 assert.equal(Object.values(strategicProgress(o,lost,[{kind:'defend',targets:['repair'],priority:100}],100))[0],25);
});

test('current facts retire completed goals while strategic prose keeps its original basis',()=>{
 const {o,d}=fixture(),saved=initialHybridState();
 const assessment:StrategicAssessment={summary:'为首矿集结',objectives:[],forbiddenPlayers:[],protectedSources:['home'],reserves:[],reviewOn:[],message:null,agreement:{status:'none',summary:'',forbidAttack:false,forbiddenTargets:[],internalIntent:'',expiresWorldDay:null}};
 saved.directive=d;d.commanderConstraints.protectedSources=['home'];
 d.objectives.push({id:'overview:mine',kind:'mine',targets:['repair'],priority:80,reason:'集结'});
 saved.assessments={overview:assessment};saved.assessmentDependencies={overview:{basis:basisOf(o),posts:['repair','claim']}};
 const ordinary=structuredClone(o);ordinary.view.outposts.find(p=>p.id==='repair')!.drillers!+=2;ordinary.revision='new-production';ordinary.view.tick++;
 assert.equal(reconcileStrategy(ordinary,saved),false);assert.equal(saved.directive.summaryBasis?.revision,o.revision);
 const built=structuredClone(ordinary);built.view.outposts.find(p=>p.id==='repair')!.type='mine';
 assert.equal(reconcileStrategy(built,saved),true);assert.equal(saved.directive.summary,'先守备再扩张');assert.equal(saved.directive.summaryBasis?.revision,o.revision);assert.deepEqual(saved.directive.objectives.map(g=>g.id),['overview:claim']);assert.equal(saved.assessments.overview,assessment);
 assert.deepEqual(saved.directive.commanderConstraints.protectedSources,['home']);
 assert.deepEqual(currentObjectives(built,[{id:'old',kind:'mine',targets:['repair'],priority:80,reason:'old'}]),[]);
});
