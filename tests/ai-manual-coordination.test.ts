
import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import type {ManualCommandReceipt,ManualCommandView} from '../packages/contracts/src/index.js';
import {AiStore,initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {commanderManualObservation,manualMemoryEvidence,pendingManualReceipts,manualEntities,validateManualReview} from '../packages/ai/src/controller/execution/manual-coordination.js';
import {memoryConsistency} from '../packages/ai/src/controller/storage/memory-consistency.js';
import {reconcileCampaigns,type Campaign} from '../packages/ai/src/controller/storage/campaign-state.js';
import {parseAgentReply} from '../packages/ai/src/controller/contracts/reply-protocol.js';
import {planLocalCommit} from '../packages/ai/src/controller/execution/local-commit-plan.js';
import {PlayerGateway,GameRequestError} from '../packages/ai/src/controller/transport/gateway.js';

const receipt=(id:string,version=1,action:ManualCommandReceipt['action']={kind:'launch',source:'outpost-a',destination:'outpost-b',drillers:4}):ManualCommandReceipt=>({id,version,player:0,tick:0,seconds:0,kind:'order',action:action!,outcome:'applied',affectedFleetIds:[],cancelledScheduleIds:[]});
const manual=(receipts:ManualCommandReceipt[]):ManualCommandView=>({version:Math.max(0,...receipts.map(r=>r.version)),receipts,protections:[],receiptsFromVersion:receipts[0]?.version??0,hasEarlierReceipts:false});
function fixture(path=':memory:'){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'manual-test');
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,notebook:[],reminders:[],manualReviewedReceiptIds:[],task:{category:'plan',scope:'local',weight:'medium',reasons:['manual scope'],entities:['outpost-a'],deferred:[]}};
 const state=initialState('manual-test',0,{model:'',personality:'schemer'}),store=new AiStore(path);store.save(state);
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No game writes');}};
 const context=()=>({state,snapshot,gateway,id:'manual-finish',now:o.view.tick*600+o.secondsSinceLastTick,spoken:0,strategicContextAvailable:true,readMemoryReviews:()=>store.memoryReviews(state.roomId,0),readToolResult:(id:string)=>store.queryResult(state.roomId,0,id),readMemoryEvidence:(ref:string)=>store.memoryEvidence(state.roomId,0,ref),readManualReceipt:(id:string)=>store.manualReceipt(state.roomId,0,id)});
 const refresh=()=>snapshot.memoryConsistency=memoryConsistency(state.memory,snapshot);
 refresh();return {state,store,snapshot,gateway,context,refresh};
}

test('manual facts use genuine human evidence, never accepted AI receipts; version invalidates local CAS',()=>{
 const f=fixture();try{
  const old=f.store.localWriteBasis(f.state.roomId,0),r=receipt('human-1');f.snapshot.observation.manualCommands=manual([r]);
  assert.equal(f.store.observeManualCommands(f.state.roomId,0,f.snapshot.observation),true);
  assert.equal(f.store.observeManualCommands(f.state.roomId,0,f.snapshot.observation),false);
  assert.notEqual(f.store.localWriteBasis(f.state.roomId,0),old);
  assert.deepEqual(f.store.memoryEvidence(f.state.roomId,0,'manual:human-1'),{reference:'manual:human-1',kind:'manual-command',actor:'human',outcome:'applied',version:1});
  assert.equal(f.store.memoryEvidence(f.state.roomId,0,'tool:human-1'),undefined);
  assert.equal(manualMemoryEvidence('manual:other',r),undefined);
  assert.throws(()=>f.store.save({...f.state,memory:{...f.state.memory,strategy:'stale'}},'memory-maintained',{},old),/LOCAL_BASIS_CHANGED/);
  assert.equal(f.store.load(f.state.roomId,0)!.memory.strategy,'');
 }finally{f.store.close();}
});

