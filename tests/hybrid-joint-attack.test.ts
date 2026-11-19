import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {initialHybridState,basisOf,type Agreement,type StrategicDirective} from '../plugins/hybrid/src/contracts.js';
import {jointAttackGuidance} from '../plugins/hybrid/src/joint-attack.js';
import {operationGuidance} from '../plugins/hybrid/src/operations.js';
import {generateBotCandidates} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
import {createOutpostRiskAnalysis} from '../packages/ai/src/controller/analysis/outpost-risk.js';
import {intentSchemaFor,parseIntentResult} from '../plugins/hybrid/src/intent-protocol.js';
function fixture(){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 c.economy.players.push({active:true,neptunium:0,minesCreated:0});
 c.economy.outposts.push({...c.economy.outposts[2]!,id:'盟友基地',owner:2});c.positions['盟友基地']={x:5,y:5};
 let game=createFleetScenario(c);
 game=submitFleetOrder(game,{id:'joint',player:0,action:{kind:'propose-agreement',peer:2,terms:{kind:'joint-attack',enemy:1},subsidy:null,counterTo:null}}).state;
 game=submitFleetOrder(game,{id:'accept',player:2,action:{kind:'respond-agreement',agreementId:'joint',response:'accept'}}).state;
 const o=observation({state:game,scheduled:[]},0,'joint-tests');
 const agreement:Agreement={conversation:'2',players:[2],status:'confirmed',summary:'一起从两侧打红方',forbidAttack:false,forbiddenTargets:[],internalIntent:'真诚共同进攻',expiresWorldDay:null,evidence:['offer','accept'],tick:100,jointAttack:{enemy:1,until:160}};
 const d:StrategicDirective={version:1,basis:basisOf(o),summary:'',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],commanderVersion:0,commanderConstraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]},agreements:[agreement]};
 return {o,d,agreement:o.diplomacy!.agreements[0]!,game};
}
test('only an active outstanding personal obligation creates server joint goals',()=>{
 const f=fixture();assert.ok(jointAttackGuidance(f.o,f.d).objectives.length);
 for(const status of ['proposed','completed','unfulfilled','expired','terminated','violated','rejected','withdrawn','superseded'] as const){f.agreement.status=status;assert.deepEqual(jointAttackGuidance(f.o,f.d).objectives,[]);}
 f.agreement.status='active';f.agreement.fulfilled[0]=true;assert.deepEqual(jointAttackGuidance(f.o,f.d).objectives,[]);
 f.agreement.fulfilled[0]=false;f.o.view.tick=f.agreement.deadline;assert.deepEqual(jointAttackGuidance(f.o,f.d).objectives,[]);
});

test('joint attacks never discount allies, own posts, unknown garrisons or a different enemy',()=>{
 const f=fixture(),target=f.o.view.outposts.find(p=>p.id==='红方矿场')!;
 for(const enemy of [0,2]){if(f.agreement.terms.kind==='joint-attack')f.agreement.terms.enemy=enemy;assert.deepEqual(jointAttackGuidance(f.o,f.d).attackDefenseFactors,[]);}
 if(f.agreement.terms.kind==='joint-attack')f.agreement.terms.enemy=1;target.visibility=0;
 assert.ok(!jointAttackGuidance(f.o,f.d).attackDefenseFactors.some(p=>p.target===target.id));
 target.visibility=2;target.owner=2;assert.ok(!jointAttackGuidance(f.o,f.d).attackDefenseFactors.some(p=>p.target===target.id));
 f.o.intel.find(p=>p.player===2)!.active=false;assert.deepEqual(jointAttackGuidance(f.o,f.d).attackDefenseFactors,[]);
});
test('overlapping allied agreements keep only two nearby targets for one enemy and grant no phantom aid',()=>{
 const f=fixture();f.o.diplomacy!.agreements.push({...structuredClone(f.agreement),id:'another'});
 for(let i=0;i<15;i++)f.o.view.outposts.push({...f.o.view.outposts.find(p=>p.id==='红方矿场')!,id:'远点'+i,position:{x:4+i/100,y:4}});
 const joint=jointAttackGuidance(f.o,f.d);assert.deepEqual(joint.attackDefenseFactors,[]);assert.equal(joint.objectives.length,2);
 assert.equal(joint.objectives[0]!.targets[0],'红方矿场');
 const g=operationGuidance(f.o,f.d,[],0,initialHybridState())!;assert.deepEqual(g.attackDefenseFactors,[]);assert.equal(g.objectives.length,2);
});
test('signing alone does not lower required attacking force or change observed troops',()=>{
 const f=fixture(),routes=attackRoutes(f.o),risk=createOutpostRiskAnalysis(f.o,undefined,routes),before=structuredClone(f.o);
 const ordinary=generateBotCandidates(f.o,routes,[],0,risk,['红方矿场']);
 const g=jointAttackGuidance(f.o,f.d),joint=generateBotCandidates(f.o,routes,[],0,risk,g.objectives.flatMap(x=>x.targets),g.attackDefenseFactors);
 const base=ordinary.find(c=>c.objective==='capture:红方矿场'&&c.forceEstimate)!,discount=joint.find(c=>c.objective==='capture:红方矿场'&&c.forceEstimate)!;
 assert.equal(discount.forceEstimate!.required,base.forceEstimate!.required);
 assert.equal(discount.forceEstimate!.defenseFactor,undefined);
 assert.deepEqual(f.o,before);assert.ok(!discount.reasons.join().includes('60%'));
});

