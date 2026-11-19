import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeIntentResult} from '../plugins/hybrid/src/intent-compatibility.js';
import {parseIntentResult} from '../plugins/hybrid/src/intent-protocol.js';
import type {IntentTask} from '../plugins/hybrid/src/contracts.js';
import {intentSchemaFor,intentOutputExample} from '../plugins/hybrid/src/intent-schema.js';
import {parseModelJson} from '../packages/ai/src/controller/contracts/model-json.js';
const old=():IntentTask=>({id:'intent-1',version:2,spec:{kind:'capture',target:'A',priority:63,until:100,reason:'existing'},authority:'model',commanderVersion:0,status:'pending',reason:'',createdAt:0,updatedAt:0});
const wire=(task:Record<string,unknown>,id:string|null='intent-1')=>({summary:'plan',tasks:{upsert:[{id,task}],cancel:[]},reviewOn:[]});
const capture=()=>({kind:'capture',target:'A',until:90,reason:'keep goal'});
const parse=(raw:unknown)=>parseIntentResult(raw,'strategy',2,new Set(['A']));

test('schema-derived empty examples show root boundaries and round-trip without adding required fields',()=>{
 for(const kind of ['strategy','diplomacy','commander'] as const){
  const schema=intentSchemaFor(kind,['A']),required=[...schema.required],example=intentOutputExample(schema) as Record<string,any>;
  assert.deepEqual(Object.keys(example).sort(),Object.keys(schema.properties).sort());
  assert.deepEqual(example.tasks,{upsert:[],cancel:[]});assert.deepEqual(example.reviewOn,[]);assert.equal(example.needsInformation,undefined);
  assert.ok(!Object.hasOwn(example.tasks,'reviewOn'));assert.ok(!Object.hasOwn(example.tasks,'needsInformation'));
  const reply=parseModelJson(JSON.stringify(example));
  assert.doesNotThrow(()=>parseIntentResult(normalizeIntentResult(reply,[],kind,0).value,kind,2,new Set(['A'])));
  assert.deepEqual(schema.required,required);assert.ok(!schema.required.includes('tasks'));
 }
});

test('prematurely closed root objects remain invalid JSON rather than being guessed into actions',()=>{
 for(const text of ['{"tasks":{"upsert":[]},"reviewOn":[]},"needsInformation":[]}',
  '{"summary":"keep","message":null},"agreement":{"status":"none"}}']){
  assert.throws(()=>parseModelJson(text),/invalid-semantic-json/);
 }
});

test('allowlisted normalization moves priority, ignores avoid priority and keeps original output intact',()=>{
 const raw=wire(capture());Object.assign(raw.tasks.upsert[0]!,{priority:53.42});
 const snapshot=structuredClone(raw),moved=normalizeIntentResult(raw,[],'strategy',10);
 assert.equal(parse(moved.value).intentEdits!.upsert[0]!.task.kind,'capture');
 assert.deepEqual(moved.changes,[{path:'tasks.upsert[0].task.priority',rule:'move-priority',value:53.42}]);assert.deepEqual(raw,snapshot);
 for(const priority of [null,0,60,100]){
  const normalized=normalizeIntentResult(wire({...capture(),kind:'avoid',priority},null),[],'strategy',10);
  assert.equal(parse(normalized.value).intentEdits!.upsert[0]!.task.kind,'avoid');assert.equal(normalized.changes[0]!.rule,'drop-avoid-priority');
 }
});

test('missing priority inherits exact live task value without changing other required fields',()=>{
 const result=normalizeIntentResult(wire(capture()),[old()],'strategy',10);
 assert.equal((parse(result.value).intentEdits!.upsert[0]!.task as any).priority,63);
 assert.equal(result.changes[0]!.rule,'inherit-priority');
 const configure={...old(),spec:{kind:'configure' as const,target:'A',priority:44,until:100,reason:'reserve',minDrillers:20,maxDrillers:null,maintain:true}};
 const result2=normalizeIntentResult(wire({kind:'configure',target:'A',until:90,reason:'reserve',minDrillers:20,maxDrillers:null,maintain:true}),[configure],'strategy',10);
 assert.equal((parse(result2.value).intentEdits!.upsert[0]!.task as any).priority,44);
});