test('finish cannot acknowledge archived human facts absent from the supplied observation',async()=>{
 const f=fixture();try{
  const archived=receipt('unseen',1),current=receipt('visible',2);
  f.snapshot.observation.manualCommands=manual([archived,current]);
  f.store.observeManualCommands(f.state.roomId,0,f.snapshot.observation);
  f.snapshot.observation.manualCommands={...manual([current]),hasEarlierReceipts:true};
  assert.ok(f.context().readManualReceipt(archived.id));
  await assert.rejects(executeTool('finish',{manualReview:{version:2,receiptIds:[archived.id],reason:'Cannot claim an unseen archived fact was reviewed'}},f.context()),/Invalid or stale manualReview/);
  const visible=await executeTool('finish',{manualReview:{version:2,receiptIds:[current.id],reason:'Actually reviewed the current supplied fact'}},f.context()) as any;
  assert.deepEqual(visible.manualReview.receiptIds,[current.id]);
  assert.deepEqual(f.store.manualReviewedReceiptIds(f.state.roomId,0),[],'preparation alone commits nothing');
 }finally{f.store.close();}
});

test('manual cancellation removes exact stale fleet reminders even when cancelled fleet is absent; unrelated work remains',()=>{
 const f=fixture();try{
  f.store.save(f.state,'reminder-set',{id:'old-route',atSeconds:600,note:'Continue cancelled route',entities:['gone-fleet']});
  f.store.save(f.state,'reminder-set',{id:'unrelated',atSeconds:600,note:'Review economy',entities:['outpost-z']});
  f.snapshot.observation.manualCommands=manual([receipt('cancel',1,{kind:'cancel-launch',fleetId:'gone-fleet'})]);
  f.store.observeManualCommands(f.state.roomId,0,f.snapshot.observation);
  assert.deepEqual(f.store.reminders(f.state.roomId,0).map(r=>r.id),['unrelated']);
  assert.equal(f.store.manualReceipt(f.state.roomId,1,'cancel'),undefined);
 }finally{f.store.close();}
});

test('normal finish saves uncertain intent in note prose and exact acknowledgements without touching directives',async()=>{
 const f=fixture();try{
  f.state.commanderDirectives={version:2,text:'Keep pressure, protect the other flank'};f.store.save(f.state);
  f.snapshot.observation.manualCommands=manual([receipt('withdraw')]);
  f.store.observeManualCommands(f.state.roomId,0,f.snapshot.observation);
  const args={notebook:{set:[{id:'manual-goal',kind:'plan',text:'Perhaps regrouping; keep purpose uncertain. Based on human receipt withdraw; protect withdrawn force, do not infer treaty.',expiresWorldDay:null}]},manualReview:{version:1,receiptIds:['withdraw'],reason:'Read exact action; cautiously inferred regrouping, no diplomatic conclusion'}};
  parseAgentReply(JSON.stringify({request:{tool:'finish',arguments:args},summary:'Coordinate next normal step'}));
  let calls=0;const runner=new SeatRunner(f.state,f.store,f.gateway,{step:async()=>{calls++;return {tokens:0,reply:{tool:'finish',arguments:args,summary:'Coordinate'}};}});
  await runner.poll(0,true);
  assert.equal(calls,1);assert.equal(f.state.status,'waiting');
  assert.deepEqual(f.store.load(f.state.roomId,0)!.commanderDirectives,{version:2,text:'Keep pressure, protect the other flank'});
  assert.match(f.store.notebook(f.state.roomId,0,0)[0]!.text,/Perhaps regrouping/);
  assert.equal(f.store.notebook(f.state.roomId,0,0)[0]!.manualIntent,undefined);
  assert.deepEqual(f.store.manualReviewedReceiptIds(f.state.roomId,0),['withdraw']);
 }finally{f.store.close();}
});

