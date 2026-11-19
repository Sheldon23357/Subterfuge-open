import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {screenAttacks,screeningClass} from '../packages/ai/src/controller/analysis/attack-screening.js';
import {loadAttackScreeningConfig} from '../packages/ai/src/controller/analysis/attack-screening-config.js';
import {hybridPlanning} from '../plugins/hybrid/src/planning.js';
import {attackConclusions} from '../plugins/hybrid/src/attack-context.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';
import {initialHybridState} from '../plugins/hybrid/src/contracts.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {readPromptMaterial} from '../packages/contracts/src/prompt-sections.js';

test('model candidate reasons retain costs, mine consequences, route conditions and program ranking without score formulas',()=>{
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'planning-context');
 const report=screenAttacks(o,attackRoutes(o,{attackTicks:144,localTicks:144,holdTicks:24}),loadAttackScreeningConfig());
 const before=structuredClone(report),planning=hybridPlanning(o);
 assert.deepEqual(report,before);assert.deepEqual(planning.candidates.map(p=>p.target),report.ranked.slice(0,5).map(p=>p.target));
 assert.ok(planning.candidates.length>0);
 for(const c of planning.candidates){
  const p=report.ranked.find(p=>p.target===c.target)!;
  assert.equal(c.score,p.score);assert.equal(c.classification,screeningClass(p));assert.equal(c.attackWorldDays,p.timing.attackTicks);assert.equal(c.additionalForceEstimate,p.additionalForceEstimate);
  assert.deepEqual(c.launchSources,p.sources.map(s=>({source:s.id,availableEstimate:s.available,travelWorldDays:s.ticks})));
  assert.ok(c.reasons.some(r=>r.includes('预计防御成本'+p.defense.estimatedWithProductionAndShield)));
  assert.doesNotMatch(c.reasons.join(' '),/投资加分|折算|价值\d/);
  if(p.valueBreakdown.mineInvestment){assert.ok(c.reasons.some(r=>r.includes('节省自建'+p.valueBreakdown.mineInvestment!.replacementCost+'兵')&&r.includes('非保证收益')));}
 }
 assert.ok(report.ranked.some(p=>p.valueBreakdown.mineInvestment));
 assert.match(JSON.stringify(report),/投资加分/,'program diagnostics retain the full original score breakdown');
});

test('scoped attack conclusions preserve program verdicts and unknowns without routes, scores or source budgets',()=>{
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'attack-conclusions'),planning=hybridPlanning(o),before=structuredClone(planning);
 assert.equal(attackConclusions(planning,new Set()),undefined);
 const candidate=planning.candidates[0]!,summary=attackConclusions(planning,new Set([candidate.target]))!;
 assert.deepEqual(summary.targets,[{target:candidate.target,...candidate.assessment}]);
 assert.deepEqual(planning,before);
 for(const key of ['score','attackWorldDays','launchSources','forceSources','source','availableEstimate','suggestedUntil'])assert.ok(!Object.hasOwn(summary.targets[0]!,key),key);
 const excluded=attackConclusions({worldDay:10,candidates:[],excluded:[{target:'E',reason:'no-uncommitted-source-within-time-window'}]},new Set(['E']))!;
 assert.equal(excluded.targets[0]!.conclusion,'未形成可用进攻初筛方案');
 assert.deepEqual(excluded.targets[0]!.reasons,['当前窗口内没有未占用的出兵来源']);
 assert.match(summary.meaning,/初筛结论/);assert.match(summary.meaning,/不代表前台已选方案或实际执行/);
});

test('actual background prompts omit generic attacks and preserve full program estimates outside the model projection',()=>{
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'attack-prompt');
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const state=initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'}),saved=initialHybridState();
 for(const kind of ['strategy','diplomacy','commander'] as const){
  const m=makeBrief({id:kind,kind,scope:'overview',posts:[],messageIds:[],players:[]},state,snapshot,saved);
  const model=readPromptMaterial(m.prompt);
  assert.equal(model.global.planning,undefined,kind);assert.equal(model.global.attackAssessment,undefined,kind);
  assert.ok((m.brief.global as any).planning.candidates.rows.length>0);
  assert.ok((m.brief.global as any).planning.estimates.forceSources.rows.length>0);
 }
 const target=hybridPlanning(o).candidates[0]!.target;
 const scoped=makeBrief({id:'scoped',kind:'strategy',scope:'overview',posts:[target],messageIds:[],players:[]},state,snapshot,saved);
 const model=readPromptMaterial(scoped.prompt),assessment=model.global.attackAssessment;
 assert.deepEqual(assessment.targets.map((p:any)=>p.target),[o.outpostNames![target]]);
 assert.deepEqual(Object.keys(assessment.targets[0]).sort(),['conclusion','reasons','target']);
 assert.equal(model.global.planning,undefined);
 for(const key of ['forceSources','launchSources','launchSourceColumns','suggestedUntil'])assert.ok(!JSON.stringify(model).includes('"'+key+'"'),key);
 assert.equal(scoped.contextSelection.version,'round-material/9');
});
