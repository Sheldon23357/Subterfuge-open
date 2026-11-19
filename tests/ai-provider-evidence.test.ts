import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {ProviderEvidence} from '../packages/ai/src/controller/contracts/provider-evidence.js';
import {providerCallTimeout} from '../packages/ai/src/application/providers/codex.js';

test('high reasoning receives five minutes while ordinary calls keep two minutes',()=>{
  assert.equal(providerCallTimeout('high'),300000);
  for(const effort of [undefined,'low','medium'] as const)assert.equal(providerCallTimeout(effort),120000);
});

const canary='unlabelled-private-evidence-canary';
test('provider evidence extracts bounded facts across chunks without retaining arbitrary output',()=>{
  const evidence=new ProviderEvidence(1000);
  const requestId='req_diagnostic123456789';
  evidence.chunk('stdout','{"type":"thread.started","thread_id":"'+canary+'"}\n',1010);
  const error=JSON.stringify({type:'turn.failed',error:{message:`read ECONNRESET password=${canary} https://example.test/${canary}`,status_code:503,request_id:requestId}})+'\n';
  evidence.chunk('stdout',error.slice(0,30),1020);evidence.chunk('stdout',error.slice(30),1030);
  evidence.chunk('stdout',JSON.stringify({type:'item.completed',item:{type:'agent_message',text:canary}})+'\n',1040);
  evidence.chunk('stderr',`HTTP 429 Bearer ${canary}\n`,1050);
  evidence.chunk('stdout','malformed '+canary+'\n',1060);
  const summary=evidence.summary(2000),json=JSON.stringify(summary);
  assert.equal(summary.firstOutputMs,10);assert.equal(summary.lastOutputMs,60);assert.equal(summary.silenceMs,940);
  assert.deepEqual(summary.events,{'thread.started':1,'turn.failed':1,'item.completed':1});
  assert.equal(summary.lastEvent!.type,'item.completed');assert.equal(summary.malformedLines,1);
  assert.deepEqual(summary.networkCodes,['ECONNRESET']);assert.deepEqual(summary.httpStatuses,[503,429]);assert.deepEqual(summary.requestIds,[requestId]);
  assert.match(summary.callId,/^[a-f0-9-]{36}$/);assert.equal(summary.errorFingerprints.length,1);assert.match(summary.stderrSha256,/^[a-f0-9]{64}$/);
  assert.ok(!json.includes(canary));assert.ok(!json.includes('example.test'));
  assert.deepEqual(evidence.summary(2000),summary);
});

test('oversized lines and request ID cardinality are bounded; unterminated errors are captured',()=>{
  const evidence=new ProviderEvidence(0);
  evidence.chunk('stdout','x'.repeat(70000),1);evidence.chunk('stdout','tail\n',2);
  for(let i=0;i<100;i++)evidence.chunk('stderr',`request_id=req_diagnostic_${i.toString().padStart(8,'0')}\n`,3);
  evidence.chunk('stdout',JSON.stringify({type:'error',message:'stream disconnected',request_id:'secret-account-identifier'}),4);
  const s=evidence.summary(100);
  assert.equal(s.oversizedLines,1);assert.equal(s.malformedLines,0);assert.equal(s.requestIds.length,8);assert.equal(s.events.error,1);
  assert.ok(s.reasons.includes('stream-interrupted'));assert.ok(!JSON.stringify(s).includes('secret-account-identifier'));
  assert.ok(JSON.stringify(s).length<2500);
});

function runProvider(preload:string,timeoutMs=2000,abort?:'cancelled'|'deadline'){
  const dir=mkdtempSync(join(tmpdir(),'provider-evidence-'));
  try{
    const file=join(dir,'preload.cjs');writeFileSync(file,preload);
    const moduleUrl=pathToFileURL(resolve('dist/packages/ai/src/application/providers/codex.js')).href;
    const script=`import {CodexProvider} from ${JSON.stringify(moduleUrl)};process.env.NODE_OPTIONS=${JSON.stringify('--require='+JSON.stringify(file))};const controller=new AbortController();${abort?`setTimeout(()=>controller.abort(new DOMException('test',${JSON.stringify(abort==='deadline'?'TimeoutError':'AbortError')})),300);`:''}try{await new CodexProvider(process.execPath,${timeoutMs}).step({model:'',prompt:${JSON.stringify(canary)},signal:controller.signal});process.exitCode=2;}catch(e){process.stdout.write(JSON.stringify(e.diagnostic));}`;
    return JSON.parse(execFileSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8',timeout:10000,windowsHide:true}));
  }finally{rmSync(dir,{recursive:true,force:true});}
}

test('real child process failure evidence reaches the private provider diagnostic',()=>{
  const d=runProvider(`process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'ECONNRESET ${canary}',status:503,request_id:'req_evidence123456789'}})+'\\n');process.stderr.write('private ${canary}');process.exit(1);`);
  assert.equal(d.stage,'process-exit');assert.equal(d.exitCode,1);assert.ok(d.process.pid>0);assert.ok(d.process.spawnMs>=0);assert.ok(d.process.closeMs>=d.process.exitMs);
  assert.ok(d.evidence.stdoutBytes>0);assert.ok(d.evidence.stderrBytes>0);assert.equal(d.evidence.events['turn.failed'],1);assert.deepEqual(d.evidence.httpStatuses,[503]);
  assert.ok(!JSON.stringify(d).includes(canary));
});

test('real child timeout records output silence, host timer lag and termination cause',()=>{
  const d=runProvider("process.stdout.write('{\"type\":\"turn.started\"}\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000);",300);
  assert.equal(d.reason,'Codex timed out');assert.equal(d.process.stopReason,'provider-timeout');assert.ok(d.process.timeoutLagMs>=0);
  assert.ok(d.process.stopRequestedMs>=300);assert.ok(d.evidence.silenceMs>0);assert.equal(d.evidence.events['turn.started'],1);
});

test('host cancellation and round deadline remain distinguishable from provider timeout',()=>{
  for(const abort of ['cancelled','deadline'] as const){
    const d=runProvider('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000);',2000,abort);
    assert.equal(d.reason,'AI stopped');assert.equal(d.process.stopReason,abort==='deadline'?'round-deadline':'cancelled');
    assert.equal(d.process.timeoutLagMs,undefined);
  }
});

test('explicit Responses HTTP 429 ends CLI retry silence promptly and retains rate-limit evidence',()=>{
 const d=runProvider("process.stderr.write('responses_api request failed: HTTP 429'+String.fromCharCode(10));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000);",5000);
 assert.equal(d.reason,'rate-limit');assert.equal(d.httpStatus,429);
 assert.equal(d.process.stopReason,'rate-limit');assert.ok(d.durationMs<4000);
 assert.ok(d.evidence.httpRoutes.includes('responses'));
});

test('metadata HTTP 429 does not cancel an otherwise running model call',()=>{
 const d=runProvider("process.stderr.write('metadata refresh HTTP 429 at https://example.test/models'+String.fromCharCode(10));process.stderr.write('sending https://example.test/responses'+String.fromCharCode(10));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000);",300);
 assert.equal(d.reason,'Codex timed out');assert.equal(d.process.stopReason,'provider-timeout');
});
