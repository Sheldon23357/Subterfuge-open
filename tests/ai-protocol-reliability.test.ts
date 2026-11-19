
import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AiStore,initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {parseToolArguments,ToolArgumentsError} from '../packages/ai/src/controller/contracts/tool-arguments.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {scheduledCommitments} from '../packages/ai/src/controller/analysis/scheduled-commitments.js';
import {attackRoutes} from '../packages/prediction/src/index.js';

function fixture(drillers=100){
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'protocol');
 o.view.tick=0;o.view.fleets=[];o.scheduled=[];
 o.view.outposts=[{id:'home',owner:0,position:{x:0,y:0},visibility:2,drillers,shield:0},
 {id:'target',owner:null,position:{x:1,y:0},visibility:2,drillers:0,shield:0},
 {id:'other',owner:null,position:{x:2,y:0},visibility:2,drillers:0,shield:0}];
 o.outpostNames={home:'HAVEN',target:'REEF',other:'ATOLL'};
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:6};
 const state=initialState('protocol',0,{model:'',personality:'raider'}),store=new AiStore(':memory:');
 let writes=0;
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async(path:string)=>{if(path==='/tool/attack-routes')return attackRoutes(snapshot.observation);writes++;return o;}};
 const c={state,snapshot,gateway,id:'protocol-test',spoken:0,now:0};
 return {o,snapshot,state,store,gateway,c,writes:()=>writes};
}

test('long plans live in complete note bodies; reminders are explicit and unbooked plans reserve no troops',async()=>{
 const f=fixture(),text=`目标REEF；重新判断条件ATOLL出现增援。\n${'目'.repeat(2000)}\n${'守'.repeat(2000)}\n${'撤'.repeat(2000)}`;let step=0;
 try{
  const before=structuredClone(f.o);
  const replies=[
   {tool:'notebook',arguments:{set:[{id:'plan',kind:'plan',priority:'high',text,expiresWorldDay:null}]},summary:'Save whole plan'},
   {tool:'reminders',arguments:{set:[{id:'review-plan',atWorldDay:12,note:'重新判断REEF计划'}]},summary:'Explicit review'},
   {tool:'finish',arguments:{},summary:'Done'},
  ];
  await new SeatRunner(f.state,f.store,f.gateway,{step:async()=>({tokens:1,reply:replies[step++]!})}).poll(0);
  assert.equal(step,3);assert.equal(f.store.notebook('protocol',0,0)[0]!.text,text);
  assert.deepEqual(f.store.reminders('protocol',0).map(r=>[r.id,r.atSeconds]),[['review-plan',7200]]);
  assert.deepEqual(scheduledCommitments(f.o),[]);assert.deepEqual(f.o,before);assert.equal(f.writes(),0);
  assert.equal(f.store.latest('protocol',0,'campaign-state'),null);
 }finally{f.store.close();}
});

test('overlong notes reject the whole local update and retired campaign registration cannot reserve resources',async()=>{
 const f=fixture();try{
  const before=JSON.stringify({state:f.state,snapshot:f.snapshot});
  await assert.rejects(executeTool('finish',{memory:{strategy:'must not save'},notebook:{set:[{id:'oversize',kind:'plan',text:'字'.repeat(12001)}]},reminders:{set:[{id:'r',atWorldDay:12,note:'Do not save'}]}},f.c),/FINISH_PREFLIGHT_INVALID/);
  await assert.rejects(executeTool('campaigns',{set:[{id:'plan',target:'REEF',allocations:[{source:'HAVEN',drillers:100}]}]},f.c));
  await assert.rejects(executeTool('order',{campaignId:'plan',action:{kind:'check-in'}},f.c));
  assert.equal(JSON.stringify({state:f.state,snapshot:f.snapshot}),before);
  assert.deepEqual(f.store.notebook('protocol',0,0),[]);assert.deepEqual(f.store.reminders('protocol',0),[]);assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('safe JSON syntax normalization preserves quoted text and rejects ambiguous or truncated actions',()=>{
 const text='原文 ,} ,] \\ " \n';
 const raw=JSON.stringify({text});
 for(const wrapped of [raw,JSON.stringify(raw),'```json\n'+raw+'\n```',raw.slice(0,-1)+',}', '{"text":'+JSON.stringify(text)+',"list":[1,2,],}'])assert.equal(parseToolArguments(wrapped).args.text,text);
 for(const invalid of ['{"action":','{"drillers":1+2}',"{'drillers':1}",'[]','null','true','{"text":"unfinished}'])assert.throws(()=>parseToolArguments(invalid),ToolArgumentsError);
 assert.throws(()=>parseToolArguments('{\n"action": nope}'),(e:unknown)=>e instanceof ToolArgumentsError&&e.detail.position!==undefined&&e.detail.line===2&&!!e.detail.excerpt);
 const extra=JSON.stringify({set:[{id:'plan',reviewAtTick:10}]})+'}';
 const repaired=parseToolArguments(extra);
 assert.equal(repaired.repairs.includes('extra-closing-brace'),true);
 assert.deepEqual(repaired.args,{set:[{id:'plan',reviewAtTick:10}]});
 assert.throws(()=>parseToolArguments(JSON.stringify({text:'ok'})+'}}'),ToolArgumentsError);
});
test('malformed arguments are audited with raw input and position, then a corrected write executes once',async()=>{
 const f=fixture(),raw='{"action": {"kind":"check-in",}} extra';let step=0;
 try{
  const runner=new SeatRunner(f.state,f.store,f.gateway,{step:async()=>({tokens:1,reply:++step===1?{tool:'order',arguments:raw,summary:'bad'}:step===2?{tool:'order',arguments:'{"action":{"kind":"check-in"}}',summary:'corrected'}:{tool:'finish',arguments:{memory:{strategy:'saved'}},summary:'done'}})});
  await runner.poll(0);
  assert.equal(f.writes(),1);assert.equal(f.state.memory.strategy,'saved');
  const decision=f.store.decisionPage('protocol',0).entries[0]!.payload as any;
  assert.equal(decision.steps[0].status,'rejected');assert.equal(decision.steps[0].arguments,raw);
  assert.equal(decision.steps[0].result.error,'Invalid tool JSON');assert.ok(decision.steps[0].result.detail.reason);
 }finally{f.store.close();}
});
