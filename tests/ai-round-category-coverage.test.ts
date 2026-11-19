
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeTask} from '../packages/ai/src/controller/runtime/decision.js';

test('mixed military and global strategic events preserve all causes while pure chat keeps its wake category',()=>{
 const t=makeTask([{key:'threat:enemy',category:'military',reason:'受袭',entities:['蓝方工厂'],urgent:true},{key:'eliminated:1',category:'strategy',reason:'淘汰',entities:['红方矿场'],urgent:false}],['收到新消息'],[],true);
 assert.equal(t.category,'military');assert.equal(t.scope,'global');assert.equal(t.weight,'heavy');
 assert.equal(makeTask([],['收到新消息'],[],true).category,'diplomacy');
});
