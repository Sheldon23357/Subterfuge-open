
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initialState,executeTool,type AiSnapshot,type NotebookEntry} from '../packages/ai/src/index.js';
import type {Campaign} from '../packages/ai/src/controller/storage/campaign-state.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {memoryConsistency} from '../packages/ai/src/controller/storage/memory-consistency.js';
function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const snapshot:AiSnapshot={observation:observation({state:createFleetScenario(cfg),scheduled:[]},0,'room'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3,notebook:[],reminders:[]};
 const state=initialState('room',0,{model:'',personality:'schemer'});
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No real writes');}};
 return {snapshot,state,context:{snapshot,state,gateway,id:'test',spoken:0,now:60000}};
}
function note(f:ReturnType<typeof fixture>):NotebookEntry{return {id:'stable',kind:'plan',text:'截至100：只按已观察结果复核；尚未承诺救援。',updatedAt:60000,expiresAt:null,record:{type:'plan',status:'active',summary:'复核结果，不承诺救援',players:[],entities:[],links:[],evidence:[`observation:${f.snapshot.observation.revision}@${f.snapshot.observation.view.tick}`],reviewAt:null}};}
test('archived IDs require a new explicit body and cannot restore content or old metadata implicitly',async()=>{
 const f=fixture();let historicalReads=0;
 const context={...f.context,readNotebookEntry:()=>{historicalReads++;return note(f);}};
 await assert.rejects(executeTool('notebook',{set:[{id:'stable',priority:'high'}]},context),/Invalid notebook entry/);
 const result=await executeTool('notebook',{set:[{id:'stable',kind:'note',text:'明确新建的当前判断',expiresWorldDay:null}]},context) as any;
 assert.equal(result.set[0].text,'明确新建的当前判断');assert.equal(result.set[0].record,undefined);assert.equal(historicalReads,0);
});

test('reminder semantic equality ignores key/entity order and explicit default; reschedules and changed text remain writes',async()=>{
 const f=fixture(),ids=f.snapshot.observation.view.outposts.slice(0,2).map(p=>p.id);
 f.snapshot.reminders=[{id:'r',atSeconds:60600,note:'复核',entities:ids}];
 const same={note:'复核',entities:[...ids].reverse(),category:'plan',atSeconds:60600,id:'r'};
 assert.equal((await executeTool('reminders',{set:[same]},f.context) as any).set.length,0);
 for(const change of [{atSeconds:61200},{note:'复核另一条件'},{category:'military'}])assert.equal((await executeTool('reminders',{set:[{...same,...change}]},f.context) as any).set.length,1);
 assert.equal((await executeTool('reminders',{cancel:['r'],set:[same]},f.context) as any).set.length,1);
 await assert.rejects(executeTool('reminders',{set:[same,same]},f.context),/Invalid reminder/);
});
test('removed basis, source clocks and structured records are rejected without changing current prose',async()=>{
 const f=fixture(),before=structuredClone(f.snapshot);
 for(const extra of [{basis:'observed'},{basisTick:99},{record:{evidence:['tool:fake']}},{expiresAt:null}])await assert.rejects(executeTool('notebook',{set:[{id:'new',kind:'plan',text:'当前正文',...extra}]},f.context),/INVALID_TOOL_FIELDS/);
 assert.deepEqual(f.snapshot,before);
});

test('structured evidence cannot be smuggled through a second note in an otherwise valid batch',async()=>{
 const f=fixture(),before=structuredClone(f.snapshot);
 await assert.rejects(executeTool('notebook',{set:[{id:'source',kind:'note',text:'实际观察'}, {id:'stable',kind:'plan',text:'未知结果',record:{evidence:['note:source','tool:forged']}}]},f.context),/INVALID_TOOL_FIELDS/);
 assert.deepEqual(f.snapshot,before);
});

test('campaign review fingerprints cover authored decisions while ignoring derived movement counters',()=>{
 const f=fixture();const p:Campaign={id:'p',target:'target',objective:'争胜',holdPlan:'守住',cancelWhen:'新增威胁',stage:'assembling',createdTick:100,reviewAtTick:101,allocations:[{source:'a',drillers:1},{source:'b',drillers:2}],accountedFleets:[],issues:[]};
 f.snapshot.campaigns=[p];const before=memoryConsistency(f.state.memory,f.snapshot),fingerprint=before.items[0]!.fingerprint;
 const receipts=before.items.map(i=>({...i,seconds:60000,reason:'核对'}));
 const changed:Partial<Campaign>[]=[{allocations:[{source:'a',drillers:99},{source:'b',drillers:2}]},{reviewAtTick:105},{defenseOverrides:[{source:'a',retainDrillers:0,reason:'接受风险'}]},{comparison:{resultRef:'query',planId:'attack'}},{comparisonInvalidated:true},{committedOrders:['order']}];
 for(const change of changed){f.snapshot.campaigns=[{...p,...change}];const result=memoryConsistency(f.state.memory,f.snapshot,receipts).items[0]!;assert.notEqual(result.fingerprint,fingerprint);assert.equal(result.reviewNeeded,true);}
 f.snapshot.campaigns=[{...p,allocations:[...p.allocations].reverse(),movement:{waiting:5,moving:3},issues:['派生提示'],accountedFleets:['bookkeeping']}];
 assert.equal(memoryConsistency(f.state.memory,f.snapshot).items[0]!.fingerprint,fingerprint);
});


