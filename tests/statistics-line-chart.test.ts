import test from 'node:test';
import assert from 'node:assert/strict';
import {statisticsLinePath,niceChartMaximum} from '../packages/client/src/StatisticsLineChart.js';

test('monotone chart curves preserve samples, bounded control points and gaps rather than inventing missing observations',()=>{
 const path=statisticsLinePath([{x:0,y:10},{x:10,y:0},{x:20,y:100},null,{x:40,y:20},{x:50,y:10}]);
 assert.equal((path.match(/M/g)??[]).length,2);
 assert.match(path,/M0,10/);assert.match(path,/10,0/);assert.match(path,/20,100/);assert.match(path,/M40,20/);assert.match(path,/50,10/);
 const curves=[...path.matchAll(/C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)/g)];
 assert.equal(curves.length,3);
 const ranges=[[0,10],[0,100],[10,20]];
 curves.forEach((curve,i)=>{for(const y of [Number(curve[2]),Number(curve[4])])assert.ok(y>=ranges[i]![0]!&&y<=ranges[i]![1]!);});
 assert.equal(statisticsLinePath([null,null]),'');assert.equal(statisticsLinePath([{x:5,y:0}]),'M5,0');assert.doesNotMatch(path,/NaN|Infinity/);
});
test('chart scale bounds remain finite for zero series and cover the measured maximum',()=>{
 assert.equal(niceChartMaximum(0),1);
 for(const value of [.01,1,10,26.8,1024,30123])assert.ok(niceChartMaximum(value)>=value);
});
