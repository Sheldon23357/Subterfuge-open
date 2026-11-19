import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {campaignParts,composeCampaign,reconcileCampaigns,type Campaign} from '../packages/ai/src/controller/storage/campaign-state.js';
import {projectCampaign} from '../packages/ai/src/controller/storage/campaign-projection.js';
import {commitCampaignLedger} from '../packages/ai/src/controller/storage/campaign-ledger.js';
function fixture(){
 const room={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]};
 const o=observation(room,0,'campaign-parts'),source=o.view.outposts[0]!.id,target=o.view.outposts[1]!.id;
 const p:Campaign={id:'plan',target,objective:'authored target',holdPlan:'retain source',cancelWhen:'risk',stage:'assembling',createdTick:o.view.tick,reviewAtTick:o.view.tick+10,allocations:[{source,drillers:20}],accountedFleets:[],issues:[]};
 o.view.fleets=[{id:'accepted',owner:0,source,drillers:10,state:'waiting',gift:false,position:{x:0,y:0},destination:{kind:'outpost',id:target}}];return {o,p,source,target};
}
test('campaign parts round trip preserves the flat storage shape and optional field presence',()=>{
 const {p}=fixture();const copy=composeCampaign(p,campaignParts(p));assert.deepEqual(copy,p);assert.equal(JSON.stringify(copy),JSON.stringify(p));
 for(const stage of ['completed','cancelled'] as const){const closed={...p,stage};assert.deepEqual(composeCampaign(closed,campaignParts(closed)),closed);}
});
test('projection is repeatable and never consumes reservations or rewrites authored intent',()=>{
 const {o,p}=fixture();const parts=campaignParts(p),before=structuredClone(parts);
 const first=projectCampaign(parts.intent,parts.ledger,[p],o);o.view.fleets[0]!.state='moving';const next=projectCampaign(parts.intent,parts.ledger,[p],o);
 assert.notDeepEqual(first.movement,next.movement);assert.deepEqual(parts,before);
 const reconciled=reconcileCampaigns([p],o)[0]!,again=reconcileCampaigns([reconciled],o)[0]!;
 assert.equal(reconciled.allocations[0]!.drillers,10);assert.deepEqual(again,reconciled);assert.equal(p.allocations[0]!.drillers,20);assert.deepEqual(campaignParts(again).intent,parts.intent);
});
test('accepted identities survive serialization, do not double debit, and terminal plans stay terminal',()=>{
 const {o,p,source,target}=fixture();o.view.fleets=[];
 const accepted=commitCampaignLedger({plans:[p],campaignId:p.id,source,debit:10,commandId:'accepted',destination:target},o).plans;
 const restored=JSON.parse(JSON.stringify(accepted)) as Campaign[];
 const repeated=commitCampaignLedger({plans:restored,campaignId:p.id,source,debit:10,commandId:'accepted',destination:target},o).plans;
 assert.equal(repeated[0]!.allocations[0]!.drillers,10);assert.deepEqual(repeated[0]!.committedOrders,['accepted']);assert.deepEqual(repeated[0]!.accountedFleets,['accepted']);
 const closed={...repeated[0]!,stage:'cancelled' as const};o.view.tick+=100;assert.deepEqual(reconcileCampaigns([closed],o),[closed]);
});
