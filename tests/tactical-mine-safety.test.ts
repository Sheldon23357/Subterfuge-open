import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {botOpponentScenarios} from '../packages/ai/src/controller/analysis/tactical-opponents.js';
import {planBot} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import type {BotCandidate} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:60,height:60};cfg.match={mode:'mining',neptuniumGoal:200};
 cfg.economy.players=Array.from({length:3},()=>({active:true,neptunium:40,minesCreated:1}));
 cfg.economy.outposts=['mine','target','rival'].map((id,i)=>({...cfg.economy.outposts[0]!,id,owner:i,type:i===0?'mine':'generator',drillers:[49,1,74][i]!,shield:0,shieldMax:0}));
 cfg.positions={mine:{x:0,y:0},target:{x:1,y:0},rival:{x:2,y:0}};
 const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'mine-safety');
 const c:BotCandidate={id:'unsafe-expansion',kind:'attack',objective:'capture:target',targets:['target'],captureTargets:['target'],priority:100,reasons:[],drafts:[{id:'raid',issueTick:o.view.tick,action:{kind:'launch',source:'mine',destination:'target',drillers:49}}]};
 return {o,c,routes:attackRoutes(o,{attackTicks:144,localTicks:144,holdTicks:24})};
}
test('mine pressure covers two opponents independently at conventional and full force',()=>{
 const {o,c,routes}=fixture(),scenarios=botOpponentScenarios(o,routes,[c]).filter(s=>s.protectedMine==='mine');
 assert.equal(scenarios.length,4);
 for(const owner of [1,2]){
  const branches=scenarios.filter(s=>s.enemyLaunches?.[0]?.player===owner);assert.equal(branches.length,2);
  assert.ok(branches.every(s=>s.enemyLaunches!.every(l=>l.player===owner)));
  assert.ok(branches.some(s=>s.enemyLaunches![0]!.drillers===[1,1,74][owner]));
 }
});
test('ordinary expansion cannot purchase newly induced loss of an existing mine',()=>{
 const {o,c,routes}=fixture();
 const d=planBot(o,routes,{validationCandidate:c,maxSimulations:50,maxElapsedMs:30000});
 assert.equal(d.selected.id,'hold');
 assert.ok(d.assessments.some(a=>a.candidate.id===c.id&&a.reasons.some(r=>r.includes('新增失矿'))),JSON.stringify(d.assessments));
});
