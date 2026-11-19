import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {executeTool,initialState,type AiSnapshot} from '../packages/ai/src/index.js';
import {modelActionTimes} from '../packages/ai/src/controller/execution/model-action-time.js';
import {projectModelData} from '../packages/ai/src/controller/presentation/model-data-projection.js';
import {STRUCTURED_ARGUMENT_DEFINITIONS} from '../packages/ai/src/controller/contracts/structured-arguments.js';
import type {ToolContext} from '../packages/ai/src/controller/execution/tools.js';

const action={kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:1,delayWorldDays:1.75};
function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const current=observation({state:createFleetScenario(cfg),scheduled:[]},0,'time-units');
 const snapshot:AiSnapshot={observation:current,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const writes:{path:string;data:any}[]=[],audit:{kind:string;data:any}[]=[];
 const c:ToolContext={state:initialState(current.roomId,0,{model:'',personality:'sentinel'}),snapshot,id:'timed',now:60150,spoken:0,
  gateway:{snapshot:async()=>snapshot,request:async(path,data)=>{writes.push({path,data});return current;}},audit:(kind,data)=>audit.push({kind,data})};
 return {c,writes,audit};
}

test('launch schema and all planning inputs use an exact world-day duration without changing original requests',()=>{
 const draft={id:'a',issueTick:101,action};
 const inputs:[string,any][]=[['order',{action}],['batch',{actions:[{tool:'order',arguments:{action}}]}]];
 for(const [tool,input] of inputs){
  const before=structuredClone(input),converted=modelActionTimes(tool,input) as any;
  assert.ok(JSON.stringify(converted).includes('"delaySeconds":1050'));assert.ok(!JSON.stringify(converted).includes('delayWorldDays'));
  assert.deepEqual(input,before);
 }
 for(const delayWorldDays of [-1,145,NaN,Infinity,null,'2',1.00001])assert.throws(()=>modelActionTimes('order',{action:{...action,delayWorldDays}}));
 for(const old of [{delaySeconds:1050},{delaySeconds:1050,delayWorldDays:1.75}]){
  const {delayWorldDays,...rest}=action;assert.throws(()=>modelActionTimes('order',{action:{...rest,...old}}),/delayWorldDays/);
 }
 const prose={set:[{id:'x',text:'delaySeconds is a historical field'}]};assert.deepEqual(modelActionTimes('notebook',prose),prose);
});

test('immediate orders preserve integer departure checks and reject scheduling',async()=>{
 const f=fixture(),input={action:structuredClone(action)};
 await executeTool('order',input,f.c);
 assert.equal(f.writes.length,1);assert.equal(f.writes[0]!.data.order.action.delaySeconds,1050);
 assert.equal(f.writes[0]!.data.order.action.delayWorldDays,undefined);assert.deepEqual(input.action,action);
 await assert.rejects(executeTool('order',{action:{...action,delayWorldDays:2}},f.c),/整数/);
 assert.equal(f.writes.length,1);
 await assert.rejects(executeTool('order',{executeAt:102,action:{...action,delayWorldDays:2}},f.c));
 assert.equal(f.writes.length,1);
});

test('invalid later batch duration is rejected before any transport; valid nested actions convert once',async()=>{
 const f=fixture();
 await assert.rejects(executeTool('batch',{actions:[{tool:'order',arguments:{action:{kind:'check-in'}}},
  {tool:'order',arguments:{action:{...action,delayWorldDays:1.00001}}}]},f.c),/精度/);
 assert.equal(f.writes.length,0);
 await executeTool('batch',{actions:[{tool:'order',arguments:{action}}]},f.c);
 assert.equal(f.writes.length,1);assert.equal(f.writes[0]!.data.order.action.delaySeconds,1050);
});

test('generated draft actions display world days while original arguments and unrelated geometry remain exact',()=>{
 const {delayWorldDays,...rest}=action,raw={...rest,delaySeconds:1050};
 const input={drafts:[{id:'a',issueTick:101,action:raw,position:{x:3,y:4}}],arguments:{action:raw},submittedArguments:{action:raw}};
 const before=structuredClone(input),shown=projectModelData(input) as any;
 assert.equal(shown.drafts[0].action.delayWorldDays,1.75);assert.equal(shown.drafts[0].action.delaySeconds,undefined);
 assert.deepEqual(shown.drafts[0].position,input.drafts[0]!.position);assert.deepEqual(shown.arguments,input.arguments);assert.deepEqual(shown.submittedArguments,input.submittedArguments);
 assert.deepEqual(projectModelData(shown),shown);assert.deepEqual(input,before);
});
