
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fleetLabel,shortFleetReferences,resolveFleetReferences} from '../packages/ai/src/controller/presentation/fleet-labels.js';
import {roundMapBlocks} from '../packages/ai/src/controller/presentation/round-map.js';
import {fleetReferenceRenderer} from '../packages/ai/src/controller/presentation/fleet-labels.js';
import {initialState,executeTool} from '../packages/ai/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {readFileSync} from 'node:fs';

const id='p2-8f56d6a038f801cbcf3be65984d78fc35a458893224cc04e3132c61b545dabe2';
function fixture(){
 const room={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]};
 const view=observation(room,0,'labels');
 view.view.fleets=[{id,owner:2,position:{x:0,y:0},drillers:10,state:'moving',gift:true,destination:{kind:'outpost',id:'ALBREED'}}];
 return view;
}
test('stable fleet labels shorten observations, receipts and old memory without changing facts',()=>{
 assert.equal(fleetLabel(id),'F3-8F56D6A0');
 assert.equal(fleetLabel('outpost-2'),'outpost-2');
 const memory={strategy:`天火10兵赠艇${id}，tick118到达，尚未收到。`};
 assert.equal(shortFleetReferences(memory).strategy,'天火10兵赠艇F3-8F56D6A0，tick118到达，尚未收到。');
 const state=initialState('labels',0,{model:'',personality:'schemer'});state.memory.strategy=memory.strategy;
 const snap={observation:fixture(),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3};
 const prompt=roundMapBlocks(snap,fleetReferenceRenderer(snap.observation)).map(b=>b.text).join('\n');
 assert.ok(prompt.includes('F3-8F56D6A0'));assert.ok(!prompt.includes(id));assert.ok(shortFleetReferences(memory).strategy.includes('tick118'));
});

test('the permanent fleet table shows authorized source and destination without mutating inputs',()=>{
 const o=fixture();o.outpostNames={...o.outpostNames,SOLO:'SOLO',OCTOBER:'OCTOBER'};
 o.view.fleets[0]={...o.view.fleets[0]!,source:'SOLO',destination:{kind:'outpost',id:'OCTOBER'}};
 const state=initialState('labels',0,{model:'',personality:'schemer'});
 const snapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3,
  memoryConsistency:{facts:{[id]:{kind:'fleet',source:'SOLO',destination:{kind:'outpost',id:'OCTOBER'}}}}} as any;
 const history=[{tool:'forecast',result:{observedTick:10,targetTick:20,fleets:[{...o.view.fleets[0],source:'OCTOBER',destination:{kind:'outpost',id:'SOLO'}}]}}];
 const before=structuredClone({snapshot,history});
 {
   const prompt=roundMapBlocks(snapshot,fleetReferenceRenderer(snapshot.observation)).map(b=>b.text).join('\n');
  assert.match(prompt,/来源据点\t目的地类型\t目的地/);
  assert.match(prompt,/SOLO\toutpost\tOCTOBER/);
  assert.ok(prompt.includes('F3-8F56D6A0'));assert.ok(!prompt.includes(id));
 }
 assert.deepEqual({snapshot,history},before);
});
test('tool parameters resolve only visible unambiguous fleets and preserve narrative text',async()=>{
 const view=fixture();
 assert.deepEqual(resolveFleetReferences({action:{kind:'change-course',fleetId:'F3-8F56D6A0',destination:'F3-8F56D6A0',},text:'F3-8F56D6A0',id:'F3-8F56D6A0'},view),{action:{kind:'change-course',fleetId:id,destination:id,},text:'F3-8F56D6A0',id:'F3-8F56D6A0'});
 const requests:unknown[]=[];
 const state=initialState('labels',0,{model:'',personality:'schemer'});
 await executeTool('order',{action:{kind:'return-fleet',fleetId:'F3-8F56D6A0'}},{state,snapshot:{observation:view,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3},gateway:{snapshot:async()=>{throw Error('unused');},request:async(_path,data)=>{requests.push(data);return view;}},id:'command',spoken:0,now:0});
 assert.equal((requests[0] as {order:{action:{fleetId:string}}}).order.action.fleetId,id);
 assert.throws(()=>resolveFleetReferences({fleetId:'F3-00000000'},view),/不在当前可见/);
 view.view.fleets.push({...view.view.fleets[0]!,id:'p2-8f56d6a0'+'0'.repeat(56)});
 assert.throws(()=>resolveFleetReferences({fleetId:'F3-8F56D6A0'},view),/歧义/);
});
