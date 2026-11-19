import {test} from 'node:test';
import assert from 'node:assert/strict';
import {outpostNameIndex,resolveOutpostReferences,presentOutpostNames} from '../packages/ai/src/controller/presentation/outpost-references.js';
const observation=()=>({view:{outposts:[{id:'post-a'},{id:'post-b'}]},outpostNames:{'post-a':'TRITON','post-b':'CONGO'}} as any);

test('name index fails closed on missing, duplicate and unauthorized names',()=>{
 const o=observation(),index=outpostNameIndex(o);
 assert.equal(index.resolve('TRITON'),'post-a');assert.throws(()=>index.resolve('TRITO'),/未知/);
 assert.throws(()=>index.resolve('post-a'),/未知/);
 delete o.outpostNames['post-b'];assert.throws(()=>outpostNameIndex(o),/缺少/);
 o.outpostNames['post-b']='TRITON';assert.throws(()=>outpostNameIndex(o),/重复/);
});
test('model boundary rejects raw outpost IDs in nested operations and mixed entity lists',()=>{
 const o=observation();
 for(const input of [
  {action:{kind:'launch',source:'post-a',destination:'CONGO'}},
  {queries:[{arguments:{plans:[{targets:['post-b']}]}}]},
  {set:[{id:'n',entities:['post-a']}]},
 ])assert.throws(()=>resolveOutpostReferences(input,o,{modelInput:true}),/未知据点名称/);
 const input={actions:[{arguments:{action:{kind:'launch',source:'TRITON',destination:'CONGO',}}}],set:[{id:'post-a',text:'post-a',entities:['CONGO','fleet-1']}]};
 const output=resolveOutpostReferences(input,o,{modelInput:true}) as any;
 assert.equal(output.actions[0].arguments.action.source,'post-a');
 assert.equal(output.actions[0].arguments.action.destination,'post-b');
 assert.equal(output.set[0].id,'post-a');assert.equal(output.set[0].text,'post-a');
 assert.deepEqual(output.set[0].entities,['post-b','fleet-1']);
 assert.equal((resolveOutpostReferences({source:'post-a'},o) as any).source,'post-a');
});
test('nested multi-source plans resolve names without rewriting authored IDs or text',()=>{
 const input={plans:[{id:'TRITON',targets:['CONGO'],drafts:[{id:'CONGO',action:{kind:'launch',source:'TRITON',destination:'CONGO',drillers:1,}}]}],text:'TRITON',entities:['TRITON','fleet-1']};
 const before=structuredClone(input),out=resolveOutpostReferences(input,observation()) as any;
 assert.equal(out.plans[0].drafts[0].action.source,'post-a');assert.equal(out.plans[0].drafts[0].action.destination,'post-b');
 assert.deepEqual(out.plans[0].targets,['post-b']);assert.equal(out.plans[0].id,'TRITON');assert.equal(out.plans[0].drafts[0].id,'CONGO');
 assert.equal(out.text,'TRITON');assert.deepEqual(out.entities,['post-a','fleet-1']);assert.deepEqual(input,before);
});
test('fleet identities remain stable but cannot be used as launch destinations',()=>{
 const out=resolveOutpostReferences({action:{kind:'return-fleet',fleetId:'F1-12345678'}},observation()) as any;
 assert.equal(out.action.fleetId,'F1-12345678');
 for(const action of [{source:'secret'},{kind:'launch',source:'TRITON',destination:'F1-12345678'},{kind:'launch',source:'TRITON',destination:'F1-12345678',destinationKind:'fleet'}])assert.throws(()=>resolveOutpostReferences({action},observation()),/未知/);
});
test('model map uses outpost names for identities and links without changing archives',()=>{
 const original={outpostNames:observation().outpostNames,outposts:[{id:'post-a',name:'TRITON',drillers:0}],fleets:[{id:'fleet-1',source:'post-a',destination:{kind:'outpost',id:'post-b'}}],entities:['post-b'],plans:[{id:'post-a'}]};
 const out=presentOutpostNames(original,observation().outpostNames) as any;
 assert.deepEqual(out.outposts,[{name:'TRITON',drillers:0}]);assert.equal(out.fleets[0].source,'TRITON');assert.equal(out.fleets[0].destination.name,'CONGO');
 assert.equal(out.fleets[0].id,'fleet-1');assert.equal(out.plans[0].id,'post-a');assert.deepEqual(out.entities,['CONGO']);assert.equal(original.outposts[0]!.id,'post-a');assert.equal(out.outpostNames,undefined);
});

test('display names preserve authored arrays and stable identities while translating typed references',()=>{
 const input={remove:['post-a'],release:['post-b'],warnings:['post-b'],fields:['post-a'],
  entities:['post-a'],sources:[['post-b',0,2]],ranking:[['post-a',1,'post-b']],
  protections:[{receiptId:'post-a',scope:['source:post-a','destination:outpost:post-b','fleet:post-a']}],
  plans:[{id:'post-b',text:'post-a',targets:['post-a']}],
  arguments:{action:{source:'post-a',destination:'post-b'},text:['post-a']},submittedArguments:'{"source":"post-a"}'};
 const before=structuredClone(input),out=presentOutpostNames(input,observation().outpostNames) as any;
 for(const key of ['remove','release','warnings','fields'])assert.deepEqual(out[key],(input as any)[key]);
 assert.deepEqual(out.entities,['TRITON']);assert.deepEqual(out.sources,[['CONGO',0,2]]);
 assert.deepEqual(out.ranking,[['TRITON',1,'post-b']]);
 assert.deepEqual(out.protections,[{receiptId:'post-a',scope:['source:TRITON','destination:outpost:CONGO','fleet:post-a']}]);
 assert.deepEqual(out.plans,[{id:'post-b',text:'post-a',targets:['TRITON']}]);assert.deepEqual(input,before);
 assert.deepEqual(out.arguments,input.arguments);assert.equal(out.submittedArguments,input.submittedArguments);
});
