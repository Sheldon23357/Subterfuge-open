import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {forecastKnownPath,attackRoutes} from '../packages/prediction/src/index.js';
import {botOpponentWeight,botAttackValue,botAttritionAllowed,botAttritionBenefitUpperBound} from '../packages/ai/src/controller/analysis/tactical-attack-value.js';
import {evaluateBotFrame} from '../packages/ai/src/controller/analysis/tactical-evaluation.js';
import {planBot,planBotAsync} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {executeBotForecast} from '../packages/ai/src/controller/analysis/tactical-forecast.js';
import {generateBotCandidates,type BotCandidate} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
import {botOpponentScenarios} from '../packages/ai/src/controller/analysis/tactical-opponents.js';
function fixture(distance=0.3){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 setup.match={mode:'mining',neptuniumGoal:200};setup.size={width:80,height:80};
 setup.positions['红方矿场']={x:distance,y:0};
 setup.economy.outposts[0]!.drillers=400;
 setup.economy.outposts[1]!.drillers=100;setup.economy.outposts[1]!.shield=0;setup.economy.outposts[1]!.shieldMax=0;
 setup.economy.players.push({active:true,neptunium:0,minesCreated:0});
 setup.economy.outposts.push({...setup.economy.outposts[2]!,id:'weak',owner:2});setup.positions.weak={x:30,y:30};
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'attack-value');
 Object.assign(o.intel.find(p=>p.player===1)!,{neptunium:180,npPerDay:14});
 Object.assign(o.intel.find(p=>p.player===2)!,{neptunium:0,npPerDay:1});
 const drafts=[{id:'raid',issueTick:o.view.tick,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:20}}];
 const forecast=forecastKnownPath(o,{targetTick:o.view.tick+10,drafts});
 assert.equal(forecast.forecast.status,'conditional');assert.ok(forecast.path);
 return {o,drafts,path:forecast.path!,frame:forecast.forecast.status==='conditional'?forecast.forecast.result:null!};
}
test('public rank and victory urgency raise pressure while a low-ranked distant threat is discounted',()=>{
 const {o}=fixture(),leader=botOpponentWeight(o,1),weak=botOpponentWeight(o,2);
 assert.ok(leader>1);assert.ok(weak<1);assert.ok(leader>weak);
 const ahead=structuredClone(o);Object.assign(ahead.intel.find(p=>p.player===0)!,{neptunium:199,npPerDay:100});
 assert.ok(botOpponentWeight(ahead,1)<leader,'rank includes our own standing');
 o.intel.find(p=>p.player===1)!.neptunium=199;assert.ok(botOpponentWeight(o,1)>leader);
 Object.assign(o.intel.find(p=>p.player===2)!,{neptunium:199,npPerDay:14});
 assert.equal(botOpponentWeight(o,1),botOpponentWeight(o,2),'ties do not favor player indices');
 assert.equal(botOpponentWeight(o,0),0);
});
test('a verified losing assault can earn bounded attrition without claiming a captured target',()=>{
 const f=fixture(),before=JSON.stringify(f.o),value=botAttackValue(f.o,f.path);
 assert.equal(f.frame.outposts.find(p=>p.id==='红方矿场')!.owner,1);
 assert.equal(value.ownLosses,20);assert.equal(value.enemyLosses,20);assert.ok(value.enemyAttrition>20);
 assert.ok(botAttritionAllowed(f.o,f.path,f.drafts));
 const score=evaluateBotFrame(f.o,f.frame,f.path);assert.equal(score.components.enemyAttrition,value.enemyAttrition);
 assert.equal(JSON.stringify(f.o),before);
});
test('weak opponents and poor exchanges cannot turn mere troop expenditure into profit',()=>{
 const f=fixture();Object.assign(f.o.intel.find(p=>p.player===2)!,{neptunium:199,npPerDay:100});
 const weighted=botAttackValue(f.o,f.path);assert.ok(weighted.enemyAttrition<20);
 assert.equal(botAttritionAllowed(f.o,f.path,f.drafts),false);
 const over=f.drafts.map(d=>({...d,action:{...d.action,drillers:101}}));assert.equal(botAttritionAllowed(f.o,f.path,over),false);
 const unrelated=f.drafts.map(d=>({...d,id:'unrelated'}));assert.equal(botAttritionAllowed(f.o,f.path,unrelated),false);
});
test('capacity pressure requires actual casualties, production and near-full total force including fleets',()=>{
 const f=fixture();f.o.view.self.capacity=f.o.view.self.drillers;
 const full=botAttackValue(f.o,f.path);assert.ok(full.capacityPressure>0);
 f.o.view.self.capacity=f.o.view.self.drillers-30;assert.equal(botAttackValue(f.o,f.path).capacityPressure,0,'losses that leave the army over capacity earn no freed-capacity credit');
 f.o.view.self.capacity=f.o.view.self.drillers*2;assert.equal(botAttackValue(f.o,f.path).capacityPressure,0);
 f.o.view.self.capacity=f.o.view.self.drillers;
 const empty={...f.path,events:[]};assert.equal(botAttackValue(f.o,empty).capacityPressure,0);
 for(const p of f.o.view.outposts)if(p.owner===0)p.type='generator';assert.equal(botAttackValue(f.o,f.path).capacityPressure,0);
});

