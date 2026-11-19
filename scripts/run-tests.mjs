import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

// Keep the complete suite as the default. Packaging is a separate, explicit
// development workflow; it is still included in full regression.
const packaging = new Set(['player-sdk-package.test.js', 'player-devkit-package.test.js','bot-release-package.test.js']);
// This fixture advances a synthetic wall clock while observing real async
// rounds; CPU contention can introduce an extra strategic wake.
// Hybrid workers and coordinated checkpoint fixtures have real startup and I/O deadlines.
const serialOnly = new Set(['lab-ai-convergence.test.js', 'hybrid-bot.test.js', 'ai-protocol-checkpoint.test.js']);
const targets = [];
let suite = 'full', concurrency = Math.min(4, availableParallelism()), list = false;
for (const arg of process.argv.slice(2)) {
 if (arg.startsWith('--suite=')) suite = arg.slice('--suite='.length);
 else if (arg.startsWith('--concurrency=')) concurrency = Number(arg.slice('--concurrency='.length));
 else if (arg === '--list') list = true;
 else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
 else targets.push(arg);
}
if (!['full', 'quick', 'package'].includes(suite)) throw new Error(`Unknown suite: ${suite}`);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Concurrency must be an integer from 1 to 32');
if (!targets.length) targets.push('dist/tests');
// Isolated build directories or compiled tests can be selected for reviews
// while another process builds dist. Optional original-client comparisons live
// in dist/tests/reference and are never included by this non-recursive scan.
// Compare filesystem identities so directory aliases cannot bypass source filtering.
const defaultDirectory=fs.existsSync('dist/tests')?fs.realpathSync('dist/tests'):undefined;
const files=[...new Set(targets.flatMap(target=>fs.statSync(target).isDirectory()
 ?fs.readdirSync(target).filter(name=>name.endsWith('.test.js')&&(fs.realpathSync(target)!==defaultDirectory||fs.existsSync(path.join('tests',name.replace(/\.js$/,'.ts'))))).sort().map(name=>path.resolve(target,name))
 :[path.resolve(target)]))].filter(file=>suite==='full'||(suite==='package')===packaging.has(path.basename(file)));
if(!files.length) throw new Error('No compiled test files');
if (list) { console.log(files.join('\n')); process.exit(0); }
console.log(`Regression suite=${suite}, files=${files.length}, concurrency=${concurrency}`);
// Every HTTP fixture is loopback. Environment-proxy support must not send those
// requests through the user's external proxy (NODE_USE_ENV_PROXY on Node 24).
const bypass=[process.env.NO_PROXY,process.env.no_proxy,'127.0.0.1','localhost','::1'].filter(Boolean).join(',');
// Managed worktree absolute paths can exceed Windows' command-line limit
// as the suite grows. Resolve once above, then use equivalent shorter paths.
const testFiles=files.map(file=>{const local=path.relative(process.cwd(),file);return local.length<file.length&&!local.startsWith('-')?local:file;});
const phases = concurrency === 1
 ? [{name:'serial', concurrency:1, files:testFiles}]
 : [
  {name:'parallel', concurrency, files:testFiles.filter(file=>!serialOnly.has(path.basename(file)))},
  {name:'timing-sensitive', concurrency:1, files:testFiles.filter(file=>serialOnly.has(path.basename(file)))},
 ];
let status = 0;
for (const phase of phases) {
 if (!phase.files.length) continue;
 console.log(`Regression phase=${phase.name}, files=${phase.files.length}, concurrency=${phase.concurrency}`);
 // Windows limits the complete command line, even after paths are made
 // relative. Keep long isolated-build paths usable without changing cwd:
 // fixtures resolve repository examples and assets against the current cwd.
 const batches=[];let batch=[],characters=process.execPath.length+128;
 for(const file of phase.files){
  if(process.platform==='win32'&&batch.length&&characters+file.length+3>24000){batches.push(batch);batch=[];characters=process.execPath.length+128;}
  batch.push(file);characters+=file.length+3;
 }
 if(batch.length)batches.push(batch);
 for(const batch of batches){
  const result=spawnSync(process.execPath,['--test',`--test-concurrency=${phase.concurrency}`,...batch],{stdio:'inherit',env:{...process.env,NO_PROXY:bypass,no_proxy:bypass}});
  if(result.error)console.error(`Unable to start test runner: ${result.error.message}`);
  if(result.status!==0)status=result.status??1;
 }
}
process.exit(status);