test('optional manual acknowledgement never forces another model call or marks omitted facts reviewed',async()=>{
 const f=fixture();try{
  f.snapshot.observation.manualCommands={...manual([receipt('one',2),receipt('two',3)]),hasEarlierReceipts:true};
  const result=await executeTool('finish',{},f.context()) as any;
  assert.equal(result.warnings[0].code,'MANUAL_REVIEW_PENDING');assert.equal(result.manualReview,undefined);
  const ack=validateManualReview({version:3,receiptIds:['two'],reason:'Only second event inspected'},f.snapshot,id=>f.snapshot.observation.manualCommands!.receipts.find(r=>r.id===id))!;
  f.store.save(f.state,'manual-intent-reconciled',ack);f.snapshot.manualReviewedReceiptIds=f.store.manualReviewedReceiptIds(f.state.roomId,0);
  assert.deepEqual(pendingManualReceipts(f.snapshot).map(r=>r.id),['one']);
  assert.equal(f.snapshot.observation.manualCommands.hasEarlierReceipts,true);
  await assert.rejects(executeTool('finish',{manualReview:{version:1,receiptIds:['one'],reason:'old'}},f.context()),/stale manualReview/);
 }finally{f.store.close();}
});

test('manual inference is saved as prose while retired provenance objects are rejected',async()=>{
 const f=fixture();try{
  f.snapshot.observation.manualCommands=manual([receipt('r')]);
  const note={id:'n',kind:'plan',text:'Cautious interpretation',expiresAt:null,basis:'inferred',manualIntent:{actor:'ai',version:1,receiptIds:['r'],confidence:'low'},record:{type:'plan',status:'candidate',summary:'Uncertain purpose',players:[],entities:[],links:[],evidence:['manual:r'],reviewAt:null}};
  for(const changed of [{...note,manualIntent:{...note.manualIntent,actor:'human'}},{...note,basis:'decision'},{...note,manualIntent:{...note.manualIntent,receiptIds:['fake']}}])
    await assert.rejects(executeTool('notebook',{set:[changed]},f.context()),/Invalid tool fields/);
  const accepted=await executeTool('notebook',{set:[{id:'n',kind:'plan',text:'Human action r applied; perhaps regrouping, intent uncertain.',priority:'medium',expiresWorldDay:null}]},f.context()) as any;
  assert.match(accepted.set[0].text,/intent uncertain/);assert.equal(accepted.set[0].manualIntent,undefined);assert.equal(accepted.set[0].record,undefined);
 }finally{f.store.close();}
});

test('human fleets do not masquerade as AI campaign execution; affected campaign needs explicit reconciliation',()=>{
 const f=fixture();try{
  const campaign:Campaign={id:'old',target:'outpost-b',objective:'attack',holdPlan:'hold',cancelWhen:'risk',stage:'assembling',createdTick:0,reviewAtTick:10,allocations:[{source:'outpost-a',drillers:12}],accountedFleets:[],issues:[]};
  const r={...receipt('human-launch'),affectedFleetIds:['human-fleet']};f.snapshot.observation.manualCommands=manual([r]);
  f.snapshot.observation.view.fleets.push({id:'human-fleet',owner:0,position:{x:0,y:0},drillers:4,state:'moving',gift:false,source:'outpost-a',destination:{kind:'outpost',id:'outpost-b'}});
  const [projected]=reconcileCampaigns([campaign],f.snapshot.observation);
  assert.equal(projected!.allocations[0]!.drillers,12);assert.equal(projected!.accountedFleets.length,0);
  assert.equal(projected!.stage,'review');assert.equal(projected!.comparisonInvalidated,true);assert.match(projected!.issues.join(' '),/manual-command/);
  // Future scheduled acceptance had no fleet yet; later protection supplies
  // its real identity without falsely changing scheduled into applied.
  f.snapshot.observation.manualCommands={...manual([{...r,kind:'schedule',outcome:'scheduled',affectedFleetIds:[]}]),protections:[{receiptId:r.id,kind:'fleet',scope:['fleet:human-fleet']}]};
  const [scheduled]=reconcileCampaigns([campaign],f.snapshot.observation);
  assert.equal(scheduled!.allocations[0]!.drillers,12);assert.equal(scheduled!.accountedFleets.length,0);
 }finally{f.store.close();}
});

