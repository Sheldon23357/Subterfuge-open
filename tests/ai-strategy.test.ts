
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {classifyChanges} from '../packages/ai/src/controller/runtime/decision.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';

function fixture(){
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};
  const room={state:createFleetScenario(cfg),scheduled:[]};
  const snapshot:AiSnapshot={observation:observation(room,0,'room'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
  snapshot.observation.outpostNames=Object.fromEntries(snapshot.observation.view.outposts.map(p=>[p.id,p.id]));
  return {room,snapshot};
}
test('investment threshold wakes strategic choice while ordinary enemy weakness remains deferred',()=>{
  const {snapshot}=fixture(),before=structuredClone(snapshot.observation),after=structuredClone(before);
  before.view.outposts[0]!.drillers=before.view.self.mineCreationCost-1;
  after.view.outposts[0]!.drillers=after.view.self.mineCreationCost;
  const signals=classifyChanges(before,after).important;
  assert.equal(signals.find(s=>s.key.startsWith('funded:'))!.category,'strategy');
  const weak=structuredClone(after);weak.view.outposts[1]!.drillers=1;
  const changes=classifyChanges(after,weak);assert.equal(changes.important.length,0);assert.ok(changes.minor.length);
});

test('reminders reject unknown identities/categories and the retired gathering entry is unavailable',async()=>{
  const {snapshot}=fixture(),state=initialState('room',0,{model:'',personality:'raider'});
  const c={snapshot,state,gateway:{snapshot:async()=>snapshot,request:async()=>{throw Error('No request expected');}},id:'validation',spoken:0,now:60000};
  for(const extra of [{category:'admin'},{entities:['hidden-fleet']},{entities:['蓝方工厂','蓝方工厂']}]){
    await assert.rejects(executeTool('reminders',{set:[{id:'r',atWorldDay:101,note:'复查',...extra}]},c));
  }
  await assert.rejects(executeTool('gather',{targets:['蓝方工厂'],sources:[],targetTick:112},c),/Tool not available/);
  const id='p1-'+'a'.repeat(64);
  snapshot.observation.view.fleets.push({id,owner:1,position:{x:1,y:0},state:'moving',drillers:10,gift:false,destination:null});
  const reminder=await executeTool('reminders',{set:[{id:'r',atWorldDay:101,note:'跟踪',category:'military',entities:['F2-AAAAAAAA']}]},c) as any;
  assert.deepEqual(reminder.set[0].entities,[id]);
});
