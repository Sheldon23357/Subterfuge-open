import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {AiStore,initialState,executeTool,PlayerGateway,type AiSnapshot} from '../packages/ai/src/index.js';
import {GameRequestError} from '../packages/ai/src/controller/transport/gateway.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {reconcileCampaigns,type Campaign} from '../packages/ai/src/controller/storage/campaign-state.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup,room={state:createFleetScenario(cfg),scheduled:[]};
 const snapshot:AiSnapshot={observation:observation(room,0,'review'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:4};
 const store=new AiStore(':memory:'),state=initialState('review',0,{model:'',personality:'schemer'});
 return {room,snapshot,store,state};
}

test('each private target, public channel and canonical group has an independent five-message allowance',async()=>{
 const {snapshot,store,state}=fixture();let sent=0;
 try{
   const c={state,snapshot,gateway:{snapshot:async()=>snapshot,request:async()=>{sent++;return {};}},id:'say',now:60000,spoken:10,chatSentByTarget:{'player:1':5,'group:1,2':5}};
   await assert.rejects(executeTool('say',{to:1,text:'sixth'},c),/target quota/);
   await executeTool('say',{to:2,text:'independent'},c);
   await executeTool('say',{to:null,text:'public independent'},c);
   await assert.rejects(executeTool('say',{to:[2,1],text:'same group'},c),/target quota/);
   await executeTool('say',{to:[1,3],text:'other group'},c);
   assert.equal(sent,3);assert.equal(c.chatSentByTarget['player:1'],5);
 }finally{store.close();}
});

test('campaign accounts waiting troops once but distinguishes waiting, sailing, cancellation and holding',()=>{
 const {snapshot,store}=fixture();try{
   const o=snapshot.observation,source=o.view.outposts[0]!.id,target=o.view.outposts[1]!.id;
   const p:Campaign={id:'campaign',target,objective:'capture',holdPlan:'hold',cancelWhen:'risk',stage:'assembling',createdTick:100,reviewAtTick:110,allocations:[{source,drillers:20}],accountedFleets:[],issues:[]};
   o.view.fleets=[{id:'sent',owner:0,source,drillers:20,state:'waiting',gift:false,position:{x:0,y:0},destination:{kind:'outpost',id:target}}];
   const waiting=reconcileCampaigns([p],o)[0]!;assert.equal(waiting.stage,'waiting');assert.equal(waiting.allocations[0]!.drillers,0);assert.deepEqual(waiting.movement,{waiting:1,moving:0});
   o.view.fleets[0]!.state='moving';const sailing=reconcileCampaigns([waiting],o)[0]!;assert.equal(sailing.stage,'underway');assert.equal(sailing.accountedFleets.length,1);
   o.view.fleets=[];assert.equal(reconcileCampaigns([sailing],o)[0]!.stage,'review');
   o.view.outposts[1]!.owner=0;assert.equal(reconcileCampaigns([sailing],o)[0]!.stage,'holding');
 }finally{store.close();}
});