test('finish removes obsolete plan prose and its reminder atomically without a campaign write path',async()=>{
 const f=fixture();try{
  const campaign:Campaign={id:'old',target:'outpost-b',objective:'attack',holdPlan:'hold',cancelWhen:'risk',stage:'assembling',createdTick:0,reviewAtTick:10,allocations:[{source:'outpost-a',drillers:12}],accountedFleets:[],issues:[]};
  f.snapshot.campaigns=[campaign];f.snapshot.reminders=[{id:'campaign:old',atSeconds:6000,note:'old attack',entities:['outpost-b']}];f.refresh();
  await assert.rejects(executeTool('finish',{campaigns:{close:[{id:'old',status:'cancelled'}]}},f.context()),/Invalid tool fields/);
  f.snapshot.notebook=[{id:'old',kind:'plan',text:'Obsolete proposed attack',updatedAt:0,expiresAt:null}];
  const result=await executeTool('finish',{notebook:{remove:['old']},reminders:{cancel:['campaign:old']}},f.context()) as any;
  const planned=planLocalCommit({kind:'finish',result},f.state.memory,f.snapshot);
  assert.deepEqual(result.notebook.remove,['old']);assert.equal(result.campaigns,undefined);
  assert.equal(planned.events.some(e=>e.kind==='campaign-state'),false);assert.ok(planned.events.some(e=>e.kind==='notebook-removed'));assert.ok(planned.events.some(e=>e.kind==='reminder-cancelled'));
 }finally{f.store.close();}
});

