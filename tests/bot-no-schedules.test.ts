
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {advanceRoom,cancelSchedule,type LabRoom} from '../packages/server/src/planning.js';
import {executeTool,initialState,PlayerGateway,type AiSnapshot} from '../packages/ai/src/index.js';
import {TOOL_NAMES} from '../packages/ai/src/controller/contracts/tool-metadata.js';
import {generateBotCandidates} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
import {planBot} from '../packages/ai/src/controller/analysis/tactical-planner.js';
import {scheduledCommitments} from '../packages/ai/src/controller/analysis/scheduled-commitments.js';
import {attackRoutes} from '../packages/prediction/src/index.js';

function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const room:LabRoom={state:createFleetScenario(setup),scheduled:[]};
 const o=observation(room,0,'no-bot-schedules');
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 return {room,o,snapshot,state:initialState(o.roomId,0,{model:'',personality:'sentinel'})};
}

test('bot tools reject scheduling and cancellation before any write, including mixed batches',async()=>{
 const f=fixture();let writes=0;
 const c={...f,id:'attempt',spoken:0,now:f.o.view.tick*600,gateway:{snapshot:async()=>f.snapshot,request:async()=>{writes++;return f.o;}}};
 const action={kind:'check-in'},before=structuredClone(f.o);
 assert.ok(!TOOL_NAMES.some(name=>String(name)==='schedule'||String(name)==='cancelSchedule'));
 for(const [tool,args] of [
  ['schedule',{action,issueTick:f.o.view.tick+1}],
  ['cancelSchedule',{id:'human'}],
  ['order',{action,executeAt:f.o.view.tick+1}],
  ['batch',{actions:[{tool:'order',arguments:{action}},{tool:'order',arguments:{action,executeAt:f.o.view.tick+1}}]}],
  ['batch',{actions:[{tool:'order',arguments:{action}},{tool:'cancelSchedule',arguments:{id:'human'}}]}],
 ] as const)await assert.rejects(executeTool(tool,args,c));
 assert.equal(writes,0);assert.deepEqual(f.o,before);
 await executeTool('order',{action},c);assert.equal(writes,1,'ordinary commands remain available');
});

test('player schedules retain resource accounting, cancellation and actual execution',async()=>{
 const f=fixture(),source=f.o.view.outposts.find(p=>p.owner===0)!,target=f.o.view.outposts.find(p=>p.owner!==0)!;
 const action={kind:'launch' as const,source:source.id,destination:target.id,drillers:14};
 const room=scheduleOrder(f.room,{order:{id:'human',player:0,action},issueTick:f.o.view.tick+2});
 const o=observation(room,0,f.o.roomId);
 assert.equal(scheduledCommitments(o).find(c=>c.source===source.id)!.drillers,14);
 const before=structuredClone(room);
 await assert.rejects(executeTool('cancelSchedule',{id:'human'},{state:f.state,snapshot:{...f.snapshot,observation:o},id:'cancel',spoken:0,now:o.view.tick*600,gateway:{snapshot:async()=>f.snapshot,request:async()=>assert.fail('bot must not mutate a player schedule')}}));
 assert.deepEqual(room,before);
 const cancelled=cancelSchedule(room,'human',0);
 assert.equal(observation(cancelled,0,f.o.roomId).scheduled.find(s=>s.id==='human')!.status,'cancelled');
 assert.deepEqual(scheduledCommitments(observation(cancelled,0,f.o.roomId)),[]);
 const executed=advanceRoom(room,f.o.view.tick+2);
 assert.equal(observation(executed,0,f.o.roomId).scheduled.find(s=>s.id==='human')!.status,'executed');
 assert.ok(executed.state.commands.some(c=>c.id==='human'));
});

test('shared programmatic and hybrid planner generates immediate candidates and refuses future executable proposals',()=>{
 const f=fixture(),routes=attackRoutes(f.o),candidates=generateBotCandidates(f.o,routes);
 assert.ok(candidates.length>0);
 assert.ok(candidates.every(c=>c.drafts.every(d=>d.issueTick===f.o.view.tick)));
 const future={id:'future-only',kind:'economy' as const,objective:'future-only',targets:[],drafts:[{id:'future',issueTick:f.o.view.tick+2,action:{kind:'check-in'}}],priority:1000,reasons:[]};
 const decision=planBot(f.o,routes,{preludeOnly:true,preludeCandidates:[future],maxElapsedMs:30000});
 assert.equal(decision.selected.id,'hold');
 assert.ok(!decision.assessments.some(a=>a.candidate.id===future.id));
});


test('bot owner transport no longer translates scheduling aliases into player commands',async()=>{
 const f=fixture(),gateway=new PlayerGateway('http://127.0.0.1:1','synthetic',f.o.roomId,0,2);
 for(const path of ['/tool/schedule','/tool/cancel-schedule'])
  await assert.rejects(gateway.request(path,{revision:f.o.revision,order:{id:'never-send',action:{kind:'check-in'}},issueTick:f.o.view.tick+1,id:'human'}),/unsupported-player-operation/);
});
