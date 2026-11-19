import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {initialState} from '../packages/ai/src/controller/contracts/types.js';
import {AgentDiagnostics} from '../packages/ai/src/controller/diagnostics/agent-diagnostics.js';
import {DiagnosticNoteList,AgentDiagnostics as DiagnosticsPage} from '../packages/client/src/AgentDiagnostics.js';

test('notebook archive classification preserves rows, history, paging and reopened plans',()=>{
 const store=new AiStore(':memory:'),state=initialState('room',0,{model:'fake',personality:'schemer'}),diagnostics=new AgentDiagnostics(store,state,v=>v);
 const note=(id:string,status:string,expiresAt:number|null=null)=>store.save(state,'notebook-set',{id,kind:'plan',text:id,updatedAt:0,expiresAt,record:{type:'plan',status}});
 try{
  store.save(state,'wake-state',{observed:{view:{tick:20},secondsSinceLastTick:0}});
  note('active','active');note('old-plan','completed');note('expired','active',11000);note('future','active',13000);
  const current=diagnostics.read('notebook',{scope:'current'}) as any;
  assert.equal(current.entries.length,4);assert.deepEqual(new Set(current.entries.filter((e:any)=>e.archived).map((e:any)=>e.payload.id)),new Set(['old-plan','expired']));
  assert.equal(current.entries.find((e:any)=>e.payload.id==='expired').archiveReason,'expired');
  const page=diagnostics.read('notebook',{scope:'current',limit:'1'}) as any;assert.equal(page.entries.length,1);assert.ok(page.nextCursor);
  const older=diagnostics.read('notebook',{scope:'current',limit:'1',before:String(page.nextCursor)}) as any;assert.equal(older.entries[0].payload.id,'expired');assert.equal(older.entries[0].archived,true);
  const history=diagnostics.read('notebook',{scope:'history'}) as any;assert.equal(history.entries.length,4);assert.ok(history.entries.every((e:any)=>e.archived===undefined));
  note('old-plan','active');assert.equal((diagnostics.read('notebook',{}) as any).entries.find((e:any)=>e.payload.id==='old-plan').archived,false);
  assert.equal((diagnostics.read('notebook',{scope:'history'}) as any).entries.length,5,'archive display does not delete or rewrite any journal entry');
 }finally{store.close();}
});
test('archive is collapsed by default and only groups the current notebook',()=>{
 const entries=[{id:1,kind:'notebook-set',payload:{},archived:false},{id:2,kind:'notebook-set',payload:{},archived:true}];
 const renderEntry=(entry:{id:number|string})=>React.createElement('article',{key:entry.id,'data-id':entry.id},'记录 '+entry.id);
 const html=renderToStaticMarkup(React.createElement(DiagnosticNoteList,{entries,source:'notebook',current:true,busy:false,renderEntry}));
 assert.ok(html.includes('<details class="note-archive">'));assert.ok(!html.includes('<details class="note-archive" open'));
 assert.ok(html.indexOf('data-id="1"')<html.indexOf('note-archive'));assert.ok(html.indexOf('data-id="2"')>html.indexOf('note-archive'));
 assert.ok(html.includes('1 条'));
 for(const props of [{source:'notebook' as const,current:false}]){
  const plain=renderToStaticMarkup(React.createElement(DiagnosticNoteList,{entries,...props,busy:false,renderEntry}));assert.ok(!plain.includes('note-archive'));assert.ok(plain.includes('data-id="2"'));
 }
});


test('closed reminders are archived with their original contents and reactivate on reset',()=>{
 const store=new AiStore(':memory:'),state=initialState('room',0,{model:'fake',personality:'schemer'}),diagnostics=new AgentDiagnostics(store,state,v=>v);
 try{
  store.save(state,'reminder-set',{id:'done',atSeconds:600,note:'keep contents'});store.save(state,'reminder-cancelled',{id:'done'});
  store.save(state,'reminder-set',{id:'due',atSeconds:0,note:'still outstanding'});
  const page=diagnostics.read('reminders',{}) as any;
  assert.equal(page.entries.find((e:any)=>e.payload.id==='done').archived,true);assert.equal(page.entries.find((e:any)=>e.payload.id==='done').payload.note,'keep contents');
  assert.equal(page.entries.find((e:any)=>e.payload.id==='due').archived,false,'overdue reminders remain active');
  assert.deepEqual(store.reminders('room',0).map(r=>r.id),['due'],'archive query does not restore cancelled reminders to AI context');
  store.save(state,'reminder-set',{id:'done',atSeconds:1200,note:'new content'});
  const reopened=(diagnostics.read('reminders',{}) as any).entries.filter((e:any)=>e.payload.id==='done');assert.equal(reopened.length,1);assert.equal(reopened[0].archived,false);
 }finally{store.close();}
});

test('campaigns split active and closed plans without the repeated overview times',()=>{
 const entries=[{id:3,kind:'campaign-state',payload:{plans:[{id:'active',stage:'review',createdTick:0,reviewAtTick:42},{id:'done',stage:'completed',createdTick:0,reviewAtTick:58},{id:'cancelled',stage:'cancelled'}]}}];
 const html=renderToStaticMarkup(React.createElement(DiagnosticNoteList,{entries,source:'campaigns',current:true,busy:false,renderEntry:e=>React.createElement('article',{key:e.id},JSON.stringify(e.payload))}));
 assert.ok(html.indexOf('active')<html.indexOf('note-archive'));assert.ok(html.indexOf('done')>html.indexOf('note-archive'));assert.ok(html.indexOf('cancelled')>html.indexOf('note-archive'));assert.match(html,/2 条/);
 const page=renderToStaticMarkup(React.createElement(DiagnosticsPage,{id:'ai-01',tab:'notes',request:async<T>()=>({} as T)}));assert.ok(!page.includes('笔记范围'));assert.ok(!page.includes('>历史<'));
});
