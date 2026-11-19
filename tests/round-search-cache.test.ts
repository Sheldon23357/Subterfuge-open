import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {RoundSearchCache,searchInputKey} from '../packages/ai/src/controller/analysis/round-search-cache.js';
import {ForecastPool} from '../packages/ai/src/controller/analysis/tactical-forecast-pool.js';
import {foregroundInputKey} from '../plugins/hybrid/src/foreground-input.js';
import {initialHybridState,basisOf} from '../plugins/hybrid/src/contracts.js';

function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'round-cache');
 return {o,saved:initialHybridState()};
}
test('executable fingerprint ignores wording and audit versions, but retains task and constraint changes',()=>{
 const {o,saved}=fixture();
 saved.directive={version:1,basis:basisOf(o),summary:'old',objectives:[],forbiddenPlayers:[1],protectedSources:[],reserves:[],reviewOn:[],commanderVersion:0,commanderConstraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]},agreements:[]};
 const before=foregroundInputKey(saved,o);saved.directive.summary='new wording';saved.directive.version++;saved.directive.basis.revision='other';
 assert.equal(foregroundInputKey(saved,o),before);
 saved.directive.forbiddenPlayers=[];assert.notEqual(foregroundInputKey(saved,o),before);
 const unrestricted=foregroundInputKey(saved,o);
 saved.intents=[{id:'task',version:1,spec:{kind:'capture',target:o.view.outposts[0]!.id,priority:50,until:o.view.tick+100,reason:'old'},authority:'model',commanderVersion:0,status:'pending',reason:'',createdAt:0,updatedAt:0}];
 const task=foregroundInputKey(saved,o);assert.notEqual(task,unrestricted);saved.intents[0]!.spec.reason='new';saved.intents[0]!.version++;
 assert.equal(foregroundInputKey(saved,o),task);saved.intents[0]!.status='running';assert.equal(foregroundInputKey(saved,o),task);
 saved.intents[0]!.status='blocked';assert.notEqual(foregroundInputKey(saved,o),task);
 saved.intents[0]!.status='cancelled';assert.equal(foregroundInputKey(saved,o),unrestricted);
 saved.messages.push({id:'message',conversation:'1',to:[1],text:'hello',basis:basisOf(o),messageIds:[],status:'pending',agreement:{conversation:'1',players:[1],status:'none',summary:'',forbidAttack:false,forbiddenTargets:[],internalIntent:'',expiresWorldDay:null,evidence:[],tick:0}});
 assert.equal(foregroundInputKey(saved,o),unrestricted,'queued chat does not invalidate tactical inputs');
});
test('round cache isolates seats and inputs, drops all previous-round entries and bounds memory',()=>{
 const cache=new RoundSearchCache<{items:number[]}>(),key=searchInputKey({value:1});cache.set('seat',10,key,{items:[1]});
 cache.get('seat',10,key)!.items.push(2);assert.deepEqual(cache.get('seat',10,key),{items:[1]});
 assert.equal(cache.get('other',10,key),undefined);assert.equal(cache.get('seat',10,searchInputKey({value:1,extra:undefined})),undefined);
 assert.equal(cache.get('seat',11,key),undefined);
 cache.set('seat',10,'late',{items:[9]});assert.equal(cache.get('seat',11,'late'),undefined,'late prior-round completion cannot populate current cache');
 const bounded=new RoundSearchCache<number>(1024,1);bounded.set('s',1,'a',1);bounded.set('s',1,'b',2);assert.equal(bounded.get('s',1,'a'),undefined);
});
test('shared forecasts reuse only this round and invalidate time, parameters and the next round',async()=>{
 const {o}=fixture(),pool=new ForecastPool(2),signal=new AbortController().signal,request={targetTick:o.view.tick+4,drafts:[]};
 try{
  const first=await pool.run(o,[request],signal,undefined,1),computeBefore=pool.snapshot().computeMs;
  assert.deepEqual(await pool.run(o,[request],signal,undefined,1),first);
  assert.equal(pool.snapshot().computeMs,computeBefore,'same-round shared hit avoids dispatch and worker time');
  assert.equal(pool.snapshot().cacheHits,1);
  await pool.run(o,[request],signal,undefined,2);assert.equal(pool.snapshot().cacheHits,1,'neither cache level reuses the previous round');
  const changed=structuredClone(o);changed.secondsSinceLastTick+=1;
  await pool.run(changed,[request],signal,undefined,2);assert.equal(pool.snapshot().cacheHits,1);
  await pool.run(o,[{...request,targetTick:request.targetTick+1}],signal,undefined,2);assert.equal(pool.snapshot().cacheHits,1);
  await assert.rejects(async()=>pool.run(o,[request],AbortSignal.abort(Error('paused')),undefined,2),/paused/);
 }finally{pool.close();}
});
