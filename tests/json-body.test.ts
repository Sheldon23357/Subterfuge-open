import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readJsonBody} from '../packages/server/src/json-body.js';
async function* chunks(bytes: Buffer, width: number) { for(let i=0;i<bytes.length;i+=width) yield bytes.subarray(i,i+width); }
test('JSON request decoding preserves Chinese IDs and emoji across every byte boundary', async()=>{
 const value={id:'据点 01',english:'Fleet A',message:'你好🌊',snapshot:JSON.stringify({id:'据点 02',memo:'🚢'})};
 const bytes=Buffer.from(JSON.stringify(value));
 for(let width=1;width<bytes.length;width++)assert.deepEqual(await readJsonBody(chunks(bytes,width)),value);
 let legacy='';for await(const part of chunks(bytes,1))legacy+=String(part);
 assert.notDeepEqual(JSON.parse(legacy),value); // deterministic before-failure proof
});
test('JSON requests retain invalid syntax rejection and bounded bytes',async()=>{
 await assert.rejects(readJsonBody(chunks(Buffer.from('{bad'),1)),SyntaxError);
 await assert.rejects(readJsonBody(chunks(Buffer.from('{}'),1),1),/文件过大/);
 assert.deepEqual(await readJsonBody(chunks(Buffer.from('{}'),1),2),{});
 await assert.rejects(readJsonBody(chunks(Buffer.from('"中"'),1),4),/文件过大/);
});
