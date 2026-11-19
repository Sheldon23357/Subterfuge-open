import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {planBot} from '../packages/ai/src/controller/local/bot-planner.js';
import {forecastKnownPath} from '../packages/prediction/src/index.js';

for(const saturated of [false,true])test(`four-player mine investment preserves ${saturated?'scarce capacity':'useful production'} when choosing the converted base`,()=>{
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};cfg.size={width:80,height:80};
  cfg.economy.players=Array.from({length:4},()=>({active:true,neptunium:0,minesCreated:0}));
  const template=cfg.economy.outposts[0]!;
  cfg.economy.outposts=Array.from({length:13},(_,i)=>({...template,id:`post-${i}`,owner:i<10?0:i-9,
    type:i%3===0?'factory':'generator',drillers:i<10?(saturated||i<2?60:10):100,shield:0,shieldMax:0}));
  cfg.positions=Object.fromEntries(cfg.economy.outposts.map((p,i)=>[p.id,{x:i<10?i/10:30+(i-10)*3,y:i<10?0:30}]));
  const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'four-player-mine-choice');
  assert.equal(o.view.playerCount,4);
  assert.equal(o.view.self.drillers>=o.view.self.capacity,saturated);
  const decision=planBot(o,attackRoutes(o),{maxSimulations:96,maxElapsedMs:30000});
  const mine=decision.selected.drafts.find(d=>d.action.kind==='toggle-mine');
  assert.ok(mine,JSON.stringify(decision.selected));
  const source=o.view.outposts.find(p=>p.id===mine.action.outpostId)!;
  assert.equal(source.type,saturated?'factory':'generator',JSON.stringify(decision.selected));
  const future=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:decision.selected.drafts});
  assert.equal(future.forecast.status,'conditional');
  if(future.forecast.status==='conditional'){
    assert.equal(future.forecast.orders.some(d=>d.status==='failed'),false);
    assert.equal(future.forecast.result.outposts.find(p=>p.id===source.id)!.type,'mine');
    assert.ok(future.forecast.result.self.neptunium>0);
    if(saturated)assert.equal(future.forecast.result.self.capacity,o.view.self.capacity);
  }
});