test('authoritative manual journal survives restart and no-op replay, paused AI stays paused with zero calls',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ai-manual-'));const path=join(dir,'ai.db');let f=fixture(path);
 try{
  f.state.enabled=false;f.state.status='paused';f.store.save(f.state);f.snapshot.observation.manualCommands=manual([receipt('persist')]);
  f.store.observeManualCommands(f.state.roomId,0,f.snapshot.observation);f.store.close();
  const store=new AiStore(path);try{
    assert.equal(store.manualReceipt('manual-test',0,'persist')!.outcome,'applied');assert.equal(store.observeManualCommands('manual-test',0,f.snapshot.observation),false);
    let calls=0;const runner=new SeatRunner(store.load('manual-test',0)!,store,f.gateway,{step:async()=>{calls++;throw Error('not permitted');}});
    await runner.poll(0,true);assert.equal(calls,0);assert.equal(store.load('manual-test',0)!.status,'paused');
  }finally{store.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('in-flight old manual version cannot save stale model notes; next normal decision sees the burst',async()=>{
 const f=fixture();try{
  let calls=0;let runner:SeatRunner;
  runner=new SeatRunner(f.state,f.store,f.gateway,{step:async()=>{
    calls++;
    if(calls===1){
      f.snapshot.observation.manualCommands=manual([receipt('redirect',1)]);
      await runner.poll(5001,true);
      return {tokens:0,reply:{tool:'finish',arguments:{memory:{strategy:'STALE PLAN'}},summary:'old result'}};
    }
    return {tokens:0,reply:{tool:'finish',arguments:{manualReview:{version:1,receiptIds:['redirect'],reason:'Preserve exact human action; no broad strategy inferred'}},summary:'new view'}};
  }});
  await runner.poll(0,true);
  assert.equal(calls,2);assert.equal(f.state.status,'waiting');assert.notEqual(f.store.load(f.state.roomId,0)!.memory.strategy,'STALE PLAN');
  assert.deepEqual(f.store.manualReviewedReceiptIds(f.state.roomId,0),['redirect']);
 }finally{f.store.close();}
});


test('manual facts learned at precommit reject stale notes and rebuild without a CAS error',async()=>{
 const f=fixture();try{
  let calls=0;
  const gateway={...f.gateway,manualCheck:async(version:number)=>{
    if(version===0){f.snapshot.observation.manualCommands=manual([receipt('late-human',1)]);throw new GameRequestError(409,structuredClone(f.snapshot.observation),'manual-replan-required');}
  }};
  const runner=new SeatRunner(f.state,f.store,gateway,{step:async()=>{
    calls++;return {tokens:0,reply:{tool:calls===1?'notebook':'finish',arguments:calls===1?{op:'set',id:'stale',kind:'note',text:'STALE PRECOMMIT'}:{manualReview:{version:1,receiptIds:['late-human'],reason:'Current action wins; old candidate discarded'}},summary:'normal finish'}};
  }});
  await runner.poll(0,true);
  assert.equal(calls,2);assert.equal(f.state.status,'waiting');assert.notEqual(f.store.load(f.state.roomId,0)!.memory.strategy,'STALE PRECOMMIT');assert.ok(!f.store.notebook(f.state.roomId,0,0).some(n=>n.id==='stale'));
  assert.deepEqual(f.store.manualReviewedReceiptIds(f.state.roomId,0),['late-human']);
 }finally{f.store.close();}
});

test('program fact storage preserves manual evidence but no model history readback is available',async()=>{
 const f=fixture();try{
  const r=receipt('omitted',1),paths:string[]=[];
  f.snapshot.observation.manualCommands={...manual([receipt('head',105)]),hasEarlierReceipts:true,receiptsFromVersion:6};
  const c={...f.context(),gateway:{...f.gateway,request:async(path:string)=>{paths.push(path);return path.includes('?id=')?{receipt:r}:{version:105,receipts:[r],nextCursor:1,hasMore:true};}},audit:(kind:string,details:unknown)=>f.store.save(f.state,kind,details)};
  f.store.observeManualCommands(f.state.roomId,0,{...f.snapshot.observation,manualCommands:manual([r])});
  const known=f.store.manualReceipt(f.state.roomId,0,'omitted');assert.deepEqual(known,r);
  await assert.rejects(executeTool('recall',{id:'manual-history',afterVersion:0,limit:1},c),/Tool not available/);
  assert.deepEqual(f.store.manualReviewedReceiptIds(f.state.roomId,0),[]);
  const exact=f.store.memoryEvidence(f.state.roomId,0,'manual:omitted')!;
  assert.equal(exact.actor,'human');assert.equal(exact.outcome,'applied');assert.equal(paths.length,0);
  assert.equal(f.store.memoryEvidence(f.state.roomId,0,'tool:omitted'),undefined);assert.equal(f.store.manualReceipt(f.state.roomId,1,'omitted'),undefined);
 }finally{f.store.close();}
});


test('cancelled schedule protection supplies route scope even when its receipt has no action body',()=>{
 const f=fixture();try{
  const {action:omittedAction,...base}=receipt('cancel-route');
  const r={...base,kind:'cancel-schedule' as const,outcome:'cancelled' as const,scheduleId:'old-schedule',cancelledScheduleIds:['old-schedule']};
  f.snapshot.observation.manualCommands={...manual([r]),protections:[{receiptId:r.id,kind:'route',scope:['source:outpost-a','destination:outpost:outpost-b']}]};
  const selected=f.snapshot.observation.manualCommands;
  assert.equal(selected.receipts[0]!.id,r.id);assert.equal(selected.protections[0]!.kind,'route');
  assert.ok(manualEntities(r,selected).includes('outpost-b'));
  const c:Campaign={id:'goal',target:'outpost-b',objective:'Broader valid support goal',holdPlan:'hold',cancelWhen:'goal disproved',stage:'assembling',createdTick:0,reviewAtTick:10,allocations:[{source:'outpost-a',drillers:12}],accountedFleets:[],issues:[]};
  const [updated]=reconcileCampaigns([c],f.snapshot.observation);assert.equal(updated!.stage,'review');assert.equal(updated!.objective,c.objective);assert.deepEqual(updated!.allocations,c.allocations);
 }finally{f.store.close();}
});

test('a current plan body can be replaced or removed without legacy provenance fields',async()=>{
 const f=fixture();try{
  const r=receipt('basis',1);f.snapshot.observation.manualCommands=manual([r,receipt('new',2)]);
  const note={id:'old-inference',kind:'plan' as const,text:'Uncertain older intent',updatedAt:0,expiresAt:null,basis:'inferred' as const,manualIntent:{actor:'ai' as const,version:1,receiptIds:['basis'],confidence:'low' as const},record:{type:'plan' as const,status:'active',summary:'Old conditional plan',players:[],entities:['outpost-a'],links:[],evidence:['manual:basis'],reviewAt:null}};
  f.snapshot.notebook=[note];f.refresh();
  await assert.rejects(executeTool('notebook',{set:[{id:note.id,record:{status:'superseded'}}]},f.context()),/Invalid tool fields/);
  const result=await executeTool('notebook',{set:[{id:note.id,text:'Earlier guess superseded by current facts; broader intent remains unknown.'}]},f.context()) as any;
  assert.equal(result.set[0].manualIntent,undefined);assert.equal(result.set[0].record,undefined);assert.match(result.set[0].text,/intent remains unknown/);
  assert.deepEqual((await executeTool('notebook',{remove:[note.id]},f.context())).remove,[note.id]);
 }finally{f.store.close();}
});


test('owner gateway checks current manual authority and submits the v2 observation revision as an agent',async()=>{
 const f=fixture();const received:{path:string;body:any;controller:unknown}[]=[];
 f.snapshot.observation.manualCommands=manual([receipt('current',2)]);
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const text=Buffer.concat(chunks).toString();received.push({path:req.url!,body:text?JSON.parse(text):null,controller:req.headers['x-subterfuge-controller']});const value=req.url==='/player/v2/owner/control'?{roomId:f.state.roomId,mode:'agent',sessionId:req.headers['x-subterfuge-control-session'],expiresAt:Date.now()+30000}:f.snapshot.observation;res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value));});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 try{
  const gateway=new PlayerGateway(`http://127.0.0.1:${address.port}`,'synthetic',f.state.roomId,0,2);
  await assert.rejects(gateway.manualCheck(0),(error:unknown)=>error instanceof GameRequestError&&error.code==='manual-replan-required'&&error.observation?.manualCommands?.version===2);
  await gateway.manualCheck(2);await gateway.request('/tool/order',{revision:f.snapshot.observation.revision,order:{id:'synthetic-order',action:{kind:'check-in'}}});
  const write=received.at(-1)!;assert.equal(write.path,'/player/v2/owner/commands');assert.equal(write.body.expectedRevision,f.snapshot.observation.revision);assert.equal(write.controller,'agent');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.store.close();}
});


