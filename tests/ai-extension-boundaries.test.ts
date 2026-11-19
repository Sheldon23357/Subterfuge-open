import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('source extensions cannot import private state, server or runtime assembly from strategy modules',()=>{
 const root=mkdtempSync(join(tmpdir(),'ai-extension-boundaries-'));
 try{
  mkdirSync(join(root,'packages'),{recursive:true});mkdirSync(join(root,'examples/ai-extension'),{recursive:true});
  writeFileSync(join(root,'examples/ai-extension/strategies.ts'),[
   "import {AiStore} from '../../packages/ai/src/controller/storage/store.js';",
   "import type {World} from '../../packages/server/src/index.js';",
   "export * from '../../packages/ai/src/runtime.js';",
  ].join('\n'));
  const checked=spawnSync(process.execPath,[resolve('scripts/check-boundaries.mjs')],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(checked.status,1);assert.equal(checked.stderr.split('extensions must use public source entries').length-1,3);
 }finally{rmSync(root,{recursive:true,force:true});}
});
