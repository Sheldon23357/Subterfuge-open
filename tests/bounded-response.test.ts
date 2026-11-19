import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readBoundedResponse} from '../packages/ai/src/application/bounded-response.js';
import {readGeminiResponse} from '../packages/ai/src/application/providers/gemini.js';
import {ProviderError} from '../packages/ai/src/controller/contracts/provider-error.js';

test('bounded response preserves Chinese and emoji at every UTF-8 byte boundary',async()=>{
 const text=JSON.stringify({name:'据点🌊',message:'出发🚢'}),bytes=Buffer.from(text);
 for(let width=1;width<=bytes.length;width++){
  let offset=0;
  const body=new ReadableStream<Uint8Array>({pull(controller){if(offset===bytes.length){controller.close();return;}controller.enqueue(bytes.subarray(offset,offset+width));offset=Math.min(offset+width,bytes.length);}});
  assert.equal(await readBoundedResponse(new Response(body),bytes.length),text);
  assert.equal(body.locked,false);
 }
});

test('response limit cancels unread data, releases its lock and preserves caller diagnostics',async()=>{
 let cancelled=false;
 const body=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(Buffer.from('中'));},cancel(){cancelled=true;}});
 const failure=Error('caller limit');let observed=0;
 await assert.rejects(readBoundedResponse(new Response(body),2,(kind,bytes)=>{assert.equal(kind,'limit');observed=bytes;return failure;}),error=>error===failure);
 assert.equal(observed,3);assert.equal(cancelled,true);assert.equal(body.locked,false);
 assert.equal(await readBoundedResponse(new Response(''),0),'');
 await assert.rejects(readBoundedResponse(new Response(null),8),/Missing response/);
});

test('stream errors remain observable and release the reader',async()=>{
 const failure=Error('transport interrupted');
 const body=new ReadableStream<Uint8Array>({pull(controller){controller.error(failure);}});
 await assert.rejects(readBoundedResponse(new Response(body),100),error=>error===failure);
 assert.equal(body.locked,false);
});

test('Gemini retains its missing-body and 2 MiB diagnostic semantics',async()=>{
 await assert.rejects(readGeminiResponse(new Response(null)),error=>error instanceof ProviderError&&error.diagnostic?.reason==='missing-message-content');
 const bytes=2097153;
 await assert.rejects(readGeminiResponse(new Response(new Uint8Array(bytes))),error=>error instanceof ProviderError&&error.diagnostic?.reason==='semantic-output-limit'&&error.diagnostic.outputBytes===bytes);
 assert.equal(await readGeminiResponse(new Response('x'.repeat(bytes-1))).then(text=>text.length),bytes-1);
});
