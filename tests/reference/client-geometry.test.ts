import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {clientDistance,clientDistanceSquared,unwrapClientPoint,wrapClientPoint,clientSegmentsIntersect,clientRouteCollisionFraction,type Point,type Segment} from '../../packages/engine/src/index.js';
const adapter=await import(new URL('../../../scripts/reference-functions.mjs',import.meta.url).href);
test('client geometry matches extracted distance, wrapping, intersection and RH fraction code',()=>{
  let seed=9123;const random={getInt(min:number,max:number){seed=(Math.imul(seed,1103515245)+12345)>>>0;return ((seed>>>16)&32767)%(max-min+1)+min;}},size={width:20,height:30};
  const point=():Point=>({x:random.getInt(-10000,10000)/1000,y:random.getInt(-15000,15000)/1000});
  const fixtures:any[]=[];
  for(let i=0;i<160;i++)fixtures.push({kind:'distance',a:point(),b:point(),size});
  for(const delta of [0,.00001,.009999,.01,.010001,10,-10])fixtures.push({kind:'distance',a:{x:delta,y:0},b:{x:0,y:0},size});
  for(const x of [-90,-10,10,90])for(const y of [-100,-15,15,100])fixtures.push({kind:'wrap',point:{x,y},size});
  for(let i=0;i<160;i++)fixtures.push({kind:'segments',a:{a:point(),b:point()},b:{a:point(),b:point()}});
  for(const y of [0,.000001,.00001,.0001])fixtures.push({kind:'segments',a:{a:{x:0,y:0},b:{x:2,y:0}},b:{a:{x:2,y},b:{x:0,y}}});
  const expected=adapter.runReferenceGeometry(adapter.readReference(),fixtures);
  for(const [i,f]of fixtures.entries()){
    let actual;
    if(f.kind==='distance')actual={distance:clientDistance(f.a,f.b,f.size),squared:clientDistanceSquared(f.a,f.b,f.size),unwrapped:unwrapClientPoint(f.a,f.b,f.size)};
    else if(f.kind==='wrap')actual=wrapClientPoint(f.point,f.size);
    else actual={intersect:clientSegmentsIntersect(f.a,f.b),fraction:clientRouteCollisionFraction(f.a,f.b)};
    assert.deepEqual(actual,expected[i],`geometry fixture ${i}: ${JSON.stringify(f)}`);
  }
});
