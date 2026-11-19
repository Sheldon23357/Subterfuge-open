import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {planBot,planBotAsync} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {botCaptureSubplan} from '../packages/ai/src/controller/analysis/tactical-combinations.js';
import {executeBotForecast} from '../packages/ai/src/controller/analysis/tactical-forecast.js';
import type {BotCandidate} from '../packages/ai/src/controller/analysis/tactical-candidates.js';

function fixture(){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup,t=c.economy.outposts[0]!;
 c.size={width:80,height:80};c.match={mode:'mining',neptuniumGoal:200};c.economy.initialTick=0;
 c.economy.players=[0,1].map(()=>({active:true,neptunium:0,minesCreated:0}));
 const posts=[{id:'home',owner:0,drillers:40,x:0,shield:100},{id:'risky',owner:null,drillers:0,x:3,shield:0},{id:'safe',owner:null,drillers:0,x:-5,shield:0},{id:'enemy',owner:1,drillers:80,x:4,shield:0}];
 c.positions=Object.fromEntries(posts.map(p=>[p.id,{x:p.x,y:0}]));
 c.economy.outposts=posts.map(p=>({...t,id:p.id,owner:p.owner,drillers:p.drillers,type:'generator',shield:p.shield,shieldMax:p.shield,productionProgress:0,miningProgress:0}));
 const o=observation({state:createFleetScenario(c),scheduled:[]},0,'capture-subplan');
 const bundle:BotCandidate={id:'bundle',kind:'combined',objective:'capture:risky+capture:safe',targets:['risky','safe'],captureTargets:['risky','safe'],priority:50,reasons:[],forceEstimate:{committed:4,required:4},forceSizing:{testedMinimum:2,bufferedForce:2,margin:0,search:'bounded-proportional',basis:'largest-launch'},drafts:['risky','safe'].map((destination,i)=>({id:'claim-'+i,issueTick:0,action:{kind:'launch',source:'home',destination,drillers:2}}))};
 return {o,bundle,routes:attackRoutes(o)};
}

test('a risky component cannot freeze an independently verified safe capture subplan',()=>{
 const {o,bundle,routes}=fixture(),before=structuredClone(o);
 const d=planBot(o,routes,{preludeCandidates:[bundle],preludeOnly:true,maxSimulations:80,maxElapsedMs:60000});
 assert.ok(d.selected.id.startsWith('subplan:'));assert.deepEqual(d.selected.captureTargets,['safe']);
 const original=d.assessments.find(a=>d.selected.id.startsWith('subplan:'+a.candidate.id+':')&&a.stressCases)!,chosen=d.assessments.find(a=>a.candidate.id===d.selected.id)!;
 assert.ok(original.reasons.some(r=>r.includes('risky')&&r.includes('未能保持占领')),'the full bundle really fails a retake, despite positive ordinary utility');
 assert.deepEqual(d.selected.drafts.map(d=>d.action),original.candidate.drafts.filter(d=>d.action.destination==='safe').map(d=>d.action));
 assert.ok(chosen.score&&chosen.stress);assert.deepEqual(chosen.stressCases!.map(c=>c.id),original.stressCases!.map(c=>c.id),'all original scenarios still run');
 assert.ok(chosen.stressCases!.every(c=>c.status==='evaluated'));assert.ok(!chosen.reasons.some(r=>r.includes('未能保持占领')||r.includes('新增失矿')));
 assert.equal(d.selected.forceEstimate,undefined,'discard the original bundle force estimates');assert.equal(d.selected.forceSizing,undefined);
 assert.ok(d.coverage.simulations<=80);assert.deepEqual(o,before);
});

test('subplan recovery never changes an exact execution validation proposal or exceeds its budget',()=>{
 const {o,bundle,routes}=fixture();
 const validation=planBot(o,routes,{validationCandidate:bundle,maxSimulations:80,maxElapsedMs:60000});
 assert.equal(validation.selected.id,'hold');assert.ok(!validation.assessments.some(a=>a.candidate.id.startsWith('subplan:')));
 const tiny=planBot(o,routes,{preludeCandidates:[bundle],preludeOnly:true,maxSimulations:6,maxElapsedMs:60000});
 assert.equal(tiny.selected.id,'hold');assert.ok(tiny.coverage.simulations<=6);
});

test('unknown subplan stress results cannot inherit the original score or become executable',async()=>{
 const {o,bundle,routes}=fixture();
 const d=await planBotAsync(o,routes,{preludeCandidates:[bundle],preludeOnly:true,maxSimulations:80,maxElapsedMs:60000},async requests=>requests.map(r=>r.drafts?.length===1&&r.drafts[0]!.action.destination==='safe'&&!r.predicates?{kind:'error' as const,message:'incomplete hypothetical branch'}:executeBotForecast(o,r)));
 const subplan=d.assessments.find(a=>a.candidate.id.startsWith('subplan:'))!;
 assert.ok(subplan?.score);assert.equal(subplan.stress,null);assert.ok(subplan.reasons.includes('压力测试覆盖不完整，不采用此方案'));assert.equal(d.selected.id,'hold');
});

test('splitting preserves all waves of a kept target and refuses dependent or mixed action bundles',()=>{
 const {o,bundle}=fixture(),before=structuredClone(bundle);bundle.drafts.push({...bundle.drafts[1]!,id:'second-source',action:{...bundle.drafts[1]!.action,source:'another-home'}});
 assert.equal(botCaptureSubplan(o,bundle,new Set(['risky']))!.drafts.length,2,'no individual wave of a target is dropped');
 for(const variant of [
  {...bundle,combatIntent:'attrition' as const},
  {...bundle,drafts:[...bundle.drafts,{id:'build',issueTick:0,action:{kind:'toggle-mine',outpostId:'home'}}]},
  {...bundle,drafts:bundle.drafts.map(d=>({...d,issueTick:1}))},
  {...bundle,drafts:[...bundle.drafts,{id:'transport',issueTick:0,action:{kind:'launch',source:'home',destination:'another-home',drillers:2}}]},
 ])assert.equal(botCaptureSubplan(o,variant,new Set(['risky'])),null);
 assert.equal(botCaptureSubplan(o,bundle,new Set(['risky','safe'])),null);assert.equal(botCaptureSubplan(o,bundle,new Set(['unknown'])),null);
 assert.deepEqual(bundle.drafts.slice(0,2),before.drafts,'the original exact actions are intact');
});
