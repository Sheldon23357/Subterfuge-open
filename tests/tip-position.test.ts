import test from 'node:test';
import assert from 'node:assert/strict';
import {tipPosition} from '../packages/client/src/tip-position.js';
test('tips prefer below and fit desktop viewport edges',()=>{
 assert.deepEqual(tipPosition({left:100,top:50,bottom:72},{width:1440,height:900},120),{left:100,top:80,width:320,maxHeight:876});
 const edge=tipPosition({left:1400,top:850,bottom:872},{width:1440,height:900},120);
 assert.equal(edge.left,1108);assert.equal(edge.top,722);
});
test('long tips remain scrollable within the viewport',()=>{
 const position=tipPosition({left:-20,top:20,bottom:42},{width:1280,height:600},1200);
 assert.equal(position.left,12);assert.equal(position.top,12);assert.equal(position.maxHeight,576);
});
test('detail panels use an available side without covering the trigger and fit narrow screens',()=>{
 const anchor={left:1160,right:1200,top:330,bottom:360};
 const side=tipPosition(anchor,{width:1280,height:720},395,true);
 assert.ok(side.left+side.width<anchor.left);assert.ok(side.top>=12);assert.ok(side.top+395<=708);
 const narrow=tipPosition({left:270,right:310,top:100,bottom:130},{width:390,height:844},395,true);
 assert.ok(narrow.left>=12);assert.ok(narrow.left+narrow.width<=378);assert.ok(narrow.top>=12);
});
