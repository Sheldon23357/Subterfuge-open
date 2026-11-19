import {readPromptMaterial} from '../packages/contracts/src/prompt-sections.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {initialHybridState,type IntentTask,type StrategicAssessment} from '../plugins/hybrid/src/contracts.js';
import {diplomacyEditScope,assertDiplomacyEdits} from '../plugins/hybrid/src/diplomacy-edit-scope.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';
import {validateDiplomacyMessage} from '../plugins/hybrid/src/diplomacy-message.js';
import {publishContractIntent} from '../plugins/hybrid/src/server-contracts.js';

function fixture(){
 const setup:FleetSetup={size:{width:80,height:80},positions:{a:{x:0,y:0},r:{x:2,y:0},b:{x:8,y:0},c:{x:12,y:0},d:{x:16,y:0}},economy:{initialTick:100,teamSize:0,
  players:Array.from({length:4},()=>({active:true,neptunium:20,minesCreated:0})),outposts:['a','r','b','c','d'].map((id,i)=>({id,owner:[0,0,1,2,3][i]!,type:'generator',drillers:100,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))}};
 const room={state:createFleetScenario(setup),scheduled:[]};
 room.state=submitFleetOrder(room.state,{id:'signed',player:0,action:{kind:'propose-agreement',peer:1,terms:{kind:'joint-attack',enemy:2},subsidy:null,counterTo:null}}).state;
 room.state=submitFleetOrder(room.state,{id:'accept',player:1,action:{kind:'respond-agreement',agreementId:'signed',response:'accept'}}).state;
 const o=observation(room,0,'scope-test');o.outpostNames={a:'ALPHA',r:'RALLY',b:'BRAVO',c:'CHARLIE',d:'DELTA'};
 const saved=initialHybridState();
 const task=(id:string,target:string,origin?:IntentTask['origin'],authority:IntentTask['authority']='model'):IntentTask=>({id,authority,version:1,commanderVersion:0,spec:{kind:'capture',target,priority:50,until:180,reason:'保留实际计划'},status:'pending',reason:'等待可执行方案',createdAt:100,updatedAt:100,...(origin?{origin}:{})});
 saved.intents=[task('independent','d'),task('same-enemy-independent','c'),task('contract-task','c',{kind:'diplomacy',conversation:'1',agreementId:'signed'}),task('other-chat','d',{kind:'diplomacy',conversation:'3',agreementId:'other'}),task('commander','c',undefined,'commander')];
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:4,roster:[0,1,2,3].map(i=>({gamePlayer:i,chatPlayer:i,displayName:'Player '+i}))};
 const state=initialState('scope-test',0,{mode:'hybrid',model:'test',personality:'schemer'});
 const material=()=>makeBrief({id:'diplomacy',kind:'diplomacy',scope:'1',posts:['c','d'],messageIds:[],players:[1]},state,snapshot,saved);
 return {o,saved,snapshot,material};
}
const result=(id:string|null=null,target='c'):StrategicAssessment=>({summary:'',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],message:null,agreement:{status:'none',summary:'',forbidAttack:false,forbiddenTargets:[],internalIntent:'',expiresWorldDay:null},diplomacyAction:null,intentEdits:{upsert:[{id,task:{kind:'capture',target,until:180,priority:50,reason:'履约'}}],cancel:[]}});