test('the accepting side receives an explicit own attack obligation instead of waiting for the proposer',()=>{
 const f=fixture();f.agreement.players=[2,0];f.agreement.progress=[1,0];f.agreement.fulfilled=[true,false];
 const goals=jointAttackGuidance(f.o,f.d).objectives;
 assert.ok(goals.length);assert.equal(goals[0]!.priority,90);assert.match(goals[0]!.reason,/本人已接受/);assert.match(goals[0]!.reason,/实际占领该敌人的任意一个据点/);assert.match(goals[0]!.reason,/不等待盟友先动/);
 assert.deepEqual(jointAttackGuidance(f.o,f.d).attackDefenseFactors,[]);
 f.agreement.fulfilled[1]=true;assert.deepEqual(jointAttackGuidance(f.o,f.d).objectives,[]);
});
test('joint offensive wire data is exact and distinct from ordinary diplomacy or deception',()=>{
 const schema=intentSchemaFor('diplomacy',[]);assert.ok(!schema.properties.agreement.required.includes('jointAttack'));assert.ok(schema.properties.agreement.required.includes('fulfillment'));
 const wire={summary:'两线进攻',tasks:{upsert:[],cancel:[]},reviewOn:[],message:'行，160日前一起打红方。',agreement:{fulfillment:'rules',status:'confirmed',summary:'两线进攻',forbidAttack:false,forbiddenTargets:[],internalIntent:'真实出击',expiresWorldDay:null,jointAttack:{enemy:1,until:160}}};
 assert.deepEqual(parseIntentResult(wire,'diplomacy',3,new Set()).agreement.jointAttack,{enemy:1,until:160});
 assert.throws(()=>parseIntentResult({...wire,agreement:{...wire.agreement,jointAttack:{enemy:3,until:160}}},'diplomacy',3,new Set()),/joint attack/);
 assert.equal(parseIntentResult({...wire,agreement:{...wire.agreement,fulfillment:'deception',internalIntent:'假意接受，不参战',jointAttack:null}},'diplomacy',3,new Set()).agreement.jointAttack,null);
});

test('an attack arriving after the cooperation window uses the full defense estimate',()=>{
 const f=fixture();f.agreement.deadline=100.1;
 const routes=attackRoutes(f.o),risk=createOutpostRiskAnalysis(f.o,undefined,routes),joint=jointAttackGuidance(f.o,f.d);
 const baseline=generateBotCandidates(f.o,routes,[],0,risk,['红方矿场']).find(c=>c.objective==='capture:红方矿场'&&c.forceEstimate)!;
 const late=generateBotCandidates(f.o,routes,[],0,risk,['红方矿场'],joint.attackDefenseFactors).find(c=>c.objective==='capture:红方矿场'&&c.forceEstimate)!;
 assert.equal(late.forceEstimate!.required,baseline.forceEstimate!.required);assert.equal(late.forceEstimate!.defenseFactor,undefined);
});
