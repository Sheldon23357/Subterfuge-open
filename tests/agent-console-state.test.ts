import test from 'node:test';
import assert from 'node:assert/strict';
import {consoleDetailTabs,diagnosticViewKey,seatActions,consoleEventLabel,consoleShowsStart,type ConsoleSeat} from '../packages/client/src/agent-console-state.js';
import type {BotLiveSnapshot} from '../packages/contracts/src/index.js';

test('hybrid retains assessment, local decisions and notes in the primary tabs',()=>{
 for(const mode of ['hybrid'] as const)assert.deepEqual(consoleDetailTabs(mode).map(([key])=>key),['live','logs','notes','assessment','stats','config']);
 assert.equal(consoleDetailTabs('hybrid').find(([key])=>key==='assessment')?.[1],'攻防评估');
});
const seat:ConsoleSeat={id:'a',serverUrl:'http://localhost',roomId:'r',lobbySeat:0,mode:'live',status:'paused',enabled:false,busy:false,calls:0,tokens:0,error:null};
const emptyLive:BotLiveSnapshot={generation:'g',round:0,observedTick:null,names:{},directive:null,tasks:[],intents:[],decision:null,operations:[],events:[]};
test('start surface waits for authoritative run history and preserves offline paused runs',()=>{
 assert.equal(consoleShowsStart({...seat,bound:false},null),true);
 assert.equal(consoleShowsStart(seat,null),false,'loading is not evidence of a fresh run');
 assert.equal(consoleShowsStart(seat,emptyLive),true);
 assert.equal(consoleShowsStart(seat,{...emptyLive,round:1}),false,'offline runs may have no model calls');
 assert.equal(consoleShowsStart({...seat,calls:1},emptyLive),false);
 for(const change of [{enabled:true},{busy:true},{starting:true},{stopping:true},{status:'ended'},{status:'error'},{error:'connection failed'}])assert.equal(consoleShowsStart({...seat,...change},emptyLive),false);
 assert.equal(consoleShowsStart(seat,{...emptyLive,operations:[{id:'op',objective:'capture',status:'completed',issues:[]}]}),false);
});
test('console only allows paused connected seats to start or edit',()=>{assert.deepEqual(seatActions(seat,[],true),{start:true,pause:false,settings:true});assert.deepEqual(seatActions(seat,[],false),{start:false,pause:false,settings:false});});
test('long single-run remains pausable while duplicate work and settings are blocked',()=>{assert.deepEqual(seatActions(seat,[{id:'j',seat:'a',action:'run-one',status:'running'}],true),{start:false,pause:true,settings:false});});
test('stopping/ended states cannot start and another seat job does not block this seat',()=>{assert.equal(seatActions({...seat,stopping:true},[],true).pause,false);assert.equal(seatActions({...seat,status:'ended'},[],true).start,false);assert.equal(seatActions(seat,[{id:'j',seat:'b',action:'run-one',status:'running'}],true).start,true);});

test("tool results are labeled returned, not unconditionally successful",()=>{assert.equal(consoleEventLabel("tool-result"),"工具已返回");assert.equal(consoleEventLabel("tool-rejected"),"工具被拒绝");});
test('eight-seat controls stay isolated to the selected job identity',()=>{
 const seats=Array.from({length:8},(_,i)=>({...seat,id:`seat-${i}`}));
 const jobs=[{id:'last',seat:'seat-7',action:'run-one',status:'running' as const}];
 assert.equal(seats.filter(s=>seatActions(s,jobs,true).start).length,7);
 assert.equal(seatActions(seats[7]!,jobs,true).pause,true);
 assert.equal(seatActions(seats[0]!,jobs,true).settings,true);
});

 test('unbound controller profiles may be configured but cannot start',()=>{assert.equal(seatActions({...seat,bound:false},[],true).start,false);assert.equal(seatActions({...seat,bound:false},[],true).settings,true);});

test('diagnostics remount when a fixed slot changes player, room or server without an intervening unbound render',()=>{
 const initial=diagnosticViewKey(seat,'stats');
 assert.equal(diagnosticViewKey({...seat,calls:100,tokens:200,busy:true},'stats'),initial);
 for(const next of [{...seat,lobbySeat:1},{...seat,roomId:'other'},{...seat,diagnosticGeneration:'new-binding'},{...seat,id:'b'}])assert.notEqual(diagnosticViewKey(next,'stats'),initial);
 assert.notEqual(diagnosticViewKey(seat,'logs'),initial);
});
