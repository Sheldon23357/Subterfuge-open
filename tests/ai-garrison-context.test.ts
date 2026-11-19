
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {garrisonContext,expandGarrisonContext,GARRISON_FORMAT} from '../packages/ai/src/controller/presentation/garrison-context.js';
const compactAnalysis=<T>(value:T):T=>value;
const compactMaps=compactAnalysis;
import {worldTimeContext} from '../packages/ai/src/controller/presentation/world-time-context.js';
import {decisionContextBreakdown} from '../packages/ai/src/controller/presentation/prompt-decision-breakdown.js';

const json=(v:unknown)=>JSON.parse(JSON.stringify(v));
function map(){return {format:'decision-map/1',tick:12,player:0,ownerEconomy:[{owner:0,capacity:100,used:42}],outposts:[
 {id:'post-0',name:'REMOVABLE',visibility:'observed',owner:0,type:'factory',drillers:0,destroyed:false,minePending:false,shield:0,shieldMax:20,shieldsEnabled:false,production:{active:true,paused:false,output:6,cycleMinutes:120,nextMinutes:0.125,contribution:0,capacity:null,futureRule:17}},
 {id:'fog',visibility:'ownership-only',owner:null},
 {id:'typed',visibility:'type-known',owner:1,type:'generator',destroyed:false},
 {id:'empty',visibility:'observed',owner:0,type:'mine',drillers:0,shield:null,production:null},
 ],fleets:[{id:'fleet-0',owner:0,drillers:0,source:'post-0',destination:{kind:'outpost',id:'typed'},secondsUntilLaunch:0.25}],};}
function expected(v:ReturnType<typeof map>){
 const copy=json(worldTimeContext(v));
 for(const p of copy.outposts){if(p.production){delete p.production.contribution;delete p.production.cycleWorldDays;delete p.production.nextWorldDays;}}
 return copy;
}
for(const compact of [compactAnalysis,compactMaps])test(`garrison round trip preserves all non-approved fields with ${compact.name}`,()=>{
 const input=map(),before=json(input),wire=json(compact(garrisonContext(worldTimeContext(input))));
 assert.equal(wire.garrisonFormat,GARRISON_FORMAT);
 const decoded=expandGarrisonContext(wire) as ReturnType<typeof map>;
 assert.deepEqual(decoded,expected(input));assert.deepEqual(input,before);
 assert.deepEqual(decoded.ownerEconomy,input.ownerEconomy);
});

test('unrecognized or conflicting formats remain readable and untouched; nested forecasts share encoding',()=>{
 const current=map(),forecast={...map(),format:'decision-forecast-map/1'};
 const bundle={observation:{view:current},receipt:{forecast},unrelated:{outposts:[{id:'x'}],fleets:[]}};
 const wire=garrisonContext(worldTimeContext(bundle)) as any;
 assert.equal(wire.observation.view.garrisonFormat,GARRISON_FORMAT);assert.equal(wire.receipt.forecast.garrisonFormat,GARRISON_FORMAT);
 assert.equal(wire.unrelated.garrisonFormat,undefined);
 const conflict={...map(),outposts:[{id:'p',visibility:'observed',归属:'future-field',owner:0}]};
 assert.deepEqual(garrisonContext(conflict),conflict);
 const duplicate={...map(),outposts:[{id:'post-0'},{id:'post-0'}]};
 assert.deepEqual(expandGarrisonContext(garrisonContext(duplicate)),duplicate);
});

test('only mathematically duplicated production display times are removed',()=>{
 const input={format:'decision-map/1',outposts:[{id:'x',production:{cycleMinutes:120,cycleWorldDays:99,nextWorldDays:null,contribution:50}}],fleets:[],};
 const decoded=expandGarrisonContext(garrisonContext(input)) as any;
 assert.deepEqual(decoded.outposts[0].production,{cycleMinutes:120,cycleWorldDays:99,nextWorldDays:null});
});

for(const compact of [compactAnalysis,compactMaps])test(`new garrison category counts conserve exact serialized characters (${compact.name})`,()=>{
 const view=json(compact(garrisonContext(worldTimeContext(map()))));
 const value={observation:{view},chat:[],notebook:[]};
 const body=JSON.stringify(value),prompt=`当前受限情报及新消息：${body}\n本轮行动与回执（按执行顺序）：[]`;
 const result=decisionContextBreakdown(prompt)!;
 assert.ok(result);assert.ok(result.sections.outposts!>0);assert.ok(result.sections.production!>0);assert.equal(result.sections.specialists,undefined);
 assert.equal(Object.values(result.sections).reduce((a,b)=>a+b,0),result.total);
 assert.equal(result.total,'当前受限情报及新消息：'.length+body.length+1);
 // Independent expected payload count, including each field header once per
 // group, not once per row; generic wrappers remain in outposts.
 const tables=view.outposts;
 let prod=0;
 const add=(field:string,values:unknown[])=>{if(field==='生产')prod+=JSON.stringify(field).length+values.reduce<number>((a,b)=>a+JSON.stringify(b).length,0);};
 if(Array.isArray(tables))for(const row of tables)for(const [key,x]of Object.entries(row))add(key,[x]);
 else for(const group of tables.groups)group.fields.forEach((f:string,i:number)=>add(f,group.rows.map((r:unknown[])=>r[i+1])));
 assert.equal(result.sections.production,prod);assert.equal(result.sections.specialists,undefined);
 const oldValue={observation:{view:compact(worldTimeContext(map()))}};
 const old=decisionContextBreakdown(`当前受限情报及新消息：${JSON.stringify(oldValue)}\n本轮行动与回执（按执行顺序）：[]`)!;
 assert.equal(old.sections.production,undefined);assert.equal(old.sections.outposts,JSON.stringify(oldValue.observation.view).length>0?JSON.stringify((oldValue.observation.view as any).outposts).length:0);
});

test('future field names and version markers are not reinterpreted through Object prototypes',()=>{
 const input=JSON.parse('{"format":"decision-map/1","outposts":[{"id":"p","visibility":0.5,"constructor":17,"__proto__":{"future":true},"production":{"constructor":0,"__proto__":null}}],"fleets":[]}');
 assert.deepEqual(expandGarrisonContext(json(garrisonContext(input))),input);
 for(const marker of [null,0,''])assert.deepEqual(garrisonContext({...input,garrisonFormat:marker}),{...input,garrisonFormat:marker});
});

test('malformed archived garrison table does not crash diagnostic reads',()=>{
 const value={observation:{view:{garrisonFormat:GARRISON_FORMAT,outposts:{encoding:'column-groups/1',length:1,groups:[{fields:['生产'],rows:[[0]]}]}}}};
 assert.equal(decisionContextBreakdown(`当前受限情报及新消息：${JSON.stringify(value)}\n本轮行动与回执（按执行顺序）：[]`),undefined);
});
