import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PublishedConsoleStatus} from '../packages/ai/src/application/console-status.js';

test('status requests reuse one serialized publication; timer coalesces changes and stops when idle',t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});
 let builds=0,value=1;
 const view=new PublishedConsoleStatus(()=>{builds++;return {value};});
 try{
  for(let i=0;i<100;i++)assert.equal(view.read(),'{"value":1}');
  assert.equal(builds,1);value=2;t.mock.timers.tick(500);
  assert.equal(view.read(),'{"value":2}');assert.equal(builds,2);
  t.mock.timers.tick(2500);const idle=builds;t.mock.timers.tick(5000);assert.equal(builds,idle);
  view.publish();assert.equal(builds,idle+1);view.close();t.mock.timers.tick(1000);assert.equal(builds,idle+1);
 }finally{view.close();}
});

test('failed status publication never serves an old success as current',()=>{
 let fail=false;
 const view=new PublishedConsoleStatus(()=>{if(fail)throw Error('unavailable');return {ok:true};});
 try{assert.ok(view.read());fail=true;view.publish();assert.equal(view.read(),null);fail=false;view.publish();assert.equal(view.read(),'{"ok":true}');}
 finally{view.close();}
});

test('the first reader after an idle period receives current state and shares that publication',t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});
 let tick=1276,builds=0;const view=new PublishedConsoleStatus(()=>{builds++;return {tick};});
 try{
  assert.equal(view.read(),'{"tick":1276}');t.mock.timers.tick(10000);tick=1277;
  const before=builds;assert.equal(view.read(),'{"tick":1277}');
  for(let i=0;i<100;i++)assert.equal(view.read(),'{"tick":1277}');
  assert.equal(builds,before+1);
 }finally{view.close();}
});
