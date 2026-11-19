import {expandSchemaReferences} from './helpers/schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {geminiGenerationSchema} from '../packages/ai/src/application/providers/gemini-schema.js';
import {intentSchemaFor,parseIntentResult} from '../plugins/hybrid/src/intent-protocol.js';
import {modelResponseSchema,decodeModelResponse} from '../plugins/hybrid/src/model-wire.js';
import {normalizeIntentResult} from '../plugins/hybrid/src/intent-compatibility.js';
import {applyIntentEdits} from '../plugins/hybrid/src/intents.js';
import {initialHybridState} from '../plugins/hybrid/src/contracts.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';

test('Gemini keeps per-action structure, full reference descriptions and unchanged application capacity',()=>{
 const posts=Array.from({length:80},(_,i)=>'POST-'+i);
 const schema=modelResponseSchema(intentSchemaFor('strategy',posts,[],['F1']),{friendlyPosts:posts.slice(0,5)});
 const original=structuredClone(schema),wire=geminiGenerationSchema(schema) as any;
 assert.deepEqual(schema,original);assert.equal(schema.properties.tasks.maxItems,12);
 assert.equal(wire.properties.tasks.maxItems,undefined);
 const variants=expandSchemaReferences(wire).properties.tasks.items.anyOf;
 const returned=variants.find((s:any)=>s.properties.kind.enum[0]==='return-fleet');
 assert.ok(returned.required.includes('fleetId'));assert.equal(returned.properties.target,undefined);
 const capture=variants.find((s:any)=>s.properties.kind.enum[0]==='capture');
 assert.ok(capture.properties.target.description.includes('POST-79'));
 assert.equal(capture.properties.target.enum,undefined);
 assert.deepEqual(wire.required,schema.required);
});

test('relaxed generation constraints never permit invalid references, capacities or force values through the host parser',()=>{
 const parse=(raw:unknown)=>parseIntentResult(normalizeIntentResult(decodeModelResponse(raw,'strategy'),[],'strategy',0).value,'strategy',2,new Set(['a','b']));
 const capture=(target:string)=>({kind:'capture',target,until:120});
 assert.throws(()=>parse({tasks:[capture('unknown')]}),/authorized reference/);
 assert.throws(()=>parse({tasks:Array.from({length:13},()=>capture('a'))}),/at most 12/);
 assert.throws(()=>parse({needsInformation:['unknown']}),/Unexpected intent fields/);
 assert.throws(()=>parse({reviewOn:Array.from({length:17},()=> 'review')}),/at most 16/);
 assert.throws(()=>parse({tasks:[{kind:'transfer',source:'a',target:'b',drillers:0,until:120}]}),/positive integer/);
 assert.throws(()=>parse({tasks:[{kind:'return-fleet',fleetId:'unknown',until:120}]}),/authorized reference/);
});

test('publication still rejects expired deadlines, enemy allocation and invented task identities',()=>{
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'gemini-validation');
 const own=o.view.outposts.find(p=>p.owner===0)!,enemy=o.view.outposts.find(p=>p.owner===1)!;
 const edit=(task:any,id:string|null=null)=>({upsert:[{id,task}],cancel:[]});
 const capture={kind:'capture' as const,target:enemy.id,until:120,priority:50,reason:''};
 assert.throws(()=>applyIntentEdits(initialHybridState(),edit({...capture,until:0}),'model',0,o),/future/);
 assert.throws(()=>applyIntentEdits(initialHybridState(),edit({kind:'transfer',source:own.id,target:enemy.id,drillers:1,until:120,priority:50,reason:''}),'model',0,o),/friendly/);
 assert.throws(()=>applyIntentEdits(initialHybridState(),edit(capture,'invented'),'model',0,o),/Unknown intent/);
});
