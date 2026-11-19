import {test} from 'node:test';
import assert from 'node:assert/strict';
import {drawTerritoryNameplates} from '../packages/client/src/territory-nameplates.js';
import {compactNumber} from '../packages/client/src/compact-number.js';

test('territory nameplates stay exactly at the territory center across camera, zoom and ownership changes',()=>{
  const rectangles:number[][]=[];
  const ctx=new Proxy({measureText:()=>({width:32}),roundRect:(...args:number[])=>rectangles.push(args)}, {
    get:(target,key)=>Reflect.get(target,key)??(()=>{}),set:(target,key,value)=>Reflect.set(target,key,value),
  }) as unknown as CanvasRenderingContext2D;
  const centers=[{owner:0,position:{x:0,y:0}}];
  const screen={width:800,height:600,cx:400,cy:300,scale:10};
  const draw=()=>drawTerritoryNameplates(ctx,centers,{width:100,height:100},screen,{seats:[],unavailable:false},0,false);
  draw();
  assert.equal(rectangles[0]![0]!+rectangles[0]![2]!/2,screen.cx);
  assert.equal(rectangles[0]![1]!+rectangles[0]![3]!/2,screen.cy);
  draw();
  assert.deepEqual(rectangles[0],rectangles[1]);
  screen.cx+=30;screen.scale=20;
  draw();
  const last=rectangles.at(-1)!;
  assert.equal(last[0]!+last[2]!/2,screen.cx);
  assert.equal(last[1]!+last[3]!/2,screen.cy);
  centers[0]!.position.x=3;
  draw();
  const moved=rectangles.at(-1)!;
  assert.equal(moved[0]!+moved[2]!/2,screen.cx+3*screen.scale);
});

test('token counts use compact decimal units including rounded boundaries',()=>{
  for(const [input,expected] of [[0,'0'],[999,'999'],[1000,'1K'],[12345,'12.3K'],[999999,'1M'],[1766532,'1.8M'],[2400000000,'2.4B']] as const)
    assert.equal(compactNumber(input),expected);
});
