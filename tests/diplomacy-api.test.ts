import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';

test('real authenticated API shares proposals only with participants, counters, signs once and restores paid subsidy',async t=>{
 const setup:FleetSetup={size:{width:40,height:40},positions:{a:{x:0,y:0},b:{x:3,y:0},c:{x:15,y:0}},economy:{initialTick:0,teamSize:0,
  players:Array.from({length:3},()=>({active:true,neptunium:100,minesCreated:0})),outposts:['a','b','c'].map((id,owner)=>({id,owner,type:'generator',drillers:100,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))}};
 const h=protocolHarness(t,{room:{state:createFleetScenario(setup),scheduled:[]}});
 const server=await createOwnerPlayerApi(h);server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
 const call=async(player:number,path:string,body?:unknown)=>fetch(base+'/player/v2'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+h.ownerCredentials.credentials[player]!.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const observed=async(p:number)=>(await call(p,'/owner/observation')).json();
 const write=async(p:number,id:string,action:unknown)=>{
  const o=await observed(p),body={kind:'order',clientCommandId:id,expectedRevision:o.revision,payload:{action}};
  const response=await call(p,'/owner/commands',body);return {response,body};
 };
 try{
  const discovery=await(await fetch(base+'/player/v2/protocol')).json();
  assert.ok(discovery.capabilities.includes('diplomacy/2'));assert.equal(discovery.rulesetVersion,'4');
  const first=await write(0,'propose',{kind:'propose-agreement',peer:1,terms:{kind:'joint-attack',enemy:2},subsidy:null,counterTo:null});
  assert.equal(first.response.status,200);const proposed=await first.response.json(),id=proposed.diplomacy.agreements.at(-1).id;
  assert.equal(proposed.diplomacy.agreements.at(-1).status,'proposed');assert.equal(typeof id,'string');
  assert.equal((await observed(1)).diplomacy.agreements[0].id,id);assert.deepEqual((await observed(2)).diplomacy.agreements,[]);
  assert.equal((await write(2,'intruder',{kind:'respond-agreement',agreementId:id,response:'accept'})).response.status,400);
  const counter=await write(1,'counter',{kind:'propose-agreement',peer:0,terms:{kind:'joint-attack',enemy:2},subsidy:{payer:0,amount:15},counterTo:id});
  assert.equal(counter.response.status,200);const counterId=(await counter.response.json()).diplomacy.agreements.at(-1).id;
  const accept=await write(0,'accept',{kind:'respond-agreement',agreementId:counterId,response:'accept'});
  assert.equal(accept.response.status,200);const receipt=await accept.response.json();assert.equal(receipt.diplomacy.agreements.at(-1).status,'active');
  const retry=await call(0,'/owner/commands',accept.body);assert.equal(retry.status,200);assert.deepEqual(await retry.json(),receipt);
  const mine=await observed(0),peer=await observed(1);
  assert.equal(mine.view.self.neptunium,85);assert.equal(peer.view.self.neptunium,115);
  assert.equal(mine.diplomacy.agreements.find((a:{id:string})=>a.id===counterId).deadline,200);
  assert.equal(mine.diplomacy.agreements.find((a:{id:string})=>a.id===id).status,'superseded');
  assert.equal(mine.diplomacy.receipts.filter((r:{kind:string})=>r.kind==='agreement-subsidy').length,1);
  const invalid=await write(0,'bad-duration',{kind:'propose-agreement',peer:1,terms:{kind:'ceasefire',outposts:['a','b']},subsidy:null,counterTo:null,duration:20});
  assert.equal(invalid.response.status,400);
  const page=await(await call(0,'/owner/diplomacy/receipts?after=0&limit=2')).json();
  assert.equal(page.receipts.length,2);assert.equal(page.hasMore,true);assert.ok(page.agreements.every((a:{players:number[]})=>a.players.includes(0)));
  assert.equal((await(await call(2,'/owner/diplomacy/receipts?after=0')).json()).receipts.length,0);
  assert.equal((await call(0,'/owner/diplomacy/receipts?after=999')).status,400);

 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 h.restart();const restored=h.store.load()!.room.state;
 assert.equal(restored.economy.players[0]!.neptunium,85);assert.equal(restored.economy.players[1]!.neptunium,115);
 assert.equal(restored.diplomacy.agreements.filter(a=>a.status==='active').length,1);
 assert.equal(restored.diplomacy.receipts.filter(r=>r.kind==='agreement-subsidy').length,1);
});
