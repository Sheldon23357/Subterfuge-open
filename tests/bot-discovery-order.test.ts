import {test} from 'node:test';
import assert from 'node:assert/strict';
import {botDiscoveryQueues,botDiscoveryOrder} from '../packages/ai/src/controller/analysis/tactical-search-order.js';
import type {BotCandidate} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
const attack=(id:string,source:string,force:number,target='enemy'):BotCandidate=>({id,kind:'attack',objective:'capture:'+target,targets:[target],priority:50,forceEstimate:{committed:force,required:60},drafts:[{id,issueTick:100,action:{kind:'launch',source,destination:target,drillers:force}}],reasons:[]});
const transfer=(i:number):BotCandidate=>({...attack('transfer-'+i,'rear',43),kind:'logistics',objective:'position:'+i,drafts:[{id:'e-'+i,issueTick:100,action:{kind:'launch',source:'rear',destination:'enemy',drillers:43,}}]});
const kinds=['defense','attack','economy','fleet','logistics','scout'] as const;
test('ordinary estimated and full forces are discovered before crowded logistics variations',()=>{
 const rows=[...Array.from({length:30},(_,i)=>transfer(i)),attack('half','LIR',43),attack('estimated','LIR',61),attack('full','LIR',86)];
 const ordered=botDiscoveryOrder(botDiscoveryQueues(rows,kinds),2);
 assert.deepEqual(ordered.slice(0,2).map(c=>c.id),['estimated','full']);
 assert.equal(new Set(ordered.map(c=>c.id)).size,rows.length);assert.equal(ordered.length,rows.length);
});
test('source coverage tests another army before a second amount from the first source',()=>{
 const rows=[attack('large-half','large',43),attack('large-estimated','large',61),attack('large-full','large',86),attack('other','other',70)];
 const ordered=botDiscoveryOrder(botDiscoveryQueues(rows,kinds),3);
 assert.deepEqual(ordered.slice(0,3).map(c=>c.id),['large-estimated','other','large-full']);
});
test('buffered LIR seed and full army both enter the bounded pass despite many smaller sources',()=>{
 const lir=[61,43,86].map(n=>({...attack('LIR-'+n,'LIR',n),forceEstimate:{committed:n,required:43}}));
 const others=Array.from({length:9},(_,i)=>attack('other-'+i,'other-'+i,30-i));
 const ordered=botDiscoveryOrder(botDiscoveryQueues([...lir,...others,...Array.from({length:20},(_,i)=>transfer(i))],kinds),8);
 assert.equal(ordered[0]!.id,'LIR-61');assert.ok(ordered.findIndex(c=>c.id==='LIR-86')<8);
 assert.ok(ordered.findIndex(c=>c.id==='LIR-43')>ordered.findIndex(c=>c.id==='LIR-86'));
});
test('real incoming defense stays ahead of attacks while ordinary role queues remain available',()=>{
 const defend:BotCandidate={id:'defend',kind:'defense',objective:'defend:home',targets:['home'],drafts:[],priority:100,reasons:[]};
 const rows=[attack('attack','LIR',86),defend,...Array.from({length:20},(_,i)=>transfer(i))];
 const ordered=botDiscoveryOrder(botDiscoveryQueues(rows,kinds),2,new Set(['home']));
 assert.deepEqual(ordered.slice(0,2).map(c=>c.id),['defend','attack']);assert.equal(ordered[2]!.kind,'logistics');
});
test('joint, fleet editing and logistics launches do not masquerade as ordinary direct coverage',()=>{
 const ordinary=attack('direct','LIR',61),joint={...attack('joint','rear',100),drafts:[...attack('a','rear',50).drafts,...attack('b','front',50).drafts]};
 const edit=attack('edit','rear',100);edit.drafts[0]!.action.fleetId='existing';
 const ordered=botDiscoveryOrder(botDiscoveryQueues([joint,edit,transfer(0),ordinary],kinds),1);
 assert.equal(ordered[0]!.id,'direct');assert.equal(ordered.length,4);
});
test('explicit hybrid strategic priorities survive the ordinary force coverage pass',()=>{
 const rows=[attack('large','LIR',86,'unrelated'),attack('chosen','small',61,'chosen')];
 const ordered=botDiscoveryOrder(botDiscoveryQueues(rows,kinds),1,new Set(),c=>c.targets.includes('chosen')?100:0);
 assert.equal(ordered[0]!.id,'chosen');
});
test('ordering is deterministic, preserves inputs and also works without ordinary attack candidates',()=>{
 const rows=Array.from({length:10},(_,i)=>transfer(i)),groups=botDiscoveryQueues(rows,kinds),before=structuredClone(groups);
 const first=botDiscoveryOrder(groups,4);assert.deepEqual(botDiscoveryOrder(groups,4),first);assert.deepEqual(groups,before);assert.equal(first.length,10);
});
