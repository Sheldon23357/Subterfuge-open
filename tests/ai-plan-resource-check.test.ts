
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {checkPlanResources,finalizePlanResources} from '../packages/ai/src/controller/execution/plan-resource-check.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/index.js';
import type {KnownPredictionDraft,KnownForecastResponse} from '../packages/prediction/src/index.js';

function fixture(){
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'resource-check');
 const own=o.view.outposts.find(p=>p.owner===o.view.player)!,targets=o.view.outposts.filter(p=>p.id!==own.id);own.drillers=100;
 o.view.fleets=[];o.outpostNames=Object.fromEntries(o.view.outposts.map((p,i)=>[p.id,`REEF-${i}`]));
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const context={state:initialState(o.roomId,0,{model:'',personality:'sentinel'}),snapshot,id:'resources',spoken:0,now:o.view.tick*600+o.secondsSinceLastTick,
  gateway:{snapshot:async()=>snapshot,request:async()=>{throw Error('No network allowed for resource validation');}}};
 const draft=(id:string,drillers:number,target=targets[0]!.id,issueTick=o.view.tick):KnownPredictionDraft=>({id,issueTick,action:{kind:'launch',source:own.id,destination:target,drillers}});
 return {o,own,targets,snapshot,context,draft};
}

test('joint current queue detects aggregate resource failure across distinct destinations and preserves original state',()=>{
 const f=fixture(),before=structuredClone(f.snapshot);
 const result=checkPlanResources([f.draft('first',60),f.draft('second',60,f.targets[1]!.id)],undefined,f.context);
 assert.equal(result.status,'conflict');assert.ok(result.conflicts.some(c=>c.code==='engine-order-failed'&&c.draftIds?.includes('second')));
 assert.equal(result.sources.length,1);assert.deepEqual(f.snapshot,before);
});

test('accepted future schedules and explicit retained force are separate from suggested defense warnings',()=>{
 const f=fixture();
 f.o.scheduled=[{id:'pending',player:0,issueTick:f.o.view.tick+2,status:'pending',action:{kind:'launch',source:f.own.id,destination:f.targets[1]!.id,drillers:20}}];
 const result=checkPlanResources([f.draft('leave',70)],[{source:f.own.id,retainDrillers:15}],f.context);
 assert.equal(result.status,'conflict');assert.ok(result.conflicts.some(c=>c.kind==='constraint'&&c.code==='aggregate-retained-force-conflict'));
 f.o.scheduled=[];f.snapshot.attackScreening={basisRevision:f.o.revision,sourceReserves:[{id:f.own.id,reserve:40}]} as any;
 const warning=checkPlanResources([f.draft('leave',70)],undefined,f.context);
 assert.equal(warning.status,'satisfied');assert.ok(warning.warnings.some(w=>w.code==='below-suggested-reserve'));
});

test('future-only retained-force checks stay explicitly unknown',()=>{
 const f=fixture(),future=checkPlanResources([f.draft('future',20,f.targets[0]!.id,f.o.view.tick+1)],[{source:f.own.id,retainDrillers:90}],f.context);
 assert.equal(future.status,'unknown');assert.ok(future.conflicts.some(c=>c.code==='future-resource-constraints-unverified'));

});

test('missing future queue frames remain unknown and cannot be upgraded from a final endpoint alone',()=>{
 const f=fixture(),draft=f.draft('future',1,f.targets[0]!.id,f.o.view.tick+1),constraints=[{source:f.own.id,retainDrillers:1}];
 const initial=checkPlanResources([draft],constraints,f.context);
 const forecast={status:'conditional',orders:[],path:{coverage:{complete:true,unknownReasons:[]}}} as unknown as KnownForecastResponse;
 const result=finalizePlanResources(initial,forecast,[draft],constraints,f.context);
 assert.equal(result.status,'unknown');assert.ok(result.conflicts.some(c=>c.code==='future-resource-frame-not-covered'));
});

test('later path uncertainty cannot erase a covered earlier queue payment; earlier uncertainty still blocks it',()=>{
 const f=fixture(),draft=f.draft('future-payment',1,f.targets[0]!.id,f.o.view.tick+1),initial=checkPlanResources([draft],undefined,f.context);
 const forecast={status:'conditional',orders:[],path:{coverage:{complete:true,unknownReasons:['unobserved-world-possible']}},
  resourceFrames:[{tick:draft.issueTick,draftIds:[draft.id],coverage:'queue-time/1',pathUnknownReasons:[],sources:[{source:f.own.id,owner:0,drillers:99}],pendingSchedules:[],unknownReasons:[]}]} as unknown as KnownForecastResponse;
 assert.equal(finalizePlanResources(initial,forecast,[draft],undefined,f.context).status,'satisfied');
 forecast.resourceFrames![0]!.pathUnknownReasons=['unobserved-world-possible'];
 assert.equal(finalizePlanResources(initial,forecast,[draft],undefined,f.context).status,'unknown');
 forecast.resourceFrames![0]!.pathUnknownReasons=[];forecast.resourceFrames![0]!.unknownReasons=['source-resource-unknown'];
 assert.equal(finalizePlanResources(initial,forecast,[draft],undefined,f.context).status,'unknown');
 forecast.resourceFrames![0]!.unknownReasons=[];delete forecast.resourceFrames![0]!.coverage;
 assert.equal(finalizePlanResources(initial,forecast,[draft],undefined,f.context).status,'unknown','a legacy or incomplete frame cannot assert queue-time certainty');
});