test('commander context bounds unrelated history but keeps all active guard evidence and prioritizes linked entities',()=>{
 const f=fixture();try{
  f.snapshot.observation.manualCommands=manual(Array.from({length:100},(_,i)=>receipt(`bounded-${i+1}`,i+1,{kind:'launch',source:i===0?'linked-old':'unrelated',destination:'other',drillers:1})));
  f.snapshot.observation.manualCommands!.protections=[{receiptId:'bounded-2',kind:'fleet',scope:['fleet:guarded']}];
  const value=commanderManualObservation(f.snapshot.observation,new Set(['linked-old'])).manualCommands!;
  assert.equal(value.receipts.length,9);assert.equal('omittedReceiptCount'in value&&value.omittedReceiptCount,91);
  assert.ok(value.receipts.some(r=>r.id==='bounded-1'));assert.ok(value.receipts.some(r=>r.id==='bounded-2'));
  assert.deepEqual(value.protections,f.snapshot.observation.manualCommands!.protections);
  assert.equal(f.snapshot.observation.manualCommands.receipts.length,100,'prompt projection cannot mutate authoritative input');
 }finally{f.store.close();}
});


test('historical protection-release facts stay readable without restoring a control workflow',()=>{
 const f=fixture();try{
  const {action:ignored,...cancel}=receipt('cancelled-old',1);
  const original:ManualCommandReceipt={...cancel,kind:'cancel-schedule',outcome:'cancelled',scheduleId:'old-schedule',cancelledScheduleIds:['old-schedule']};
  const released:ManualCommandReceipt={id:'released',version:2,player:0,tick:0,seconds:0,kind:'release-protection',outcome:'released',operationId:'owner-release',releasedReceiptIds:[original.id],releasedScopes:['source:outpost-a','destination:outpost:outpost-b'],affectedFleetIds:[],cancelledScheduleIds:[]};
  f.snapshot.observation.manualCommands={...manual([original]),protections:[{receiptId:original.id,kind:'route',scope:released.releasedScopes!}]};
  f.snapshot.notebook=[{id:'guard-plan',kind:'plan',updatedAt:0,text:'Old saved protection assumption requires factual review',expiresAt:null,basis:'inferred',manualIntent:{actor:'ai',version:1,receiptIds:[original.id],confidence:'low'},record:{type:'plan',status:'blocked',summary:'Guard constrains one route, not whole objective',players:[],entities:['outpost-a'],links:[],evidence:['manual:'+original.id],reviewAt:null}}];
  const before=memoryConsistency(f.state.memory,f.snapshot).items.find(i=>i.id==='note:guard-plan')!;
  f.snapshot.observation.manualCommands=manual([original,released]);
  const selected=commanderManualObservation(f.snapshot.observation).manualCommands!;
  assert.deepEqual(selected.receipts.map(r=>r.id).sort(),[original.id,released.id].sort());assert.equal(selected.protections.length,0);
  assert.equal(memoryConsistency(f.state.memory,f.snapshot).items.find(i=>i.id==='note:guard-plan')!.fingerprint===before.fingerprint,false);
  f.store.observeManualCommands(f.state.roomId,0,f.snapshot.observation);
  assert.deepEqual(f.store.memoryEvidence(f.state.roomId,0,'manual:released'),{reference:'manual:released',kind:'manual-command',actor:'human',outcome:'released',version:2});
  const campaign:Campaign={id:'support',target:'outpost-b',objective:'Support the broader campaign',holdPlan:'Preserve compatible units',cancelWhen:'Goal obsolete',stage:'assembling',createdTick:0,reviewAtTick:10,allocations:[{source:'outpost-a',drillers:12}],accountedFleets:[],issues:[],manualBasisVersion:1};
  const reviewed=reconcileCampaigns([campaign],f.snapshot.observation)[0]!;
  assert.equal(reviewed.stage,'review');assert.equal(reviewed.objective,campaign.objective);assert.deepEqual(reviewed.allocations,campaign.allocations);
  assert.equal(released.action,undefined);assert.deepEqual(released.cancelledScheduleIds,[]);
 }finally{f.store.close();}
});