test('text-only patches retain active kind, expiry and priority while dropping no current body fields',async()=>{
 const f=fixture(),n:NotebookEntry={id:'stable',kind:'plan',priority:'high',text:'现有正文',updatedAt:59000,expiresAt:61200};f.snapshot.notebook=[n];const before=structuredClone(n);
 const result=await executeTool('finish',{notebook:{set:[{id:n.id,text:'更新后的完整正文'}]}},f.context) as any;
 const saved=result.notebook.set[0];assert.equal(saved.expiresAt,61200);assert.equal(saved.kind,'plan');assert.equal(saved.priority,'high');assert.equal(saved.updatedAt,60000);assert.equal(saved.record,undefined);assert.deepEqual(n,before);
 assert.equal((await executeTool('notebook',{set:[{id:n.id}]},f.context) as any).set.length,0);
});

test('explicit null expiry and kind changes apply to current prose without a hidden lifecycle envelope',async()=>{
 const f=fixture();f.snapshot.notebook=[{id:'stable',kind:'plan',priority:'medium',text:'原计划',updatedAt:59000,expiresAt:61200}];
 const result=await executeTool('notebook',{set:[{id:'stable',kind:'note',text:'保留为当前判断',expiresWorldDay:null}]},f.context) as any;
 assert.equal(result.set[0].kind,'note');assert.equal(result.set[0].expiresAt,null);assert.equal(result.active.length,1);
 assert.equal(f.snapshot.notebook[0]!.kind,'plan');
});

test('expired or removed bodies are not inherited when an ID is reused',async()=>{
 const f=fixture();f.snapshot.notebook=[{id:'expired',kind:'plan',text:'已失效的旧计划',priority:'high',updatedAt:59000,expiresAt:59999}];
 const c={...f.context,readNotebookEntry:()=>note(f)};
 for(const id of ['expired','removed'])await assert.rejects(executeTool('notebook',{set:[{id,text:'缺少新类型'}]},c),/Invalid notebook entry/);
 const result=await executeTool('notebook',{set:[{id:'expired',kind:'note',text:'明确的新正文',expiresWorldDay:null}]},c) as any;
 assert.equal(result.active.length,1);assert.equal(result.active[0].text,'明确的新正文');assert.equal(result.active[0].updatedAt,60000);
});

test('patch compatibility preserves strict new-record, type, evidence and atomic finish validation',async()=>{
 const f=fixture(),n=note(f);f.snapshot.notebook=[n];const before=structuredClone(f.snapshot);
 for(const patch of [{id:'new',kind:'plan',text:'new',record:{status:'active'}},{id:n.id,record:null},{id:n.id,record:{type:'agreement'}},{id:n.id,record:{evidence:['tool:forged']}},{id:n.id,record:{evidence:[]}},{id:n.id,text:null}])await assert.rejects(executeTool('finish',{memory:{strategy:'must not save'},notebook:{set:[patch]}},f.context));
 await assert.rejects(executeTool('finish',{memory:{strategy:'must not save'},notebook:{set:[{id:n.id,text:'valid patch'},{id:'invalid-new',record:{status:'active'}}]}},f.context));
 assert.deepEqual(f.snapshot,before);assert.equal(f.state.memory.strategy,'');
});

test('relation edits use ordinary full prose and priority-only edits preserve the original body age',async()=>{
 const f=fixture();f.snapshot.notebook=[{id:'relation:1',kind:'note',text:'信任未知；合作尚未确认。',priority:'medium',updatedAt:59000,expiresAt:null}];
 const result=await executeTool('notebook',{set:[{id:'relation:1',priority:'high'}]},f.context) as any;
 assert.equal(result.set[0].updatedAt,59000);assert.equal(result.set[0].text,f.snapshot.notebook[0]!.text);assert.equal(result.set[0].priority,'high');
 await assert.rejects(executeTool('notebook',{set:[{id:'relation:1',record:{scores:{trust:50}}}]},f.context),/INVALID_TOOL_FIELDS/);
});