test('inheritance refuses new, unknown, retargeted, terminal, expired, readonly and concurrently changed tasks',()=>{
 const raw=wire(capture());
 const cases:[unknown,IntentTask[],IntentTask[]?][]=[
  [wire(capture(),'unknown'),[old()]],[wire({...capture(),target:'B'}),[old()]],
  ...(['completed','expired','cancelled'] as const).map(status=>[raw,[{...old(),status}]] as [unknown,IntentTask[]]),
  [raw,[{...old(),spec:{...old().spec,until:10}}]],[raw,[{...old(),authority:'commander'}]],
  [raw,[old()],[{...old(),version:3}]],[raw,[old()],[]],
 ];
 for(const [value,existing,current] of cases){const result=normalizeIntentResult(value,existing,'strategy',10,current);assert.equal(result.changes.length,0);assert.throws(()=>parse(result.value),/tasks.upsert\[0\].task.priority/);}
});

test('compatible syntax still rejects invalid values, conflicts and missing execution parameters',()=>{
 for(const task of [{...capture(),priority:null},{...capture(),priority:101},{...capture(),kind:'configure'}]){
  const normalized=normalizeIntentResult(wire(task),[old()],'strategy',10);assert.throws(()=>parse(normalized.value));
 }
 const conflict=wire({...capture(),priority:30});Object.assign(conflict.tasks.upsert[0]!,{priority:40});assert.throws(()=>parse(normalizeIntentResult(conflict,[old()],'strategy',10).value),/unexpected tasks.upsert\[0\].priority/);
 const badCount=wire({...capture(),kind:'configure',priority:50,minDrillers:"20 troops",maxDrillers:null,maintain:true});
 assert.throws(()=>parse(badCount),/tasks.upsert\[0\].task.minDrillers/);
});

test('minimal model edits get neutral defaults without inventing targets, deadlines or transport quantity',()=>{
 const raw={tasks:{upsert:[{task:{kind:'capture',target:'A',until:90}}]}};
 const normalized=normalizeIntentResult(raw,[],'strategy',10),result=parse(normalized.value);
 assert.deepEqual(result.intentEdits,{upsert:[{id:null,task:{kind:'capture',target:'A',until:90,reason:'',priority:50}}],cancel:[]});
 assert.deepEqual(raw,{tasks:{upsert:[{task:{kind:'capture',target:'A',until:90}}]}});
 const schema=intentSchemaFor('strategy',['A']);assert.ok(!schema.required.includes('tasks'));
 const captureSchema=schema.properties.tasks.properties.upsert.items.properties.task.anyOf.find((s:any)=>s.properties.kind.enum.includes('capture'));
 assert.deepEqual(captureSchema.required,['kind','target','until']);
 for(const task of [{kind:'capture',target:'A'},{kind:'capture',until:90},{kind:'transfer',source:'A',target:'B',until:90}]){
  assert.throws(()=>parseIntentResult(normalizeIntentResult({tasks:{upsert:[{task}]}},[],'strategy',10).value,'strategy',2,new Set(['A','B'])));
 }
});

test('scalar strings and surplus task metadata normalize before semantic validation',()=>{
 const result=parse(normalizeIntentResult({tasks:{upsert:[{task:{kind:'configure',target:'A',until:'90',minDrillers:'20',maintain:'false',reason2:'extra explanation'}}]}},[],'strategy',10).value);
 assert.deepEqual(result.intentEdits!.upsert[0]!.task,{kind:'configure',target:'A',until:90,minDrillers:20,maintain:false,reason:'',maxDrillers:null,priority:50});
 const fleet=normalizeIntentResult({tasks:{upsert:[{task:{kind:'return-fleet',fleetId:'F',until:90,priority:'70'}}]}},[],'strategy',10);
 const returned=parseIntentResult(fleet.value,'strategy',2,new Set(['A']),new Set(['F']));
 assert.deepEqual(returned.intentEdits!.upsert[0]!.task,{kind:'return-fleet',fleetId:'F',until:90,reason:''});
 assert.ok(fleet.changes.some(c=>c.rule==='drop-extra-field'&&c.path.endsWith('.priority')));
});