test('historical release readback never revives reminders or starts an already paused provider',async()=>{
 const f=fixture();try{
  f.state.enabled=false;f.state.status='paused';f.store.save(f.state);
  f.store.save(f.state,'reminder-set',{id:'cancelled-watch',atSeconds:600,note:'old route',entities:['old-fleet']});
  f.snapshot.observation.manualCommands=manual([receipt('cancelled',1,{kind:'cancel-launch',fleetId:'old-fleet'})]);
  f.store.observeManualCommands(f.state.roomId,0,f.snapshot.observation);assert.equal(f.store.reminders(f.state.roomId,0).length,0);
  const released:ManualCommandReceipt={id:'release',version:2,player:0,tick:0,seconds:0,kind:'release-protection',outcome:'released',operationId:'release-one',releasedReceiptIds:['cancelled'],releasedScopes:['fleet:old-fleet'],affectedFleetIds:[],cancelledScheduleIds:[]};
  f.snapshot.observation.manualCommands=manual([...f.snapshot.observation.manualCommands.receipts,released]);
  assert.equal(f.store.observeManualCommands(f.state.roomId,0,f.snapshot.observation),true);assert.equal(f.store.observeManualCommands(f.state.roomId,0,f.snapshot.observation),false);
  assert.equal(f.store.reminders(f.state.roomId,0).length,0);
  let calls=0;const runner=new SeatRunner(f.state,f.store,f.gateway,{step:async()=>{calls++;throw Error('Provider must stay paused');}});
  await runner.poll(0,true);assert.equal(calls,0);assert.equal(f.store.load(f.state.roomId,0)!.status,'paused');
  const read=f.store.memoryEvidence(f.state.roomId,0,'manual:release')!;
  assert.equal(read.outcome,'released');assert.equal(f.store.manualReviewedReceiptIds(f.state.roomId,0).length,0);
  await assert.rejects(executeTool('recall',{id:'manual:release'},f.context()),/Tool not available/);
  await assert.rejects(executeTool('releaseManualProtection',{receiptIds:['cancelled']},f.context()),/Tool not available/);
 }finally{f.store.close();}
});


