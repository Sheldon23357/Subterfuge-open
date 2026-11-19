import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {generateBotCandidates} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
import {planBot} from '../packages/ai/src/controller/local/bot-planner.js';
import {createKnownPrediction,forecastKnownPath} from '../packages/prediction/src/index.js';

function fixture(){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 c.match={mode:'mining',neptuniumGoal:200};c.size={width:80,height:80};
 c.positions={'蓝方工厂':{x:0,y:0},'红方矿场':{x:3,y:0},'红方后方':{x:30,y:30}};
 const template=c.economy.outposts[0]!;template.type='generator';template.drillers=15;
 for(let i=0;i<5;i++){const id=`reserve-${i}`;c.positions[id]={x:-(i+1)/10,y:0};c.economy.outposts.push({...template,id,drillers:15});}
 return observation({state:createFleetScenario(c),scheduled:[]},0,'search-quality');
}

test('quiet logistics remains bounded without prebooking mine construction',()=>{
 const o=fixture(),before=structuredClone(o),candidates=generateBotCandidates(o,attackRoutes(o));
 const logistics=candidates.filter(c=>c.kind==='logistics');assert.ok(logistics.length>0);assert.ok(logistics.length<=2);
 assert.equal(new Set(logistics.map(c=>c.objective)).size,logistics.length);
 assert.ok(candidates.every(c=>c.drafts.every(d=>d.issueTick===o.view.tick)));
 assert.ok(!candidates.some(c=>c.kind==='economy'&&c.drafts.some(d=>d.action.kind==='toggle-mine')));
 assert.deepEqual(o,before);
});

test('50-simulation search accounts for every stage and can refine without fixed 24-simulation reservation',()=>{
 const o=fixture();o.view.outposts.find(p=>p.owner===0)!.drillers=100;
 const d=planBot(o,attackRoutes(o),{maxSimulations:50,maxElapsedMs:60000});
 assert.ok(d.coverage.stages);assert.ok(d.coverage.stages.discovery>0);assert.ok(d.coverage.stages.refinement>0);
 assert.equal(Object.values(d.coverage.stages).reduce((n,x)=>n+x,0),d.coverage.simulations);
 assert.ok(d.coverage.simulations<=50);
 if(d.coverage.stopReason==='simulation-budget')assert.equal(d.coverage.simulations,50);
});

test('resuming a hypothetical future mine at its queue boundary matches one uninterrupted full forecast',()=>{
 const o=fixture(),candidate={drafts:[{id:'fund',issueTick:o.view.tick,action:{kind:'launch',source:'reserve-0',destination:'蓝方工厂',drillers:15}},{id:'hypothetical-mine',issueTick:o.view.tick+10,action:{kind:'toggle-mine',outpostId:'蓝方工厂'}}]};
 const options={drafts:candidate.drafts,pathPredicates:[],collectResourceFrames:true};
 const session=createKnownPrediction(o,options),boundary=Math.max(...candidate.drafts.map(d=>d.issueTick));
 session.predict(boundary);
 const resumed=session.predict(o.view.tick+144),direct=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:candidate.drafts,predicates:[],collectResourceFrames:true});
 assert.deepEqual(resumed,{...direct.forecast,path:direct.path});
});