test('fenced and JSON-encoded semantic results normalize without extracting prose or repairing malformed JSON',()=>{
 const raw={summary:'hold'},json=JSON.stringify(raw);
 for(const text of ['```json\n'+json+'\n```',JSON.stringify(json),'\uFEFF'+json]){
  const reply=parseModelJson(text);
  assert.equal(parse(normalizeIntentResult(reply,[],'strategy',10).value).summary,'hold');
 }
 for(const text of ['answer: '+json,'{"summary":"hold",}',JSON.stringify([raw])])assert.throws(()=>parseModelJson(text));
});

test('optional diplomacy metadata does not invent a confirmed commitment or weaken commander constraints',()=>{
 const result=parseIntentResult(normalizeIntentResult({message:'先交换情报'},[],'diplomacy',10).value,'diplomacy',2,new Set(['A']));
 assert.equal(result.agreement.status,'none');assert.equal(result.agreement.jointAttack,null);assert.equal(result.message,'先交换情报');
 assert.throws(()=>parseIntentResult(normalizeIntentResult({agreement:{status:'confirmed'}},[],'diplomacy',10).value,'diplomacy',2,new Set(['A'])),/fulfillment/);
 assert.throws(()=>parseIntentResult(normalizeIntentResult({constraints:{forbiddenPlayerz:[1]}},[],'commander',10).value,'commander',2,new Set(['A'])),/Invalid commander constraints/);
 assert.throws(()=>parseIntentResult(normalizeIntentResult({},[],'commander',10).value,'commander',2,new Set(['A'])),/Unexpected intent fields/);
 assert.ok(intentSchemaFor('commander',['A']).required.includes('constraints'));
});

test('normalized edits still reject duplicate identities, unknown references and contradictory diplomacy',()=>{
 const duplicate=wire(capture());duplicate.tasks.upsert.push(structuredClone(duplicate.tasks.upsert[0]!));
 assert.throws(()=>parse(normalizeIntentResult(duplicate,[old()],'strategy',10).value),/duplicate upsert ID/);
 const unknown=normalizeIntentResult(wire({...capture(),target:'unknown',priority:50}),[],'strategy',10);assert.throws(()=>parse(unknown.value),/task.target/);
 const request=wire({...capture(),priority:50});Object.assign(request,{needsInformation:['unknown']});assert.throws(()=>parse(request),/Unexpected intent fields/);
 const diplomatic={...wire({...capture(),priority:50}),message:null,agreement:{status:'confirmed',fulfillment:'none',jointAttack:null}};
 assert.throws(()=>parseIntentResult(normalizeIntentResult(diplomatic,[old()],'diplomacy',10).value,'diplomacy',2,new Set(['A'])),/agreement.fulfillment/);
});


test('duplicate edit-level textual reasons are audited without changing canonical tasks or original output',()=>{
 const tasks=[{kind:'capture',target:'A',until:90,priority:80,reason:'canonical attack'},
  {kind:'transfer',source:'A',target:'B',drillers:6,until:90,priority:85,reason:'canonical transport'},
  {kind:'avoid',target:'B',until:90,reason:'canonical restriction'}];
 const raw={tasks:{upsert:tasks.map((task,i)=>({id:null,task,reason:'duplicate explanation '+i})),cancel:[]}};
 const before=structuredClone(raw),normalized=normalizeIntentResult(raw,[],'strategy',10);
 const result=parseIntentResult(normalized.value,'strategy',2,new Set(['A','B']));
 assert.deepEqual(result.intentEdits!.upsert.map(e=>e.task),tasks);assert.deepEqual(raw,before);
 assert.deepEqual(normalized.changes.filter(c=>c.rule==='drop-extra-field'),tasks.map((_,i)=>({path:`tasks.upsert[${i}].reason`,rule:'drop-extra-field',value:'duplicate explanation '+i})));
 for(const extra of [{reason:{source:'A'}},{source:'A'},{until:100}]){
  const invalid={tasks:{upsert:[{id:null,task:tasks[0],...extra}]}};
  assert.throws(()=>parseIntentResult(normalizeIntentResult(invalid,[],'strategy',10).value,'strategy',2,new Set(['A','B'])),/Invalid task identity/);
 }
 const missing={tasks:{upsert:[{id:null,task:{kind:'transfer',target:'B',until:90},reason:'from A with 6 troops'}]}};
 assert.throws(()=>parseIntentResult(normalizeIntentResult(missing,[],'strategy',10).value,'strategy',2,new Set(['A','B'])),/Invalid intent task/);
});
