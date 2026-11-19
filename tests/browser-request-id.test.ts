import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {browserRequestId} from '../packages/client/src/browser-request-id.js';

test('HTTP request IDs use secure randomness and valid UUID version/variant bits',()=>{
 const random={getRandomValues:crypto.getRandomValues.bind(crypto)};
 const ids=Array.from({length:1000},()=>browserRequestId(random));
 assert.equal(new Set(ids).size,1000);
 for(const id of ids) assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('player sea preview chat renders on HTTP where crypto.randomUUID is unavailable', async()=>{
 const compiled=await build({stdin:{contents:`
 import React from 'react';
 import {renderToString} from 'react-dom/server';
 import {PlayerChat} from './packages/client/src/PlayerChat.tsx';
 const cryptoWithoutUUID={getRandomValues:globalThis.crypto.getRandomValues.bind(globalThis.crypto)};
 Object.defineProperty(globalThis,'crypto',{value:cryptoWithoutUUID,configurable:true});
 const html=renderToString(React.createElement(PlayerChat,{connection:{},roomId:'preview-test',player:0,count:2}));
 if(!html) throw Error('Chat did not render');
 `,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',loader:{'.css':'empty'},write:false,logLevel:'silent'});
 const rendered=spawnSync(process.execPath,[],{input:compiled.outputFiles[0]!.text,encoding:'utf8'});
 assert.equal(rendered.status,0,rendered.stderr);
});
