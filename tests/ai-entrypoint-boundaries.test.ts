import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {initialState,resumeSeatState} from '../packages/ai/src/index.js';

for(const nextReview of [null,0,123])test(`shared explicit resume changes only lifecycle fields, nextReview=${nextReview}`,()=>{
 const state=initialState('resume',2,{model:'',personality:'sentinel'});
 state.enabled=false;state.status='error';state.error='recover explicitly';state.nextReview=8;
 state.calls=12;state.sequence=7;state.memory.strategy='retain plan';
 const before=structuredClone(state),identity=state;
 resumeSeatState(state,nextReview);
 assert.equal(state,identity);
 assert.deepEqual(state,{...before,enabled:true,status:'waiting',error:null,nextReview});
});

const forbiddenImports=[
 ['reply-protocol',"export * from './codex.js';",'provider-neutral'],
 ['tool-arguments',"import {x} from './openai-compatible.js';",'provider-neutral'],
 ['campaign-projection',"import {AiStore} from './store.js';",'execution/storage'],
 ['local-commit-plan',"const gateway=await import('./gateway.js');",'execution/storage'],
 ['campaign-ledger',"const fs=require('node:fs');",'platform capabilities'],
 ['seat-lifecycle',"export * from './index.js';",'execution/storage'],
] as const;
test('build AST boundaries report every forbidden import in one scan',()=>{
 const root=mkdtempSync(join(tmpdir(),'ai-boundary-'));
 try{
  mkdirSync(join(root,'packages/ai/src'),{recursive:true});
  for(const [name,code] of forbiddenImports)writeFileSync(join(root,`packages/ai/src/${name}.ts`),code);
  const result=spawnSync(process.execPath,[resolve('scripts/check-boundaries.mjs')],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,1,result.stderr);
  for(const [name,_code,expected] of forbiddenImports){
   const diagnostics=result.stderr.split('\n').filter(line=>line.includes(`${name}.ts:`));
   assert.ok(diagnostics.some(line=>line.includes(expected)),`missing ${name}: ${expected}\n${result.stderr}`);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('build AST boundary permits type-only result dependency',()=>{
 const root=mkdtempSync(join(tmpdir(),'ai-boundary-'));
 try{
  mkdirSync(join(root,'packages/ai/src/controller/execution'),{recursive:true});
  writeFileSync(join(root,'packages/ai/src/controller/execution/local-commit-plan.ts'),"import type {ToolExecution} from './tool-results.js';\nimport {shortFleetReferences} from './fleet-labels.js';");
  const result=spawnSync(process.execPath,[resolve('scripts/check-boundaries.mjs')],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Module boundaries verified/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
