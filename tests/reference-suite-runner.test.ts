import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const runner=resolve('scripts/run-reference-tests.mjs');
test('optional reference runner rejects missing and mismatched samples, never reporting a passed comparison',()=>{
 const dir=mkdtempSync(join(tmpdir(),'reference-prerequisite-'));
 try {
  let result=spawnSync(process.execPath,[runner],{cwd:dir,encoding:'utf8'});
  assert.equal(result.status,2);assert.match(result.stderr,/NOT RUN: missing prerequisite/);assert.equal(result.stdout,'');
  mkdirSync(join(dir,'research/analysis/javascript'),{recursive:true});mkdirSync(join(dir,'docs/rules/data'),{recursive:true});
  writeFileSync(join(dir,'research/analysis/javascript/index-DgdyVR_2.js'),'not the locked bundle');
  writeFileSync(join(dir,'docs/rules/data/build-manifest.json'),JSON.stringify({formatted_js_sha256:'locked-hash-not-matching'}));
  result=spawnSync(process.execPath,[runner],{cwd:dir,encoding:'utf8'});
  assert.equal(result.status,2);assert.match(result.stderr,/NOT RUN: locked sample validation failed/);assert.match(result.stderr,/hash changed/);assert.equal(result.stdout,'');
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('default runner ignores stale compiled reference files for relative and absolute directory arguments',()=>{
 const dir=mkdtempSync(join(tmpdir(),'default-regression-selection-'));
 try {
  mkdirSync(join(dir,'tests'));mkdirSync(join(dir,'dist/tests'),{recursive:true});
  writeFileSync(join(dir,'package.json'),'{}');
  writeFileSync(join(dir,'tests/kept.test.ts'),'// source fixture');
  writeFileSync(join(dir,'dist/tests/kept.test.js'),"require('node:test')('kept',()=>{require('node:fs').writeFileSync('kept-executed','yes');});");
  writeFileSync(join(dir,'dist/tests/removed-reference.test.js'),"throw Error('stale reference test executed');");
  // A fresh runner must not inherit Node's enclosing test-worker context.
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  for(const target of ['dist/tests','./dist/tests',join(dir,'dist/tests')]){
   const result=spawnSync(process.execPath,[resolve('scripts/run-tests.mjs'),target],{cwd:dir,encoding:'utf8',env});
   assert.equal(result.status,0,result.stdout+result.stderr);assert.ok(existsSync(join(dir,'kept-executed')),'kept test must actually run');rmSync(join(dir,'kept-executed'));assert.doesNotMatch(result.stdout+result.stderr,/stale reference/);
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('focused runner executes all requested files once and propagates later failures',()=>{
 const dir=mkdtempSync(join(tmpdir(),'focused-regression-selection-'));
 try {
  writeFileSync(join(dir,'package.json'),'{}');
  writeFileSync(join(dir,'first.test.js'),"require('node:test')('first',()=>{require('node:fs').appendFileSync('executed','first\\n');});");
  writeFileSync(join(dir,'second.test.js'),"require('node:test')('second',()=>{require('node:fs').appendFileSync('executed','second\\n');throw Error('second target failed');});");
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,[resolve('scripts/run-tests.mjs'),'first.test.js','./first.test.js','second.test.js'],{cwd:dir,encoding:'utf8',env});
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.match(result.stdout+result.stderr,/second target failed/);
  assert.deepEqual(readFileSync(join(dir,'executed'),'utf8').trim().split('\n').sort(),['first','second']);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('runner partitions quick and package suites without losing full-suite coverage',()=>{
 const dir=mkdtempSync(join(tmpdir(),'regression-suites-'));
 try {
  const names=['rules.test.js','player-sdk-package.test.js','player-devkit-package.test.js'];
  for(const name of names)writeFileSync(join(dir,name),'');
  const invoke=(suite:string)=>{
   const result=spawnSync(process.execPath,[resolve('scripts/run-tests.mjs'),`--suite=${suite}`,'--list',dir],{encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);return result.stdout.trim().split(/\r?\n/).sort();
  };
  const quick=invoke('quick'),pack=invoke('package'),full=invoke('full');
  assert.deepEqual(quick,[join(dir,'rules.test.js')]);assert.equal(pack.length,2);
  assert.deepEqual([...quick,...pack].sort(),full);assert.equal(full.length,3);
  for(const option of ['--suite=unknown','--concurrency=0','--concurrency=NaN','--concurrency=1.5','--concurrency=33','--typo']){
   const result=spawnSync(process.execPath,[resolve('scripts/run-tests.mjs'),option,'--list',dir],{encoding:'utf8'});
   assert.notEqual(result.status,0,option);
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('runner actually overlaps isolated test files with concurrency two',()=>{
 const dir=mkdtempSync(join(tmpdir(),'parallel-regression-'));
 try {
  writeFileSync(join(dir,'package.json'),'{}');
  for(const [self,other] of [['first','second'],['second','first']])writeFileSync(join(dir,`${self}.test.js`),`
   const fs=require('node:fs');
   require('node:test')('${self}',async()=>{
    fs.writeFileSync('${self}.ready','yes');
    const deadline=Date.now()+10000;
    while(!fs.existsSync('${other}.ready')){
     if(Date.now()>deadline)throw Error('test files did not overlap');
     await new Promise(r=>setTimeout(r,10));
    }
   });
  `);
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,[resolve('scripts/run-tests.mjs'),'--concurrency=2',dir],{cwd:dir,encoding:'utf8',env,timeout:20000});
  assert.equal(result.status,0,result.stdout+result.stderr+String(result.error??''));
  assert.ok(existsSync(join(dir,'first.ready'))&&existsSync(join(dir,'second.ready')));
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('timing-sensitive phase runs after parallel failures and cannot hide their exit status',()=>{
 const dir=mkdtempSync(join(tmpdir(),'regression-phases-'));
 try {
  writeFileSync(join(dir,'package.json'),'{}');
  writeFileSync(join(dir,'ordinary.test.js'),"require('node:test')('ordinary',()=>{require('node:fs').writeFileSync('parallel-done','yes');throw Error('parallel failure');});");
  writeFileSync(join(dir,'lab-ai-convergence.test.js'),"require('node:test')('timing',()=>{require('node:assert/strict').ok(require('node:fs').existsSync('parallel-done'));require('node:fs').writeFileSync('serial-done','yes');});");
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,[resolve('scripts/run-tests.mjs'),'--concurrency=2',dir],{cwd:dir,encoding:'utf8',env});
  assert.equal(result.status,1,result.stdout+result.stderr);assert.ok(existsSync(join(dir,'serial-done')));
  assert.match(result.stdout,/phase=timing-sensitive, files=1, concurrency=1/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
