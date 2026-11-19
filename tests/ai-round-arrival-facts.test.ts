import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {estimateKnownArrivals} from '../packages/prediction/src/index.js';
import {roundMapBlocks} from '../packages/ai/src/controller/presentation/round-map.js';
import {executeTool,initialState,type AiSnapshot} from '../packages/ai/src/index.js';
import {observationChanges} from '../packages/ai/src/controller/observation/changes.js';

function fixture():AiSnapshot{
 const config=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;config.match={mode:'mining',neptuniumGoal:200};
 const o=observation({state:createFleetScenario(config),scheduled:[]},0,'round-arrivals');
 o.outpostNames=Object.fromEntries(o.view.outposts.map((p,i)=>[p.id,`REEF-${i}`]));
 o.view.fleets.push({id:'visible-enemy',owner:1,state:'moving',source:'红方矿场',destination:{kind:'outpost',id:'蓝方工厂'},position:{x:0.2,y:0},drillers:10,gift:false});
 return {observation:o,notebook:[],reminders:[],chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,
  task:{category:'military',weight:'medium',reasons:['当前来袭是否改变原计划'],entities:['蓝方工厂'],deferred:[]}};
}
const fleetHeaders=(snapshot:AiSnapshot)=>roundMapBlocks(snapshot).find(block=>block.text.startsWith('[舰队]\n'))!.text.split('\n')[1]!.split('\t');
const fleetRows=(snapshot:AiSnapshot)=>roundMapBlocks(snapshot).find(block=>block.text.startsWith('[舰队]\n'))!.text.split('\n').slice(2).filter(Boolean).map(line=>line.split('\t'));

test('fleet positions use authorized nearest outpost names and distances; new contacts do not leak raw coordinates through changes',()=>{
 const snapshot=fixture();snapshot.observation.revision+='-spatial';
 snapshot.observation.view.outposts.forEach((post,i)=>{post.position={x:[0,2,8][i]!,y:0};});
 const before=structuredClone(snapshot.observation);before.view.fleets=[];
 snapshot.changes=observationChanges(before,snapshot.observation);
 const original=structuredClone(snapshot),row=fleetRows(snapshot).find(row=>row[0]==='visible-enemy')!;
 assert.equal(row[fleetHeaders(snapshot).indexOf('当前邻近据点')],'REEF-0');assert.equal(row[fleetHeaders(snapshot).indexOf('邻近距离')],'0.2');assert.equal(row[fleetHeaders(snapshot).indexOf('距目的地距离')],'0.2');
 const text=roundMapBlocks(snapshot).map(block=>block.text).join('\n');
 assert.ok(!text.includes('"position":{'));assert.ok(!text.includes('"x":'));assert.deepEqual(snapshot,original);
 assert.deepEqual(snapshot.observation.view.fleets.find(f=>f.id==='visible-enemy')!.position,{x:0.2,y:0});
});

test('a long settlement batch shares columns without losing event identities, clocks, false or null',()=>{
 const snapshot=fixture(),home=snapshot.observation.view.outposts[0]!.id;
 snapshot.observation.activity=Array.from({length:25},(_,id)=>({id,kind:'shield-order',tick:100,seconds:id,actor:0,subject:home,source:null,destination:null,drillers:null,enabled:id%2===1}));
 const original=structuredClone(snapshot),block=roundMapBlocks(snapshot).find(block=>block.detail==='settlements')!;
 const text=block.text.split('\n')[1]!,encoded=JSON.parse(text);
 assert.equal(encoded.encoding,'column-groups/1');assert.equal(encoded.length,25);assert.equal(encoded.groups.length,1);
 const group=encoded.groups[0],column=(key:string)=>group.fields.indexOf(key)+1;
 for(const key of ['id','subject','eventWorldDay','enabled','drillers'])assert.ok(group.fields.includes(key),key);
 for(const [index,row] of group.rows.entries()){
  assert.equal(row[0],index);assert.equal(row[column('id')],index);assert.equal(row[column('subject')],'REEF-0');
  assert.equal(row[column('eventWorldDay')],100+index/600);assert.equal(row[column('enabled')],index%2===1);assert.equal(row[column('drillers')],null);
 }
 assert.ok(text.length<JSON.stringify(snapshot.observation.activity).length);assert.deepEqual(snapshot,original);
});

test('permanent fleet facts show program arrival estimates in exact absolute world days',()=>{
 const snapshot=fixture(),before=structuredClone(snapshot),raw=estimateKnownArrivals(snapshot.observation),rows=fleetRows(snapshot);
 const shown=rows.find(row=>row[0]==='visible-enemy')!;assert.ok(shown);
 const estimated=raw.arrivals.find(row=>row.id==='visible-enemy');
 const expected=raw.status==='conditional'&&estimated?.arrivalMinutes!=null?snapshot.observation.view.tick+snapshot.observation.secondsSinceLastTick/600+estimated.arrivalMinutes/10:null;
 assert.equal(shown[fleetHeaders(snapshot).indexOf('预计抵达日')],expected===null?'null':String(expected));
 assert.deepEqual(snapshot,before,'presentation cannot mutate authorized observations');
});

test('disappearance produces no arrival or victory fact and diplomacy retains the same current map',()=>{
 const snapshot=fixture();snapshot.observation.view.fleets=[];snapshot.observation.revision='disappeared';snapshot.observation.activity=[];
 snapshot.task!.entities=['historical-fleet'];snapshot.task!.category='diplomacy';
 assert.deepEqual(fleetRows(snapshot),[]);
 const blocks=roundMapBlocks(snapshot),settled=blocks.find(block=>block.text.startsWith('[实际结算]\n'))!;
 assert.deepEqual(JSON.parse(settled.text.split('\n')[1]!),[]);
 assert.ok(blocks.some(block=>block.text.startsWith('[据点]\n')));
 assert.ok(!blocks.some(block=>block.text.includes('forecast-summary/1')),'default map does not manufacture a tactical baseline');
});