test('same-version natural guard expiry invalidates only relevant saved note review and requires no control action',()=>{
 const f=fixture();try{
  const own=receipt('cancel-mine',1,{kind:'toggle-mine',outpostId:'home'}),other=receipt('other-guard',2,{kind:'cancel-launch',fleetId:'other-fleet'});
  f.snapshot.observation.manualCommands={...manual([own,other]),protections:[{receiptId:own.id,kind:'outpost',scope:['outpost:home']},{receiptId:other.id,kind:'fleet',scope:['fleet:other-fleet']}]};
  f.snapshot.notebook=[{id:'mine-plan',kind:'plan',updatedAt:0,text:'Respect the mine order while its guard is active',expiresAt:null,basis:'inferred',manualIntent:{actor:'ai',version:2,receiptIds:[own.id],confidence:'low'},record:{type:'plan',status:'blocked',summary:'Reassess only this mine dependency on current facts',players:[],entities:['home'],links:[],evidence:['manual:'+own.id],reviewAt:null}}];
  const before=memoryConsistency(f.state.memory,f.snapshot).items[0]!;
  const saved=[{id:before.id,fingerprint:before.fingerprint,seconds:f.snapshot.observation.view.tick*600+f.snapshot.observation.secondsSinceLastTick,reason:'Read current guard'}];
  assert.equal(memoryConsistency(f.state.memory,f.snapshot,saved).items[0]!.reviewNeeded,false);
  f.snapshot.observation.manualCommands!.protections=f.snapshot.observation.manualCommands!.protections.filter(p=>p.receiptId!==other.id);
  assert.equal(memoryConsistency(f.state.memory,f.snapshot,saved).items[0]!.fingerprint,before.fingerprint,'unrelated guard lifecycle must not dirty this note');
  f.snapshot.observation.manualCommands!.protections=[];
  const after=memoryConsistency(f.state.memory,f.snapshot,saved).items[0]!;
  assert.equal(f.snapshot.observation.manualCommands!.version,2);assert.notEqual(after.fingerprint,before.fingerprint);assert.equal(after.reviewNeeded,true);
  assert.equal(after.manualAuthority?.activeProtectionCount,0);assert.deepEqual(after.manualAuthority?.receiptIds,[own.id]);
  assert.notEqual(after.manualAuthority?.activeProtectionBasis,before.manualAuthority?.activeProtectionBasis);assert.ok(!JSON.stringify(after.manualAuthority).includes('scope'),'context must not repeat raw guard arrays per note');
  assert.equal(f.snapshot.notebook[0]!.record!.status,'blocked','fact projection does not silently rewrite authored notes');
 }finally{f.store.close();}
});