test('diplomacy material exposes only its contract task IDs and keeps independent plans read-only',()=>{
 const f=fixture();f.o.view.outposts.find(p=>p.id==='c')!.visibility=2;
 const before=structuredClone(f.saved),m=f.material(),b=readPromptMaterial(m.prompt),h=b.guidance;
 assert.deepEqual(f.saved,before);
 assert.deepEqual(h.intentTasks.byKind.capture.rows.map((r:any[])=>r[0]),['contract-task']);
 assert.ok(!h.readOnlyIntentTasks.byKind.capture.columns.includes('id'));
 assert.equal(h.readOnlyIntentTasks.byKind.capture.rows.length,4);
 assert.ok(JSON.stringify(h.readOnlyIntentTasks).includes('DELTA'),'strategic facts remain available');
 for(const id of ['independent','same-enemy-independent','other-chat','commander']){
  assert.ok(!JSON.stringify(m.responseSchema).includes('"'+id+'"'));
 }
 const schema=m.responseSchema;
 assert.deepEqual(b.facts.permissions.cancelTaskIds,['contract-task']);assert.equal(schema.properties.cancel.items.enum,undefined);
 const item=schema.properties.tasks.items;
 assert.deepEqual(b.facts.permissions.tasks.find((v:any)=>v.kind==='capture').targets,['CHARLIE']);
 const agreements=h.serverAgreements.current.jointAttack;
 const contract=Object.fromEntries(agreements.columns.map((key:string,i:number)=>[key,agreements.rows[0][i]]));
 assert.deepEqual(contract.edits.captureTargets,['CHARLIE']);
 assert.deepEqual(contract.feasibility.existingEnemyCaptureTasks,['contract-task']);
 assert.deepEqual(contract.taskFeasibility.map((r:any)=>r.taskId),['contract-task']);
 assert.ok((m.brief.guidance as any).editPolicy.contracts[0].captureTargets.includes('CHARLIE'),'full guard material remains independent');
 assert.ok(item.anyOf.some((v:any)=>v.properties.kind.enum[0]==='configure'),'valid defensive support remains available');
});

test('rejected cross-role edits cannot change tasks or enqueue an otherwise legal proposal',()=>{
 const f=fixture(),scope=diplomacyEditScope(f.o,f.saved.intents!,'1',[1]);
 for(const id of ['independent','same-enemy-independent','other-chat','commander'])for(const cancel of [false,true]){
  const a=result(id);if(cancel)a.intentEdits={upsert:[],cancel:[id]};
  a.diplomacyAction={kind:'propose-agreement',peer:1,terms:{kind:'ceasefire',outposts:['a','b']},subsidy:null,counterTo:null};
  const before=structuredClone(f.saved);
  assert.throws(()=>assertDiplomacyEdits(a,scope),/只读/);
  assert.throws(()=>publishContractIntent(f.saved,f.o,a,'1',[1],0),/只读/);
  assert.deepEqual(f.saved,before,'invalid task output cannot partially publish a proposal');
 }
 assert.throws(()=>assertDiplomacyEdits(result(null,'d'),scope),/目标或舰队范围/);
 assert.doesNotThrow(()=>assertDiplomacyEdits(result('contract-task'),scope));
 const m=f.material();assert.throws(()=>validateDiplomacyMessage(result('same-enemy-independent'),m.brief,f.o.outpostNames),/只读/);
});

test('personal fulfilment removes capture permission but retains safe support and contract-task cancellation',()=>{
 const f=fixture(),agreement=f.o.diplomacy!.agreements.find(a=>a.id==='signed')!;
 agreement.fulfilled[0]=true;agreement.progress[0]=10;
 const m=f.material(),item=m.responseSchema.properties.tasks.items;
 assert.equal(item.properties,undefined);
 assert.ok(!m.permissions.tasks.some(v=>v.kind==='capture'));
 assert.deepEqual((m.brief.guidance as any).editPolicy.contracts[0].captureTargets,[]);
 assert.throws(()=>publishContractIntent(f.saved,f.o,result(),'1',[1],0),/占领目标已达标/);
 const cancel=result();cancel.intentEdits={upsert:[],cancel:['contract-task']};
 assert.doesNotThrow(()=>publishContractIntent(f.saved,f.o,cancel,'1',[1],0));
 assert.equal(f.saved.intents!.find(t=>t.id==='contract-task')!.status,'cancelled');
 const support=result();support.intentEdits!.upsert=[{id:null,task:{kind:'configure',target:'a',priority:80,minDrillers:20,maxDrillers:null,maintain:true,until:180,reason:'防守'}}];
 assert.doesNotThrow(()=>publishContractIntent(f.saved,f.o,support,'1',[1],0));
 assert.equal(f.saved.intents!.at(-1)!.origin?.agreementId,'signed');
});

