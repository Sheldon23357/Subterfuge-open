import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveSeatCache} from '../packages/client/src/live-seat-cache.js';
import {diagnosticViewKey,type ConsoleSeat} from '../packages/client/src/agent-console-state.js';

test('switching seats immediately restores each cached view and retains late updates for their own seat',()=>{
 const cache=new LiveSeatCache<{summary:string;round:number}>();
 const a={summary:'北辰守备',round:4},b={summary:'天火扩张',round:8};
 assert.equal(cache.read('a','room/a'),undefined);cache.write('a','room/a',a);
 assert.equal(cache.read('b','room/b'),undefined);cache.write('b','room/b',b);
 assert.equal(cache.read('a','room/a'),a);
 cache.write('b','room/b',{...b,round:9});
 assert.equal(cache.read('a','room/a'),a);assert.equal(cache.read('b','room/b')?.round,9);
});

test('rebinding a slot discards old content and rejects late responses from its previous identity',()=>{
 const cache=new LiveSeatCache<string>();
 cache.read('a','old');cache.write('a','old','old directives');
 assert.equal(cache.read('a','new'),undefined);
 assert.equal(cache.write('a','old','late old response'),false);
 cache.write('a','new','new directives');assert.equal(cache.peek('a','old'),undefined);
 assert.equal(cache.read('a','new'),'new directives');
});

test('room, player and diagnostic generation changes each invalidate the cached seat',()=>{
 const seat:ConsoleSeat={id:'a',roomId:'room',lobbySeat:0,diagnosticGeneration:'g1',mode:'live',status:'waiting',enabled:true,busy:false,calls:0,tokens:0,error:null};
 for(const change of [{roomId:'next'},{lobbySeat:1},{diagnosticGeneration:'g2'}]){
  const cache=new LiveSeatCache<string>(),old=diagnosticViewKey(seat,'live'),next=diagnosticViewKey({...seat,...change},'live');
  cache.read(seat.id,old);cache.write(seat.id,old,'cached');assert.equal(cache.read(seat.id,next),undefined);
  assert.equal(cache.write(seat.id,old,'late'),false);
 }
});
