import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {AiStore,initialState} from '../packages/ai/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {emptyReceiptObservations,reduceReceiptJournal,observeReceipts,restoreReceiptObservations,registerReceiptObserver,serverOrderId,type ReceiptObservation} from '../packages/ai/src/controller/execution/receipt-observation.js';
function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'observer');return o;
}
const intent=(id:string,tool='order',kind='launch')=>({id,tool,arguments:{action:{kind,source:'source',destination:'target',drillers:10}}});
test('typed observers distinguish command acceptance, visible departure',()=>{
 const o=fixture(),id='command-one',fleetId=serverOrderId(id,0);o.view.tick=100;
 o.view.fleets=[{id:fleetId,owner:0,state:'waiting',drillers:10,gift:false,position:{x:0,y:0},source:'source',destination:{kind:'outpost',id:'target'},secondsUntilLaunch:600}];
 let state=reduceReceiptJournal(emptyReceiptObservations(o.roomId),'tool-intent',intent(id),o);
 assert.equal(state.records.length,0,'an intent is not accepted');
 state=reduceReceiptJournal(state,'tool-result',{id,tool:'order',result:o},o);
 assert.equal(state.records.find(r=>r.id===`receipt:${id}`)!.fact,'command-accepted');assert.equal(state.records.find(r=>r.id===`fleet:${id}`)!.state,'awaitingVisibleTransition');
 o.view.tick=101;o.revision='moving';o.view.fleets[0]!.state='moving';state=observeReceipts(state,o);
 assert.equal(state.records.find(r=>r.id===`fleet:${id}`)!.fact,'visible-moving');
 assert.ok(!JSON.stringify(state).includes('arrived'));

});
test('disappearance and coincidentally added drillers prove neither arrival nor destruction',()=>{
 const o=fixture(),id='disappeared',fleetId=serverOrderId(id,0);o.view.tick=100;
 o.view.fleets=[{id:fleetId,owner:0,state:'waiting',drillers:10,gift:false,position:{x:0,y:0},source:'source',destination:{kind:'outpost',id:'target'},secondsUntilLaunch:600}];
 let state=reduceReceiptJournal(emptyReceiptObservations(o.roomId),'tool-intent',intent(id),o);state=reduceReceiptJournal(state,'tool-result',{id,tool:'order',result:o},o);
 o.view.fleets=[];o.view.outposts[0]!.drillers=(o.view.outposts[0]!.drillers??0)+10;o.view.tick++;
 state=observeReceipts(state,o);assert.equal(state.records.find(r=>r.predicate.kind==='fleet-state')!.state,'unknown');assert.equal(state.records.find(r=>r.predicate.kind==='fleet-state')!.fact,undefined);
 o.view.tick=200;state=observeReceipts(state,o);assert.equal(state.records.find(r=>r.predicate.kind==='fleet-state')!.state,'expired');
});

test('pending write evidence survives old-history windows and stays isolated by room and seat',()=>{
 const store=new AiStore(':memory:'),state=initialState('observer',0,{model:'',personality:'sentinel'});
 try{
  const args={to:1,text:'complete pending message'};
  store.save(state,'tool-intent',{id:'old-chat',tool:'say',arguments:args});
  store.save(state,'tool-unknown',{id:'old-chat',tool:'say',result:{status:'unknown',error:'transport interrupted'}});
  for(let i=0;i<100;i++)store.save(state,'synthetic-padding',{i});
  const rows=store.pendingWriteEvidence('observer',0,['old-chat','old-chat']);
  assert.equal(rows.length,1);assert.equal(rows[0]!.tool,'say');assert.deepEqual(rows[0]!.arguments,args);
  assert.equal(rows[0]!.evidence.kind,'tool-unknown');
  assert.equal(store.pendingWriteEvidence('observer',1,['old-chat'])[0]!.tool,'unknown');
  assert.equal(store.pendingWriteEvidence('other',0,['old-chat'])[0]!.arguments,undefined);
 }finally{store.close();}
});
test('partial batch records only explicitly accepted children and never completes authored obligations',()=>{
 const o=fixture();let state=emptyReceiptObservations(o.roomId);
 for(const id of ['accepted','rejected','unknown'])state=reduceReceiptJournal(state,'batch-item-intent',intent(id),o);
 state=reduceReceiptJournal(state,'batch-item-result',{id:'accepted',status:'accepted',revision:o.revision},o);
 state=reduceReceiptJournal(state,'batch-item-result',{id:'rejected',status:'rejected',error:'no capacity'},o);
 state=reduceReceiptJournal(state,'batch-item-unknown',{id:'unknown'},o);
 state=observeReceipts(state,o);
 assert.deepEqual(state.records.map(r=>r.commandId),['accepted']);assert.equal(state.records[0]!.fact,'command-accepted');
 assert.ok(!JSON.stringify(state).includes('campaign'));assert.ok(!JSON.stringify(state).includes('reminder'));
});
test('observer replay spans all original log pages and survives an interruption after source receipt before derived state',()=>{
 const dir=mkdtempSync(join(tmpdir(),'receipt-replay-')),path=join(dir,'seat.sqlite'),o=fixture(),state=initialState('observer',0,{model:'',personality:'sentinel'});let store=new AiStore(path);
 try{
  store.save(state,'observation-baseline',o);store.save(state,'tool-intent',intent('old-command'));
  for(let i=0;i<90;i++)store.save(state,'synthetic-padding',{i});
  store.save(state,'tool-result',{id:'old-command',tool:'order',result:o});
  const restored=restoreReceiptObservations(store,'observer',0);assert.equal(restored.records[0]!.fact,'command-accepted');
  store.save(state,'receipt-observation-state',restored);store.save(state,'tool-intent',intent('after-checkpoint'));
  o.scheduled=[{id:serverOrderId('after-checkpoint',0),player:0,issueTick:102,status:'pending',action:{kind:'launch'}}];
  store.save(state,'tool-result',{id:'after-checkpoint',tool:'order',result:o});
  store.close();store=new AiStore(path);
  const replayed=restoreReceiptObservations(store,'observer',0);assert.equal(replayed.records.filter(r=>r.predicate.kind==='command-recorded').length,2);assert.equal(replayed.records.find(r=>r.id==='receipt:after-checkpoint')!.fact,'command-accepted');
  assert.deepEqual(restoreReceiptObservations(store,'observer',1).records,[]);
  const duplicate=reduceReceiptJournal(replayed,'tool-result',{id:'after-checkpoint',tool:'order',result:o},o);assert.equal(duplicate.records.length,replayed.records.length);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('restricted observer schema rejects unsupported predicates and command identity changes',()=>{
 const o=fixture(),state=emptyReceiptObservations(o.roomId);
 const record:ReceiptObservation={id:'x',owner:'system',roomId:o.roomId,player:0,commandId:'x',predicate:{kind:'command-recorded',commandId:'x'},state:'pendingReceipt',deadlineSeconds:600,onMismatch:'wake'};
 assert.throws(()=>registerReceiptObserver(state,{...record,predicate:{kind:'arrive-and-mine'} as any}),/predicate/);
 assert.throws(()=>registerReceiptObserver(state,{...record,roomId:'other'}),/observer/);
 const saved=registerReceiptObserver(state,record);assert.throws(()=>registerReceiptObserver(saved,{...record,predicate:{kind:'activity',commandId:'x',minimumCheckinTime:1,clearWarnings:true}}),/identity conflict/);
 const original=reduceReceiptJournal(state,'tool-intent',intent('same'),o);
 assert.throws(()=>reduceReceiptJournal(original,'tool-intent',intent('same','order','check-in'),o),/identity conflict/);
});