test('a new sortie can verify attrition in an explicit enemy fleet interception',()=>{
 const f=fixture(),candidate:BotCandidate={id:'raid',kind:'attack',combatIntent:'attrition',objective:'attrition:红方矿场',targets:['红方矿场'],drafts:f.drafts,priority:0,reasons:[]};
 const scenario=botOpponentScenarios(f.o,attackRoutes(f.o),[candidate],10).find(s=>s.id==='counterattack')!;
 const projection=forecastKnownPath(f.o,{targetTick:f.o.view.tick+10,drafts:f.drafts,enemyLaunches:scenario.enemyLaunches!});
 const value=botAttackValue(f.o,projection.path,[],f.drafts);
 assert.equal(value.enemyLosses,20);assert.equal(value.ownLosses,20);
 assert.equal(value.jointPressure,0,'intercepting a fleet does not assert damage at the joint target');
 assert.ok(botAttritionAllowed(f.o,projection.path,f.drafts));
 const decision=planBot(f.o,attackRoutes(f.o),{validationCandidate:candidate,horizonTicks:10,maxSimulations:32,maxElapsedMs:10000});
 const raid=decision.assessments.find(a=>a.candidate.id==='raid')!,hold=decision.assessments.find(a=>a.candidate.id==='hold')!;
 assert.ok(raid.stress);
 const raidCase=raid.stressCases!.find(c=>c.id==='counterattack')!.score!,holdCase=hold.stressCases!.find(c=>c.id==='counterattack')!.score!;
 assert.equal(raidCase.components.enemyAttrition,holdCase.components.enemyAttrition,'enemy losses already achieved by holding must not be rewarded twice');
 assert.ok(raidCase.utility<holdCase.utility,'issuing the extra sortie still pays its commitment cost');
});
test('joint offensive credit needs an effective matching target and a real projected battle',()=>{
 const f=fixture(),joint=[{target:'红方矿场',until:200}];
 assert.ok(botAttackValue(f.o,f.path,joint).jointPressure>0);
 assert.equal(botAttackValue(f.o,f.path,[{target:'红方矿场',until:100}]).jointPressure,0);
 assert.equal(botAttackValue(f.o,f.path,[{target:'weak',until:200}]).jointPressure,0);
 assert.equal(botAttackValue(f.o,{...f.path,events:[]},joint).jointPressure,0);
});
test('unknown, stale and incomplete evidence or third-party fighting never supplies attrition credit',()=>{
 const f=fixture();
 for(const path of [{...f.path,basisRevision:'stale'},{...f.path,coverage:{...f.path.coverage,complete:false}},{...f.path,events:f.path.events.map(e=>({...e,details:{...e.details,attackerOwner:2}}))},{...f.path,events:f.path.events.map(e=>({...e,details:{...e.details,target:'unseen'}}))}])assert.equal(botAttackValue(f.o,path).enemyAttrition,0);
 const shields={...f.path,events:f.path.events.map(e=>e.kind==='battle'?{...e,details:{...e.details,defender:e.details.defenderBefore??0}}:e)};
 assert.equal(botAttritionAllowed(f.o,shields,f.drafts),false);
});
test('a bounded raid participates in selection while the same failed capture remains invalid',()=>{
 const f=fixture(0.03),routes=attackRoutes(f.o),raid:BotCandidate={id:'raid',kind:'attack',combatIntent:'attrition',objective:'attrition:红方矿场',targets:['红方矿场'],drafts:f.drafts,priority:0,reasons:[]};
 const decision=planBot(f.o,routes,{validationCandidate:raid,horizonTicks:10,maxSimulations:32,maxElapsedMs:10000});
 assert.equal(decision.selected.objective,raid.objective,JSON.stringify(decision.assessments.map(a=>({id:a.candidate.id,reasons:a.reasons,score:a.score?.utility,stress:a.stress?.utility}))));
 const {combatIntent:_,...ordinary}=raid;
 const capture={...ordinary,id:'capture',objective:'capture:红方矿场',captureTargets:['红方矿场']};
 const denied=planBot(f.o,routes,{validationCandidate:capture,horizonTicks:10,maxSimulations:32,maxElapsedMs:10000});
 assert.equal(denied.selected.id,'hold');
 assert.ok(denied.assessments.some(a=>a.candidate.id==='capture'&&a.status==='invalid'));
 const forbidden=planBot(f.o,routes,{validationCandidate:raid,horizonTicks:10,maxSimulations:32,maxElapsedMs:10000,guidance:{forbiddenPlayers:[1],protectedSources:[],reserves:[],objectives:[],rotation:0}});
 assert.equal(forbidden.selected.id,'hold');
});
test('generated raids remain distinct from capture interpretations and use the existing search budget',()=>{
 const f=fixture(),rows=generateBotCandidates(f.o,attackRoutes(f.o)),raids=rows.filter(c=>c.combatIntent==='attrition');
 assert.ok(raids.length>0);assert.ok(raids.every(c=>!c.captureTargets?.length));
 for(const r of raids)assert.ok(r.drafts.reduce((n,d)=>n+Number(d.action.drillers),0)<=Math.floor(f.o.view.self.drillers*.25));
 const limited=planBot(f.o,attackRoutes(f.o),{maxSimulations:2,maxElapsedMs:10000});assert.ok(limited.coverage.simulations<=2);
});

