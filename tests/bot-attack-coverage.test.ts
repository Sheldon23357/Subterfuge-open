import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {generateBotCandidates} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
import {forecastKnownPath} from '../packages/prediction/src/index.js';

type Post={id:string;owner:number;drillers:number;x:number};
function fixture(posts:Post[],tick=300){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 c.match={mode:'mining',neptuniumGoal:200};c.size={width:80,height:80};c.economy.initialTick=tick;
 c.positions=Object.fromEntries(posts.map(p=>[p.id,{x:p.x,y:0}]));
 c.economy.players=Array.from({length:Math.max(2,...posts.map(p=>p.owner+1))},()=>({active:true,neptunium:0,minesCreated:2}));
 c.economy.outposts=posts.map(p=>({...c.economy.outposts[2]!,id:p.id,owner:p.owner,drillers:p.drillers,type:'generator',shield:0,shieldMax:0}));

 return observation({state:createFleetScenario(c),scheduled:[]},0,'attack-coverage');
}
const launch=(c:ReturnType<typeof generateBotCandidates>[number],source:string,target:string)=>c.drafts.length===1&&c.drafts[0]!.action.kind==='launch'&&c.drafts[0]!.action.source===source&&c.drafts[0]!.action.destination===target;

test('direct-source cap retains a force-strong fifth source without exceeding four sources',()=>{
 const o=fixture([{id:'target',owner:1,drillers:20,x:0},...Array.from({length:4},(_,i)=>({id:`near${i}`,owner:0,drillers:1,x:4.5+i/10})),{id:'strong',owner:0,drillers:100,x:-5}],100);
 const cs=generateBotCandidates(o,attackRoutes(o));
 const direct=cs.filter(c=>c.kind==='attack'&&c.captureTargets?.includes('target')&&c.drafts.length===1);
 assert.ok(direct.some(c=>launch(c,'strong','target')));
 assert.ok(new Set(direct.map(c=>c.drafts[0]!.action.source)).size<=4);
 const candidate=direct.find(c=>launch(c,'strong','target')&&Number(c.drafts[0]!.action.drillers)>20)!;
 const f=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:candidate.drafts,predicates:[{id:'capture',kind:'controlledAtHorizon',outpostId:'target'}]});
 assert.equal(f.path?.predicates[0]!.truth,'true');
});

test('a delivered friendly staging force pays for unavailable time, not a full-window permanent charge',async()=>{
 const {botCommitmentCost}=await import('../packages/ai/src/controller/analysis/tactical-force-policy.js');
 const {evaluateBotFrame}=await import('../packages/ai/src/controller/analysis/tactical-evaluation.js');
 const o=fixture([{id:'home',owner:0,drillers:100,x:0},{id:'front',owner:0,drillers:0,x:.9},{id:'target',owner:1,drillers:0,x:1}]);
 const drafts=[{id:'stage',issueTick:o.view.tick,action:{kind:'launch',source:'home',destination:'front',drillers:100}}];
 const base=forecastKnownPath(o,{targetTick:o.view.tick+144}),future=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts});
 assert.equal(base.forecast.status,'conditional');assert.equal(future.forecast.status,'conditional');
 if(base.forecast.status!=='conditional'||future.forecast.status!=='conditional')return;
 const before=evaluateBotFrame(o,base.forecast.result,base.path),after=evaluateBotFrame(o,future.forecast.result,future.path);
 const oldCost=botCommitmentCost(o,drafts),cost=botCommitmentCost(o,drafts,future.path);
 assert.ok(after.utility-before.utility-oldCost.transit<0,'old permanent charge rejected pure staging');
 assert.ok(after.utility-before.utility-cost.transit>2,'verified short delivery can justify useful staging');
 assert.ok(cost.transit>0&&cost.transit<oldCost.transit);assert.equal(cost.shortfall,oldCost.shortfall);
 assert.equal(botCommitmentCost(o,drafts,{...future.path!,coverage:{...future.path!.coverage,complete:false}}).transit,oldCost.transit);
 const early=forecastKnownPath(o,{targetTick:o.view.tick+2,drafts});assert.equal(botCommitmentCost(o,drafts,early.path).transit,oldCost.transit,'incomplete travel is not free');
 const reverse=fixture([{id:'home',owner:0,drillers:0,x:0},{id:'front',owner:0,drillers:100,x:.9},{id:'target',owner:1,drillers:0,x:1}]);
 const reverseDraft=[{id:'back',issueTick:reverse.view.tick,action:{kind:'launch',source:'front',destination:'home',drillers:100}}];
 const rbase=forecastKnownPath(reverse,{targetTick:reverse.view.tick+144}),rmove=forecastKnownPath(reverse,{targetTick:reverse.view.tick+144,drafts:reverseDraft});
 if(rbase.forecast.status==='conditional'&&rmove.forecast.status==='conditional')assert.ok(evaluateBotFrame(reverse,rmove.forecast.result,rmove.path).utility-evaluateBotFrame(reverse,rbase.forecast.result,rbase.path).utility-botCommitmentCost(reverse,reverseDraft,rmove.path).transit<0,'reverse movement has no launch reward');
 const threatened=structuredClone(o);threatened.view.outposts.find(p=>p.id==='target')!.drillers=100;
 assert.ok(botCommitmentCost(threatened,drafts,future.path).shortfall>0,'observed source-defense cost remains');
 assert.equal(botCommitmentCost(threatened,drafts,future.path).shortfall,botCommitmentCost(threatened,drafts).shortfall);
});

test('friendly commitment duration and remaining window use the observed command clock',async()=>{
 const {botCommitmentCost}=await import('../packages/ai/src/controller/analysis/tactical-force-policy.js');
 for(const seconds of [0,599])for(const delay of [0,5]){
  const o=fixture([{id:'home',owner:0,drillers:100,x:0},{id:'front',owner:0,drillers:0,x:.9},{id:'enemy',owner:1,drillers:0,x:1}]);o.secondsSinceLastTick=seconds;
  const draft={id:'clock-stage',issueTick:o.view.tick+delay,action:{kind:'launch',source:'home',destination:'front',drillers:100}};
  const f=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:[draft]});assert.ok(f.path?.coverage.complete);
  const arrival=f.path.events.find(e=>e.kind==='unloaded'&&e.details.outpost==='front');assert.ok(arrival);
  const now=o.view.tick+seconds/600,start=Math.max(draft.issueTick,now),fraction=Math.min(1,Math.max(1,arrival.tick-1+arrival.fraction-start)/(o.view.tick+144-now));
  const full=botCommitmentCost(o,[draft]),cost=botCommitmentCost(o,[draft],f.path);
  assert.ok(Math.abs(cost.transit-full.transit*fraction)<1e-9);
  assert.equal(botCommitmentCost(o,[draft],{...f.path,requestedTargetTick:o.view.tick}).transit,full.transit,'zero/negative remaining window keeps the conservative full charge');
 }
});
