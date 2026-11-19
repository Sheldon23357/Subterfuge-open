import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const generator=resolve('scripts/generate-bot-sdk.mjs'),linker=resolve('scripts/link-build-packages.mjs');
test('SDK checks accept Windows line endings and still reject changed exports',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bot-sdk-lines-'));
 try{
  mkdirSync(join(dir,'packages/bot-sdk'),{recursive:true});
  writeFileSync(join(dir,'packages/bot-sdk/exports.json'),JSON.stringify({index:'packages/ai/src/extension.js'}));
  execFileSync(process.execPath,[generator],{cwd:dir});
  const file=join(dir,'packages/bot-sdk/src/index.ts');
  writeFileSync(file,readFileSync(file,'utf8').replaceAll('\n','\r\n'));
  execFileSync(process.execPath,[generator,'--check'],{cwd:dir});
  writeFileSync(file,readFileSync(file,'utf8').replace('extension.js','wrong.js'));
  assert.throws(()=>execFileSync(process.execPath,[generator,'--check'],{cwd:dir,stdio:'pipe'}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('compiled package links work without Windows symlink privilege and are idempotent',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bot-sdk-links-'));
 try{
  for(let i=0;i<2;i++)execFileSync(process.execPath,[linker],{cwd:dir});
  assert.equal(realpathSync(join(dir,'dist/node_modules/@subterfuge/bot-sdk')),realpathSync(join(dir,'dist/packages/bot-sdk')));
  assert.equal(realpathSync(join(dir,'dist/node_modules/@subterfuge/hybrid')),realpathSync(join(dir,'dist/plugins/hybrid')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
