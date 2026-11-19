import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {previewKnownDeployment,estimateKnownArrivals,knownFleetArrivalSteps} from '../packages/prediction/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {observationRuleSeconds} from '../packages/contracts/src/index.js';
import {projectModelData} from '../packages/ai/src/controller/presentation/model-data-projection.js';
function fixture(){const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;setup.match={mode:'mining',neptuniumGoal:200};return {state:createFleetScenario(setup),scheduled:[]};}
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
for(const phase of [0,77,599])for(const delayed of [false,true])test(`deployment exact ETA agrees with engine and arrivals at fractional observation ${phase}, delayed=${delayed}`,()=>{
 const room=fixture(),observed=observation(room,0,'eta',phase),before=structuredClone(observed);
 const action={kind:'launch' as const,source:'蓝方工厂',destination:'红方矿场',drillers:27,...delayed?{delaySeconds:1800-phase}:{}};
 const preview=previewKnownDeployment(observed,{id:'candidate',issueTick:100,action});
 assert.equal(preview.status,'conditional');if(preview.status!=='conditional')return;
 assert.notEqual(preview.arrivalSeconds,null);assert.notEqual(preview.arrivalMinutes,null);
 assert.ok(preview.arrivalSeconds!>observationRuleSeconds(observed));
 close(preview.arrivalMinutes!,(preview.arrivalSeconds!-observationRuleSeconds(observed))/60);
 const launched=submitFleetOrder(room.state,{id:'candidate',player:0,action},phase).state;
 const now=observation({state:launched,scheduled:[]},0,'eta',phase),table=estimateKnownArrivals(now).arrivals.find(a=>a.id==='candidate')!;
 assert.equal(table.arrivalTick,preview.arrivalTick);close(table.arrivalMinutes!,preview.arrivalMinutes!);
 const steps=knownFleetArrivalSteps(now,'candidate');let step=steps.next();while(!step.done)step=steps.next();
 close(step.value.arrivalSeconds!,preview.arrivalSeconds!);
 const arrival=advanceFleetScenario(launched,120).events.find(event=>event.subject==='candidate'&&event.kind==='battle')!;
 close(preview.arrivalSeconds!,(arrival.tick-1+arrival.fraction)*600);
 assert.ok(preview.arrivalSeconds!<preview.arrivalTick!*600,'settlement boundary is not reported as the precise event');
 const shown=projectModelData({tool:'deploy',result:preview}) as any;
 close(shown.result.arrivalWorldDay,preview.arrivalSeconds!/600);close(shown.result.arrivalWorldDays,preview.arrivalMinutes!/10);
 assert.equal(shown.result.arrivalSeconds,undefined);assert.equal(shown.result.outcome,preview.outcome);assert.deepEqual(observed,before);
});

test('unresolved deployment keeps explicit unknown timing and never invents battle success',()=>{
 const room=fixture();room.state.economy.players[1]!.neptunium=199;room.state.economy.outposts[1]!.miningProgress=71;
 const observed=observation(room,1,'eta-end',100.25),preview=previewKnownDeployment(observed,{id:'after-end',issueTick:105,action:{kind:'launch',source:'红方后方',destination:'蓝方工厂',drillers:1}});
 assert.equal(preview.status,'conditional');if(preview.status!=='conditional')return;
 assert.deepEqual(preview,{status:'conditional',arrivalTick:null,arrivalSeconds:null,arrivalMinutes:null,target:null,outcome:'unresolved'});
 const shown=projectModelData({tool:'deploy',result:preview}) as any;
 assert.equal(shown.result.arrivalWorldDay,null);assert.equal(shown.result.arrivalWorldDays,null);assert.equal(shown.result.outcome,'unresolved');
});
