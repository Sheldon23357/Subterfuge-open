import {test} from 'node:test';
import assert from 'node:assert/strict';
import {territoryCenters} from '../packages/client/src/territory-labels.js';
const point=(id:string,owner:number|null,x:number,y:number)=>({id,owner,position:{x,y}});

test('territory centers weight every controlled base equally and update after capture',()=>{
 const points=[point('a',0,0,0),point('b',0,0,3),point('c',0,9,9)];
 assert.deepEqual(territoryCenters(points,{width:100,height:100})[0]!.position,{x:3,y:4});
 points[2]!.owner=1;
 assert.deepEqual(territoryCenters(points,{width:100,height:100})[0]!.position,{x:0,y:1.5});
});

test('wrapped territory averages keep repeated coordinates as separate bases',()=>{
 const points=[point('a',0,-9,-9),point('b',0,-9,-9),point('c',0,8,8)];
 assert.deepEqual(territoryCenters(points,{width:20,height:20})[0]!.position,{x:-10,y:-10});
});
test('territory labels stay centered across both world seams and ignore neutral or destroyed bases',()=>{
 const result=territoryCenters([point('a',0,-9,-9),point('b',0,9,9),point('c',1,2,3),point('neutral',null,0,0),{...point('dead',0,0,0),destroyed:true}],{width:20,height:20});
 assert.equal(result.length,2);assert.deepEqual(result[0],{owner:0,position:{x:-10,y:-10}});assert.deepEqual(result[1],{owner:1,position:{x:2,y:3}});
});
test('territory centers use public unseen ownership, stable ordering and one point per base',()=>{
 const points=[point('a',0,-2,0),point('b',0,4,6),point('a',0,-2,0),point('c',1,8,3)];
 assert.deepEqual(territoryCenters(points,{width:20,height:20}),territoryCenters([...points].reverse(),{width:20,height:20}));
 assert.deepEqual(territoryCenters(points,{width:20,height:20})[0]!.position,{x:1,y:3});
 assert.deepEqual(territoryCenters(points,{width:0,height:20}),[]);
});
