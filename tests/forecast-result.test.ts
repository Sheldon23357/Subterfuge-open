import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/fleet-scenario.js';
import {prepareForecastKnowledge} from '../packages/engine/src/forecast-knowledge.js';
import {buildForecastWorld} from '../packages/engine/src/forecast-world.js';
import {projectForecastResult} from '../packages/engine/src/forecast-result.js';
function fixture(){
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:80,height:80};cfg.positions[cfg.economy.outposts[1]!.id]={x:30,y:30};cfg.positions[cfg.economy.outposts[2]!.id]={x:35,y:35};
 const k=prepareForecastKnowledge(createFleetScenario(cfg),0),b=buildForecastWorld(k);
 if(b.status!=='conditional')throw Error(b.reasons.join(','));return{k,state:b.state};
}
test('forecast result masks retained unknown bases while returning only own future totals',()=>{
 const {k,state}=fixture(),id=k.unknownOutposts[0]!;
 // Deliberately place hypothetical player sonar at a formerly unknown base.
 state.initial.positions[state.economy.outposts[0]!.id]={...state.initial.positions[id]!};
 const before=JSON.stringify(state),result=projectForecastResult(k,state),o=result.outposts.find(o=>o.id===id)!;
 assert.equal(o.visibility,0);assert.equal('owner'in o,true);assert.equal('drillers'in o,false);assert.equal('type'in o,false);
 for(const field of ['publicIntel','resources','initial','commands','events','visibleRuntime','retainedWorld','match'])assert.equal(field in result,false);
 assert.equal(result.self.drillers,k.view.self.drillers);
 assert.equal(result.certainty,'conditional');assert.equal(JSON.stringify(state),before);
 assert.deepEqual(result.size,k.view.size);assert.equal(result.playerCount,k.view.playerCount);assert.equal(result.teamSize,k.view.teamSize);
 assert.ok(result.sonar.every(a=>Number.isFinite(a.radius)&&Number.isFinite(a.center.x)&&Number.isFinite(a.center.y)));
 if(result.sonar.length){result.sonar[0]!.center.x=12345;assert.notEqual(projectForecastResult(k,state).sonar[0]!.center.x,12345);}
 o.position.x=999;assert.notEqual(state.initial.positions[id]!.x,999);
 const presentOwner=k.view.outposts.find(o=>o.id===id)!.owner;state.economy.outposts.find(o=>o.id===id)!.owner=0;
 assert.equal(projectForecastResult(k,state).outposts.find(o=>o.id===id)!.owner,presentOwner);
});


test('unknown arrival does not disclose other players arrival events',()=>{
 const {k,state}=fixture(),id=k.unknownOutposts[0]!;

 state.events.push({sequence:0,tick:101,fraction:.4,kind:'future-unknown-arrival',subject:'own',details:{owner:0,outpost:id}},
 {sequence:1,tick:101,fraction:.4,kind:'future-unknown-arrival',subject:'enemy-secret',details:{owner:1,outpost:id}});
 const result=projectForecastResult(k,state);
 assert.deepEqual(result.unknownArrivals,[{fleetId:'own',outpostId:id,tick:101,fraction:.4,outcome:'unknown'}]);
 assert.equal(JSON.stringify(result).includes('enemy-secret'),false);
 delete state.forecastPlayer;assert.throws(()=>projectForecastResult(k,state),/perspective/);
});
