import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {scheduledCommitments} from '../packages/ai/src/controller/analysis/scheduled-commitments.js';
import {screenAttacks} from '../packages/ai/src/controller/analysis/attack-screening.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {executeTool} from '../packages/ai/src/controller/execution/tools.js';
function fixture(){
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'commitments');
 o.view.fleets=[];
 o.view.outposts=[{id:'home',owner:0,position:{x:0,y:0},visibility:2,drillers:100,shield:0},{id:'target',owner:1,position:{x:.1,y:0},visibility:2,drillers:0,shield:0}];
 o.outpostNames={home:'HAVEN',target:'REEF'};
 const pending={id:'scheduled-1',player:0,issueTick:o.view.tick+5,status:'pending' as const,action:{kind:'launch',source:'home',destination:'target',drillers:10}};
 return {o,pending};
}
test('commitments count only own pending troops and do not debit executed materialized fleets twice',()=>{
 const {o,pending}=fixture();
 o.scheduled=[pending,{...pending,id:'second',action:{...pending.action,drillers:5,}},{...pending,id:'foreign',player:1},{...pending,id:'executed',status:'executed'},{...pending,id:'failed',status:'failed'},{...pending,id:'cancelled',status:'cancelled'}];
 o.view.fleets=[{id:'executed',owner:0,state:'moving',drillers:10,gift:false,source:'home',destination:{kind:'outpost',id:'target'},position:{x:0,y:0}}];
 const before=JSON.stringify(o),rows=scheduledCommitments(o);
 assert.deepEqual(rows,[{source:'home',drillers:15,scheduleIds:['scheduled-1','second'],unknownSchedules:[]}]);
 assert.equal(JSON.stringify(o),before);
 assert.deepEqual(scheduledCommitments(o,pending.issueTick),[]);
});
test('uncalculated mining or malformed costs are explicit and never counted as known zero',()=>{
 const {o,pending}=fixture();o.scheduled=[{...pending,action:{kind:'toggle-mine',outpostId:'home'}},{...pending,id:'bad',action:{...pending.action,drillers:-1}}];
 const row=scheduledCommitments(o)[0]!;assert.deepEqual(row.unknownSchedules,['scheduled-1','bad']);assert.equal(row.drillers,0);
 const report=screenAttacks(o,attackRoutes(o));assert.equal(report.sourceReserves[0]!.pendingUnknown,true);assert.equal(report.sourceReserves[0]!.available,0);
});
test('a small reservation subtracts its amount instead of disabling the whole screening source',()=>{
 const {o,pending}=fixture(),baseline=screenAttacks(o,attackRoutes(o)).sourceReserves[0]!;
 o.scheduled=[pending];const report=screenAttacks(o,attackRoutes(o)),source=report.sourceReserves[0]!;
 assert.equal(source.pendingReserved,10);assert.equal(source.available,baseline.available-10);assert.ok(source.available>0);
 assert.ok(report.ranked.some(p=>p.sources.some(s=>s.id==='home')));
});
