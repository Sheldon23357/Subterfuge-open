import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {clientDistance,clientDistanceSquared,unwrapClientPoint,wrapClientPoint,clientSegmentsIntersect,clientRouteCollisionFraction,type Point,type Segment} from '../packages/engine/src/index.js';

test('float32 distance cutoff is deliberately different from squared sonar geometry',()=>{
  const size={width:20,height:20},a={x:0,y:0},b={x:.005,y:0};
  assert.equal(clientDistance(a,b,size),0);
  assert.equal(clientDistanceSquared(a,b,size),.000025);
  assert.deepEqual(unwrapClientPoint({x:-10,y:0},a,size),{x:-10,y:0});
  assert.deepEqual(unwrapClientPoint({x:10,y:0},a,size),{x:10,y:0});
});
test('collinear movement can collide but equal velocity does not produce a collision fraction',()=>{
  const forward:Segment={a:{x:0,y:0},b:{x:2,y:0}};
  assert.equal(clientRouteCollisionFraction(forward,{a:{x:2,y:0},b:{x:0,y:0}}),.5);
  assert.equal(clientRouteCollisionFraction(forward,{a:{x:1,y:0},b:{x:3,y:0}}),null);
  assert.equal(clientSegmentsIntersect(forward,{a:{x:1,y:1},b:{x:3,y:1}}),false);
});
