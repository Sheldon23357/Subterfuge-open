
import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AiStore,initialState,executeTool,type AiSnapshot,type AgentRequest} from '../packages/ai/src/index.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
function fixture(){
 const snapshot:AiSnapshot={observation:observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'room'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:4,task:{category:'diplomacy',weight:'light',reasons:['收到新消息'],entities:[],deferred:[]}};
 snapshot.observation.outpostNames={...snapshot.observation.outpostNames,'据点 01':'NEMO','据点 02':'NEMO BAY'};
 return {snapshot,state:initialState('room',0,{model:'',personality:'mediator'})};
}

test('say sends only authorized recipients and text, rejecting retired private metadata before any write',async()=>{
 const {snapshot,state}=fixture(),requests:unknown[]=[],audits:unknown[]=[];
 const context={state,snapshot,gateway:{snapshot:async()=>snapshot,request:async(path:string,data:unknown)=>{requests.push({path,data});return {accepted:true};}},id:'speech',spoken:0,now:60000,audit:(kind:string,details:unknown)=>audits.push({kind,details})};
 await executeTool('say',{to:[1,2],text:'一起牵制领先者，我从东线施压？'},context);
 await executeTool('say',{to:null,text:'请撤回争议区域舰队。'},context);
 assert.deepEqual(requests,[{path:'/tool/chat',data:{id:'speech',to:[1,2],text:'一起牵制领先者，我从东线施压？'}},{path:'/tool/chat',data:{id:'speech',to:null,text:'请撤回争议区域舰队。'}}]);
 for(const extra of [{act:'probe'},{intent:'coalition'},{objective:'真实意图'}])await assert.rejects(executeTool('say',{to:1,text:'询问边界',...extra},context),/INVALID_TOOL_FIELDS/);
 for(const to of [[0,1],[1,1],8])await assert.rejects(executeTool('say',{to,text:'错误收件人'},context),/Invalid recipients/);
 assert.equal(requests.length,2);assert.deepEqual(audits,[]);
});

test('private incoming claims cannot be presented as public statements',async()=>{
 const {snapshot,state}=fixture();snapshot.chat=[{id:'private',from:1,to:0,text:'别碰NEMO。',tick:100,sentAt:0}];let writes=0;
 const context={state,snapshot,gateway:{snapshot:async()=>snapshot,request:async()=>{writes++;return {accepted:true};}},id:'claim',spoken:0,now:60000};
 await assert.rejects(executeTool('say',{to:1,text:'对方公开要求我放弃NEMO。'},context),/来源是私聊/);assert.equal(writes,0);
 await executeTool('say',{to:1,text:'你私下要求我放弃NEMO，我还没有同意。'},context);assert.equal(writes,1);
});

test('outpost names are expanded in transmitted messages and expanded length is enforced',async()=>{
 const {snapshot,state}=fixture(),requests:unknown[]=[];
 const context={state,snapshot,gateway:{snapshot:async()=>snapshot,request:async(_path:string,data:unknown)=>{requests.push(data);return {accepted:true};}},id:'names',spoken:0,now:60000};
 await executeTool('say',{to:1,text:'据点01归你，我守2号据点；留57兵、20盾。'},context);
 assert.deepEqual(requests,[{id:'names',to:1,text:'NEMO归你，我守NEMO BAY；留57兵、20盾。'}]);
 snapshot.observation.outpostNames!['据点 01']='N'.repeat(100);
 await assert.rejects(executeTool('say',{to:1,text:'据点 01 '.repeat(30)},context),/名称展开后/);assert.equal(requests.length,1);
});

test('the runner supplies saved diplomatic notes in a later round without restoring old queries',async()=>{
 const {snapshot,state}=fixture(),store=new AiStore(':memory:'),requests:AgentRequest[]=[],body='拉拢赤潮牵制领先者；底线是不锁死东线。';
 try{
  store.save(state,'notebook-set',{id:'mission',kind:'plan',priority:'high',text:body,updatedAt:60000,expiresAt:null});
  const runner=new SeatRunner(state,store,{snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No writes');}},{step:async request=>{requests.push(request);return {tokens:1,reply:{tool:'finish',arguments:{},summary:'完成'}};}});
  await runner.poll(0);snapshot.chat=[{id:'new',from:1,to:0,text:'延长停战？',tick:100,sentAt:0}];snapshot.chatCursor=1;await runner.poll(6000);await runner.poll(22000);
  assert.equal(requests.length,2);assert.ok(requests[1]!.prompt.includes('延长停战？'));assert.equal(requests[1]!.prompt.split(body).length-1,1);
 }finally{store.close();}
});
