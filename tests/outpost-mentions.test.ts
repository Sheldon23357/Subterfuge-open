import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChatMapContext,ChatMessageText} from '../packages/client/src/ChatMessageText.js';
import {outpostMentions,aiOutpostMentions} from '../packages/client/src/outpost-mentions.js';

const posts = [{id:'据点 01', name:'NEMO'}, {id:'据点 02', name:'NEMO BAY'}, {id:'据点 03', name:'A+B'}];
test('chat links known names and IDs, preserving punctuation, case and repeated mentions', () => {
  const text = '进攻nemo，守住 NEMO BAY！据点 01\nNEMO / A+B';
  const parts = outpostMentions(text, posts);
  assert.equal(parts.map(p => p.text).join(''), text);
  assert.deepEqual(parts.filter(p => p.outpostId).map(p => [p.text, p.outpostId]), [
    ['nemo','据点 01'], ['NEMO BAY','据点 02'], ['据点 01','据点 01'], ['NEMO','据点 01'], ['A+B','据点 03'],
  ]);
});
test('chat leaves unknown names and substrings alone; ambiguous names do not link', () => {
  const text = 'ANEMONE NEMO2 _NEMO UNKNOWN <script>alert(1)</script>';
  assert.deepEqual(outpostMentions(text, posts), [{text}]);
  assert.deepEqual(outpostMentions('NEMO', [...posts, {id:'据点 04',name:'NEMO'}]), [{text:'NEMO'}]);
  assert.deepEqual(outpostMentions('NEMO', []), [{text:'NEMO'}]);
});

test('AI prose renders known names and numbered locations as canonical name links', () => {
  const parts=aiOutpostMentions('据点 01、nemo；2号据点、3号矿；攻01，守02；01→03。',posts);
  assert.equal(parts.map(p=>p.text).join(''),'NEMO、NEMO；NEMO BAY、A+B矿；攻NEMO，守NEMO BAY；NEMO→A+B。');
  assert.deepEqual(parts.filter(p=>p.outpostId).map(p=>p.outpostId),['据点 01','据点 01','据点 02','据点 03','据点 01','据点 02','据点 01','据点 03']);
});

test('AI references preserve quantities, time, fleet IDs, unknown locations and ambiguous names', () => {
  const text='1兵、02盾、3小时、2矿、3工厂、tick3、24h、12:03、F2-03、hire-0-3，进攻2兵；据点 99、99号，ANEMONE NEMO2';
  assert.equal(aiOutpostMentions(text,posts).map(p=>p.text).join(''),text);
  assert.deepEqual(aiOutpostMentions('NEMO',[...posts,{id:'据点 04',name:'NEMO'}]),[{text:'NEMO'}]);
  assert.equal(aiOutpostMentions(text,[]).map(p=>p.text).join(''),text);
});

test('AI display uses existing map links without modifying text or linking hidden names', () => {
  const text='守据点 01，2号待命，3兵；<script>alert(1)</script>';
  const html=renderToStaticMarkup(React.createElement(ChatMapContext.Provider,{value:{outposts:posts,locate:()=>{}}},React.createElement(ChatMessageText,{text,ai:true})));
  assert.ok(html.includes('href="#outpost-'+encodeURIComponent('据点 01')+'"'));
  assert.ok(html.includes('>NEMO</a>'));
  assert.ok(html.includes('>NEMO BAY</a>'));
  assert.ok(html.includes('3兵'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal((html.match(/<a /g)??[]).length,2);
  assert.equal(text,'守据点 01，2号待命，3兵；<script>alert(1)</script>');
  assert.equal(renderToStaticMarkup(React.createElement(ChatMessageText,{text:'据点 01',ai:true})),'据点 01');
});

test('ordinary diplomacy chat renders explicit IDs as named map hyperlinks and preserves quantities and unknown places',()=>{
 const html=renderToStaticMarkup(React.createElement(ChatMapContext.Provider,{value:{outposts:posts,locate:()=>{}}},React.createElement(ChatMessageText,{text:'据点01、据点 2、NEMO BAY；57兵、20盾、据点99 <script>'})));
 assert.ok(html.includes('>NEMO</a>'));assert.equal((html.match(/>NEMO BAY<\/a>/g)??[]).length,2);
 assert.ok(html.includes('href="#outpost-'+encodeURIComponent('据点 01')+'"'));
 assert.ok(html.includes('57兵、20盾、据点99 &lt;script&gt;'));
 assert.equal((html.match(/<a /g)??[]).length,3);
});