test('publication rechecks current ownership and personal fulfilment after material was prepared',()=>{
 const f=fixture(),m=f.material();assert.doesNotThrow(()=>validateDiplomacyMessage(result(),m.brief,f.o.outpostNames));
 f.o.view.outposts.find(p=>p.id==='c')!.owner=3;
 assert.throws(()=>publishContractIntent(f.saved,f.o,result(),'1',[1],0),/目标或舰队范围/);
 f.o.view.outposts.find(p=>p.id==='c')!.owner=2;
 f.o.diplomacy!.agreements[0]!.fulfilled[0]=true;
 assert.throws(()=>publishContractIntent(f.saved,f.o,result(),'1',[1],0),/占领目标已达标/);
});

test('multiple contracts keep task updates and cancellations bound to the selected source',()=>{
 const f=fixture(),other=structuredClone(f.o.diplomacy!.agreements[0]!);other.id='second';
 f.o.diplomacy!.agreements.push(other);
 const task=structuredClone(f.saved.intents!.find(t=>t.id==='contract-task')!);task.id='second-task';task.origin!.agreementId='second';f.saved.intents!.push(task);
 const scope=diplomacyEditScope(f.o,f.saved.intents!,'1',[1]);
 assert.throws(()=>assertDiplomacyEdits(result(),scope),/多份合同/);
 assert.throws(()=>assertDiplomacyEdits({...result('second-task'),fulfillAgreementId:'signed'},scope),/只读/);
 assert.doesNotThrow(()=>assertDiplomacyEdits({...result('second-task'),fulfillAgreementId:'second'},scope));
 const cancel={...result(),fulfillAgreementId:'signed',intentEdits:{upsert:[],cancel:['second-task']}};
 assert.throws(()=>assertDiplomacyEdits(cancel,scope),/只读/);
});

test('ceasefire-only and unavailable fleet capabilities do not expose empty enum or capture choices',()=>{
 const f=fixture(),a=f.o.diplomacy!.agreements[0]!;a.terms={kind:'ceasefire',outposts:['a','b']};
 const m=f.material(),item=m.responseSchema.properties.tasks.items;
 assert.equal(item.properties,undefined);
 assert.ok(!JSON.stringify(m.responseSchema).includes('"enum":[]'));
 assert.throws(()=>publishContractIntent(f.saved,f.o,result(),'1',[1],0),/目标或舰队范围/);
});

test('new fulfilment tasks bind a unique contract without rewriting an independent task on the same target',()=>{
 const f=fixture();
 const old=structuredClone(f.saved.intents!.find(t=>t.id==='contract-task')!);old.id='old-contract-task';old.origin!.agreementId='previous-contract';
 f.saved.intents=f.saved.intents!.filter(t=>t.id!=='contract-task');f.saved.intents.push(old);
 publishContractIntent(f.saved,f.o,result(),'1',[1],0);
 const independent=f.saved.intents!.find(t=>t.id==='same-enemy-independent')!;
 assert.equal(independent.origin,undefined);assert.equal(independent.version,1);
 assert.equal(f.saved.intents!.find(t=>t.id==='old-contract-task')!.version,1);
 assert.equal(f.saved.intents!.find(t=>t.id==='old-contract-task')!.origin?.agreementId,'previous-contract');
 assert.equal(f.saved.intents!.at(-1)!.origin?.agreementId,'signed');
 assert.throws(()=>publishContractIntent(f.saved,f.o,{...result(),fulfillAgreementId:'guessed'},'1',[1],0),/不猜测/);
 f.o.diplomacy!.agreements[0]!.status='expired';
 const m=f.material();assert.equal(m.permissions.maxTasks,0);assert.equal(m.permissions.maxCancel,0);
});
