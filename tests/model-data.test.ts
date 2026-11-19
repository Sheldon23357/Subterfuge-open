import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeModelData,decodeModelData,MODEL_DATA_PREFIX} from '../packages/contracts/src/model-data.js';
import {encodePromptSections,readPromptMaterial,readPromptSections} from '../packages/contracts/src/prompt-sections.js';
import {promptMaterialSections} from '../plugins/hybrid/src/prompt-material.js';
import {promptContextModules} from '../packages/client/src/prompt-context.js';

test('model data preserves exact numeric, empty, unknown, translated and future fields',()=>{
 const value=JSON.parse('{"global":{"time":{"worldDay":1.125},"zero":0,"negative":-1e-7,"false":false,"true":true,"unknown":null,"empty":"","array":[],"object":{},"名称":"untranslated user key","__proto__":{"safe":true},"players":{"columns":["player","名称","unknownFuture","active"],"rows":[[0,"北辰",null,false]]}},"facts":{"tricky":["?","是","否","null","true","false","001","-0","1e2","NaN","[]","a:b","a,b"," spaced ","quote\\\"slash\\\\","line\\n换行🛰️","[/brief.global]"]}}');
 assert.deepEqual(decodeModelData(encodeModelData(value)),value);
 const decoded=decodeModelData(encodeModelData(value)) as any;
 assert.ok(Object.hasOwn(decoded.global,'__proto__'));assert.equal(({} as any).safe,undefined);
 assert.ok(encodeModelData(value).includes('世界日:1.125'));
});

test('damaged compact data fails as a whole, including duplicate translated keys and deep nesting',()=>{
 const encoded=encodeModelData({global:{self:{drillers:0},x:'a,b'}});
 for(let n=0;n<encoded.length;n++)assert.throws(()=>decodeModelData(encoded.slice(0,n)));
 for(const raw of ['{兵力:1,兵力:2}','{兵力:1,"drillers":2}','{x:01}','{x:1e999}','[是,]','{x:?}junk','['.repeat(100)+'?'+']'.repeat(100)])assert.throws(()=>decodeModelData(MODEL_DATA_PREFIX+raw));
});

test('compact section decoding and console use exactly the saved spans and preserve evidence JSON',()=>{
 const input={global:{players:{columns:['player','active','neptunium'],rows:[[0,false,0]]}},facts:{unknown:null,empty:[],s:'[/brief.facts]'},guidance:{commander:{text:'原文\n[/brief.guidance]\n🛰️'}},evidence:{messages:[{text:'[brief.global 全局局势]\n原始聊天'}]}};
 const prompt=encodePromptSections(promptMaterialSections(input,true));
 assert.deepEqual(readPromptMaterial(prompt),input);
 assert.deepEqual(promptContextModules(prompt).map(m=>m.source).join(''),prompt);
 assert.equal(promptContextModules(prompt).reduce((n,m)=>n+m.characters,0),prompt.length);
 assert.equal(readPromptSections(prompt)!.find(s=>s.id==='brief.global')!.format,'compact');
 assert.equal(readPromptSections(prompt)!.find(s=>s.id==='brief.evidence')!.format,'json');
 assert.deepEqual(promptContextModules(prompt).find(m=>m.key==='brief.global')!.value,input.global);
});

test('codec round-trips mixed generated values without inferring string types',()=>{
 let seed=731;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const make=(depth:number):unknown=>{const k=Math.floor(random()*(depth?7:5));if(k===0)return null;if(k===1)return random()<0.5;if(k===2)return (random()-0.5)*1e6;if(k===3)return ['?','是','123','a:b','x,y','\n🛰️','来源','', 'raw'][Math.floor(random()*9)];if(k===4)return [];if(k===5)return Array.from({length:3},()=>make(depth-1));return {drillers:make(depth-1),名称:make(depth-1),future:make(depth-1)};};
 for(let i=0;i<250;i++){const v=make(3);assert.deepEqual(decodeModelData(encodeModelData(v)),v);}
});

test('small wide tables use named records so own and peer facts remain adjacent to their labels',()=>{
 const table={columns:['id','peer','ownCaptureGoal','peerCaptureGoal','ownProgress','peerProgress','ownCapturesRemaining','peerCapturesRemaining','ownFulfilled','peerFulfilled'],rows:[['A1',4,1,1,0,22,1,0,false,true],['A2',1,30,5,0,8,30,0,false,true]]};
 const text=encodeModelData({guidance:{serverAgreements:{current:{jointAttack:table}}}});
 assert.ok(text.includes('表['));assert.ok(text.includes('本方待占领据点:1,对方待占领据点:0,本方达标:否,对方达标:是'));
 assert.deepEqual(decodeModelData(text),{guidance:{serverAgreements:{current:{jointAttack:table}}}});
 assert.throws(()=>decodeModelData(MODEL_DATA_PREFIX+'表[{编号:a},{对方:2}]'));
});
