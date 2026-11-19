import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

function outcome(mode:'cancelled'|'round-deadline'|'provider-call'){
 const directory=mkdtempSync(join(tmpdir(),'merge-codex-deadline-'));
 try{
  const preload=join(directory,'preload.cjs');writeFileSync(preload,'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000);');
  const moduleUrl=new URL('../packages/ai/src/application/providers/codex.js',import.meta.url).href;
  const script=`import {CodexProvider} from ${JSON.stringify(moduleUrl)};process.env.NODE_OPTIONS=${JSON.stringify('--require='+JSON.stringify(preload))};const controller=new AbortController();${mode==='provider-call'?'':`setTimeout(()=>controller.abort(new DOMException('test',${JSON.stringify(mode==='round-deadline'?'TimeoutError':'AbortError')})),300);`}try{await new CodexProvider(process.execPath,${mode==='provider-call'?300:2000}).step({model:'',prompt:'test',signal:controller.signal});process.exitCode=2;}catch(e){process.stdout.write(JSON.stringify({code:e.code,source:e.timeoutSource,outcome:e.outcome,diagnostic:e.diagnostic}));}`;
  return JSON.parse(execFileSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8',timeout:10000,windowsHide:true}));
 }finally{rmSync(directory,{recursive:true,force:true});}
}

test('merged Codex timeout typing preserves host deadline versus provider timer and unknown dispatch outcome',()=>{
 for(const mode of ['cancelled','round-deadline','provider-call'] as const){
  const result=outcome(mode);
  assert.equal(result.code,mode==='cancelled'?'cancelled':'timeout');
  assert.equal(result.source,mode==='cancelled'?undefined:mode);
  assert.equal(result.outcome,'unknown');
  assert.equal(result.diagnostic.process.stopReason,mode==='provider-call'?'provider-timeout':mode);
  assert.equal(result.diagnostic.reason,mode==='provider-call'?'Codex timed out':'AI stopped');
  if(mode==='provider-call')assert.ok(result.diagnostic.process.timeoutLagMs>=0);
  else assert.equal(result.diagnostic.process.timeoutLagMs,undefined);
 }
});