test('raid bound preserves profitable raids, en-route opponents and active joint credit',()=>{
 const f=fixture();
 assert.ok(botAttritionBenefitUpperBound(f.o,f.drafts)>2);
 assert.ok(botAttritionAllowed(f.o,f.path,f.drafts));
 Object.assign(f.o.intel.find(p=>p.player===2)!,{neptunium:199,npPerDay:100});
 assert.ok(botAttritionBenefitUpperBound(f.o,f.drafts)>2,'another enemy can be intercepted en route; target weight alone is unsafe');
 const ordinary=botAttritionBenefitUpperBound(f.o,f.drafts);
 assert.ok(botAttritionBenefitUpperBound(f.o,f.drafts,[{target:'红方矿场',until:f.o.view.tick+1}])>ordinary);
 assert.equal(botAttritionBenefitUpperBound(f.o,f.drafts,[{target:'红方矿场',until:f.o.view.tick}]),ordinary);
 assert.equal(botAttritionBenefitUpperBound(f.o,f.drafts.map(d=>({...d,action:{...d.action,fleetId:'existing'}}))),Infinity);
});

test('a provably unprofitable raid never uses a forecast slot',async()=>{
 const f=fixture();Object.assign(f.o.intel.find(p=>p.player===0)!,{neptunium:199,npPerDay:100});
 f.o.view.self.capacity=f.o.view.self.drillers*2;
 assert.equal(botAttritionBenefitUpperBound(f.o,f.drafts),0);
 assert.equal(botAttritionAllowed(f.o,f.path,f.drafts),false);
 const candidate:BotCandidate={id:'bounded-raid',kind:'attack',combatIntent:'attrition',objective:'attrition:红方矿场',targets:['红方矿场'],drafts:f.drafts,priority:0,reasons:[]};
 let raidForecasts=0;
 const d=await planBotAsync(f.o,attackRoutes(f.o),{validationCandidate:candidate,maxSimulations:32,maxElapsedMs:10000,horizonTicks:10},async requests=>requests.map(request=>{if(request.drafts?.some(d=>d.id==='raid'))raidForecasts++;return executeBotForecast(f.o,request);}));
 const a=d.assessments.find(a=>a.candidate.id===candidate.id)!;
 assert.equal(a.status,'invalid');assert.deepEqual(a.reasons,['attrition-benefit-upper-bound']);
 assert.equal(raidForecasts,0,'hold and its reaction cases are still verified, but the rejected sortie is never simulated');
 assert.equal((d.policyDiagnostics!.searchEfficiency as {attritionUpperBoundStops:number}).attritionUpperBoundStops,1);
});
