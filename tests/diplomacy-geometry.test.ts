import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diplomacyEdges,type DiplomacyWorld} from '../packages/engine/src/diplomacy.js';
import {torusDistance} from '../packages/engine/src/geometry.js';

// Prior full-sort algorithm is the compatibility oracle, including edge order.
export function referenceEdges(w:DiplomacyWorld):[string,string][]{
 const edges=new Map<string,[string,string]>();
 for(const p of w.outposts){
  const nearest=w.outposts.filter(q=>q.id!==p.id).map(q=>({q,d:torusDistance(p.position,q.position,w.size)})).sort((a,b)=>a.d-b.d||(a.q.id<b.q.id?-1:1)).slice(0,3);
  for(const {q} of nearest){const edge:[string,string]=p.id<q.id?[p.id,q.id]:[q.id,p.id];edges.set(JSON.stringify(edge),edge);}
 }
 return [...edges.values()];
}
export function geometryFixture(count:number,seed=1):DiplomacyWorld{
 let n=seed;const next=()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/2**32;};
 return {size:{width:1000,height:800},players:[],ended:false,outposts:Array.from({length:count},(_,i)=>({id:`outpost-${i}`,owner:null,destroyed:false,type:'factory',position:{x:next()*1000,y:next()*800}}))};
}
test('optimized topology exactly matches full sorting across maps, ties, wrapping and small rosters',()=>{
 for(let i=0;i<80;i++){const w=geometryFixture(i*2,i+1);assert.deepEqual(diplomacyEdges(w),referenceEdges(w));}
 for(const count of [0,1,2,3,4,30]){
  const w=geometryFixture(count);w.outposts.forEach((p,i)=>{p.position={x:i%3*500,y:Math.floor(i/3)%2*800};});
  assert.deepEqual(diplomacyEdges(w),referenceEdges(w));
 }
});
test('snapshot reuse does not cache ownership and invalidates every geometry input',()=>{
 const w=geometryFixture(30),expected=referenceEdges(w);
 assert.deepEqual(diplomacyEdges(w),expected);
 const copy=structuredClone(w);copy.outposts.forEach((p,i)=>{p.owner=i%2;p.destroyed=i%3===0;});
 assert.deepEqual(diplomacyEdges(copy),expected);
 for(const change of [()=>{copy.outposts[0]!.position.x+=450;},()=>{copy.size.width=500;},()=>{copy.outposts[1]!.id='renamed';},()=>{copy.outposts.reverse();},()=>{copy.outposts.pop();}]){
  change();assert.deepEqual(diplomacyEdges(copy),referenceEdges(copy));
 }
});
test('callers cannot corrupt cached edge lists; bounded eviction preserves results',()=>{
 const w=geometryFixture(40,200),expected=referenceEdges(w),result=diplomacyEdges(w);
 result[0]![0]='corrupt';result.pop();
 assert.deepEqual(diplomacyEdges(w),expected);
 for(let i=0;i<20;i++){const other=geometryFixture(40,i+100);assert.deepEqual(diplomacyEdges(other),referenceEdges(other));}
 assert.deepEqual(diplomacyEdges(w),expected);
});
