import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes,forecastKnownPath} from '../packages/prediction/src/index.js';
import {openingExpansion} from '../packages/ai/src/controller/analysis/opening-expansion.js';
import {generateBotCandidates} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
import {botOpponentScenarios} from '../packages/ai/src/controller/analysis/tactical-opponents.js';
import {planBot} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {planBot as programmaticPlan} from '../packages/ai/src/controller/local/bot-planner.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {initialHybridState,basisOf,type TacticalFeedback} from '../plugins/hybrid/src/contracts.js';
import {diplomacyNeeds,updateDiplomacyPressure} from '../plugins/hybrid/src/diplomacy-pressure.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';
import {readPromptMaterial} from '../packages/contracts/src/prompt-sections.js';
function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:60,height:60};cfg.match={mode:'mining',neptuniumGoal:200};cfg.economy.initialTick=0;
 cfg.economy.players=[{active:true,neptunium:0,minesCreated:0},{active:true,neptunium:0,minesCreated:0}];
 const entries=[['home',0,80,0],['backup',0,40,.4],['near',null,0,.8],['near2',null,0,1.2],['tie',null,0,2.2],['away',null,0,3.8],['enemy',1,40,4]] as const;
 cfg.positions=Object.fromEntries(entries.map(([id,_owner,_drillers,x])=>[id,{x,y:0}]));
 cfg.economy.outposts=entries.map(([id,owner,drillers])=>({...cfg.economy.outposts[0]!,id,owner,drillers,type:'generator',shield:0,shieldMax:10}));
 const world=createFleetScenario(cfg),o=observation({state:world,scheduled:[]},0,'opening-test');
 return {world,o,routes:attackRoutes(o)};
}
test('opening partition uses wrapped public geometry and keeps unknown competitors explicit',()=>{
 const {o}=fixture(),before=structuredClone(o),report=openingExpansion(o);
 assert.equal(report.targets.find(t=>t.id==='near')!.zone,'own-near');
 assert.equal(report.targets.find(t=>t.id==='tie')!.zone,'contested');
 assert.equal(report.targets.find(t=>t.id==='away')!.zone,'rival-near');
 assert.deepEqual(o,before);
 const hidden=structuredClone(o),enemy=hidden.view.outposts.find(p=>p.id==='enemy')!;enemy.visibility=0;delete enemy.drillers;
 assert.equal(openingExpansion(hidden).targets.find(t=>t.id==='away')!.competitionForce,null);
 const cautious=generateBotCandidates(hidden,attackRoutes(hidden)).find(c=>c.objective==='capture:away'&&c.forceEstimate)!;
 assert.ok(cautious.forceEstimate!.required>1,'unknown rival forces must not turn the contested seed into an empty one-driller claim');
 delete enemy.owner;
 assert.equal(openingExpansion(hidden).targets.find(t=>t.id==='away')!.zone,'unknown');
 const wrapped=structuredClone(o);wrapped.view.outposts.find(p=>p.id==='home')!.position={x:29.5,y:0};wrapped.view.outposts.find(p=>p.id==='near')!.position={x:-29.5,y:0};
 assert.equal(openingExpansion(wrapped).targets.find(t=>t.id==='near')!.ownDistance,1);
 o.view.tick=144;assert.equal(openingExpansion(o).active,false);
});
test('actual model briefs shorten opening distances after exact geometry classification and preserve the publication guard',()=>{
 const {o}=fixture();o.view.outposts.find(p=>p.id==='tie')!.position={x:2.234567891,y:.765432109};
 const before=structuredClone(o),s=initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'}),snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const result=makeBrief({id:'opening',kind:'strategy',scope:'overview',posts:[],messageIds:[],players:[]},s,snapshot,initialHybridState()),model=readPromptMaterial(result.prompt),full=(result.brief.global as any).opening;
 const own=full.columns.indexOf('ownDistance'),rival=full.columns.indexOf('rivalDistance');
 assert.deepEqual(o,before);assert.deepEqual(model,JSON.parse(JSON.stringify(result.modelBrief)));
 assert.deepEqual(model.global.opening.columns,full.columns);assert.equal(model.global.opening.rows.length,full.rows.length);
 for(let i=0;i<full.rows.length;i++)for(let j=0;j<full.columns.length;j++){
  if([own,rival].includes(j)&&typeof full.rows[i][j]==='number')assert.ok(Math.abs(model.global.opening.rows[i][j]-full.rows[i][j])<=.000500001);
  else assert.deepEqual(model.global.opening.rows[i][j],full.rows[i][j]);
 }
 assert.ok(result.contextSelection.numericPresentation.some(c=>c.path.includes('opening')&&c.before!==c.after));
 assert.ok(full.rows.some((r:any[])=>String(r[own]).length>10),'full precision survives in the guard');
});
test('opening cover allocates distinct home-side targets with one source budget and larger contested seeds',()=>{
 const {o,routes}=fixture(),candidates=generateBotCandidates(o,routes),cover=candidates.find(c=>c.objective.startsWith('opening-cover:'))!;
 assert.ok(cover);assert.ok(cover.targets.includes('near'));assert.ok(cover.targets.includes('near2'));assert.ok(!cover.targets.includes('away'));
 assert.equal(new Set(cover.targets).size,cover.targets.length);
 const spent=new Map<string,number>();for(const d of cover.drafts){const source=String(d.action.source);spent.set(source,(spent.get(source)??0)+Number(d.action.drillers));}
 for(const [source,force] of spent)assert.ok(force<=o.view.outposts.find(p=>p.id===source)!.drillers!);
 const own=candidates.find(c=>c.objective==='capture:near'&&c.forceEstimate)!,enemy=candidates.find(c=>c.objective==='capture:away'&&c.forceEstimate)!;
 assert.ok(enemy.forceEstimate!.required>own.forceEstimate!.required);
 assert.ok(own.priority>enemy.priority);
});
test('a sufficient friendly fleet covers a neutral without turning it into an already owned post',()=>{
 const {world}=fixture(),state=submitFleetOrder(world,{id:'existing',player:0,action:{kind:'launch',source:'home',destination:'near',drillers:3}}).state;
 const o=observation({state,scheduled:[]},0,'opening-covered'),r=openingExpansion(o).targets.find(t=>t.id==='near')!;
 assert.equal(r.covered,true);assert.equal(o.view.outposts.find(p=>p.id==='near')!.owner,null);
 const cover=generateBotCandidates(o,attackRoutes(o)).find(c=>c.objective.startsWith('opening-cover:'));
 assert.ok(!cover?.targets.includes('near'));assert.ok(cover?.targets.includes('near2'));
});
for(const [label,planner]of [['hybrid',planBot],['programmatic',programmaticPlan]] as const)test(`${label} prioritizes validated home-side coverage in the opening`,()=>{
 const {o,routes}=fixture();
 // Isolate coverage preference among valid claims. Armed rival retakes are
 // tested separately; a thin claim that fails holding must not be forced here.
 o.view.outposts.find(p=>p.id==='enemy')!.drillers=0;
 const before=structuredClone(o),d=planner(o,routes,{maxSimulations:96,maxElapsedMs:30000});
 assert.ok(d.selected.captureTargets?.includes('near'),JSON.stringify(d.selected));
 assert.ok(d.selected.captureTargets?.includes('near2'),JSON.stringify(d.selected));
 const forecast=forecastKnownPath(o,{targetTick:144,drafts:d.selected.drafts});
 assert.equal(forecast.forecast.status,'conditional');
 if(forecast.forecast.status==='conditional')assert.equal(forecast.forecast.result.outposts.find(p=>p.id==='near')!.owner,0);
 assert.deepEqual(o,before);
});
test('rival-side claims are independent forecast scenarios and can prompt a conditional diplomatic review',()=>{
 const {o,routes}=fixture(),candidates=generateBotCandidates(o,routes),candidate=candidates.find(c=>c.objective==='capture:away')!;
 const scenarios=botOpponentScenarios(o,routes,[candidate]);
 assert.ok(scenarios.some(s=>s.id==='opening-rival-claim'&&s.enemyLaunches?.[0]?.destination==='away'));
 assert.equal(o.view.outposts.find(p=>p.id==='away')!.owner,null);
 const d=planBot(o,routes,{maxSimulations:50,maxElapsedMs:30000});d.selected=candidate;
 const state=initialHybridState(),needs=diplomacyNeeds(o,d,state,[]),need=needs.find(n=>n.kind==='opening-contest')!;assert.ok(need);
 const feedback:TacticalFeedback={basis:basisOf(o),strategyVersion:0,coverage:d.coverage,objects:[],proposals:[],selected:candidate.objective,limitations:[],diplomacyNeeds:needs};
 assert.ok(updateDiplomacyPressure(state,feedback,o,0).some(n=>n.kind==='opening-contest'));
 o.view.outposts.find(p=>p.id==='away')!.owner=1;
 assert.ok(!updateDiplomacyPressure(state,feedback,o,0).some(n=>n.kind==='opening-contest'));
});
test('hybrid briefing separates neutral ownership facts from rival-occupation assumptions',()=>{
 const {o}=fixture(),s=initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'});
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const brief=makeBrief({id:'opening',kind:'strategy',scope:'overview',posts:['near','away'],messageIds:[],players:[]},s,snapshot,initialHybridState());
 assert.ok((brief.brief.global as {opening:unknown}).opening);
 assert.match(brief.prompt,/不是精确ETA或归属保证/);assert.equal(o.view.outposts.find(p=>p.id==='away')!.owner,null);
});
