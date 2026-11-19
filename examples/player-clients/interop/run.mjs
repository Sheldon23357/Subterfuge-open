#!/usr/bin/env node
/** Frozen-source isolated tests. Never writes main/dist or installs dependencies. */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,cpSync,mkdirSync,readdirSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
const original=resolve(import.meta.dirname,'../../..');
const temporary=mkdtempSync(join(tmpdir(),'player-client-tests-'));
const root=join(temporary,'frozen-source');mkdirSync(root);
const go=process.env.GO_BIN||'go',python=process.env.PYTHON||'python3';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function manifest(directory) {
  const paths=[];
  function visit(current){for(const entry of readdirSync(current,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(current,entry.name);if(entry.isDirectory())visit(path);else if(entry.isFile())paths.push(path);}}
  visit(directory);return paths.map(path=>`${sha(readFileSync(path))}  ${relative(directory,path).replaceAll('\\','/')}\n`).join('');
}
async function run(program,args,{cwd=root,env={},capture=false}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{cwd,env:{...process.env,...env},stdio:capture?['ignore','pipe','pipe']:'inherit'});
    let output='';if(capture){child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);}
    child.on('error',reject);child.on('close',(code,signal)=>code===0?resolve(output):reject(Error(`${program} exited ${code??signal}${capture?': '+output:''}`)));
  });
}
try {
  // Compile/test only this frozen copy; concurrent source changes cannot alter it.
  for(const name of ['packages','tests','protocol','tsconfig.json','package.json','package-lock.json'])cpSync(join(original,name),join(root,name),{recursive:true});
  mkdirSync(join(root,'docs'));
  cpSync(join(original,'docs/rules'),join(root,'docs/rules'),{recursive:true});
  mkdirSync(join(root,'examples'));
  cpSync(join(original,'examples/fleet-lab.json'),join(root,'examples/fleet-lab.json'));
  cpSync(join(original,'examples/player-clients'),join(root,'examples/player-clients'),{recursive:true,filter:path=>!path.includes('__pycache__')&&!path.endsWith('.pyc')});
  symlinkSync(join(original,'node_modules'),join(root,'node_modules'),process.platform==='win32'?'junction':'dir'); // Existing server build dependencies, never client dependencies.
  const sourceManifest=manifest(root);writeFileSync(join(temporary,'source.sha256'),sourceManifest);
  console.log(`Frozen source: ${sha(sourceManifest)} (${sourceManifest.trim().split('\n').length} files)`);
  const version=await run(go,['version'],{capture:true});
  if(!/^go version go\d+\./.test(version))throw Error('GO_BIN must point to the Go language compiler, not another program named go');
  console.log(version.trim());
  const build=join(temporary,'protocol-build');
  await run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p',join(root,'tsconfig.json'),'--outDir',build]);
  writeFileSync(join(build,'package.json'),'{"type":"module"}\n');
  const buildManifest=manifest(build);writeFileSync(join(temporary,'build.sha256'),buildManifest);
  console.log(`Fixed TypeScript build: ${sha(buildManifest)} (${buildManifest.trim().split('\n').length} files)`);
  await run(python,['-m','unittest','discover','-s','examples/player-clients/python','-v'],{env:{PYTHONDONTWRITEBYTECODE:'1'}});
  const goDir=join(root,'examples/player-clients/go');
  await run(go,['test','-count=1','-v','./...'],{cwd:goDir,env:{GOTOOLCHAIN:'local'}});
  await run(go,['vet','./...'],{cwd:goDir,env:{GOTOOLCHAIN:'local'}});
  const binary=join(temporary,process.platform==='win32'?'player-client.exe':'player-client');
  const cleanGo=join(temporary,'standalone-go');cpSync(goDir,cleanGo,{recursive:true});
  const cleanPythonDir=join(temporary,'standalone-python');mkdirSync(cleanPythonDir);
  const cleanPython=join(cleanPythonDir,'client.py');cpSync(join(root,'examples/player-clients/python/client.py'),cleanPython);
  await run(go,['build','-trimpath','-buildvcs=false','-o',binary,'./cmd/player-client'],{cwd:cleanGo,env:{GOTOOLCHAIN:'local'}});
  console.log(`Standalone clients: python=${sha(readFileSync(cleanPython))} go-binary=${sha(readFileSync(binary))}`);
  await run(process.execPath,['--test','examples/player-clients/interop/independent-clients.test.mjs'],{env:{PLAYER_PROTOCOL_BUILD:build,PLAYER_GO_BINARY:binary,PLAYER_PYTHON_CLIENT:cleanPython,PYTHON:python,PYTHONDONTWRITEBYTECODE:'1'}});
  if(manifest(root)!==sourceManifest)throw Error('Frozen source changed while testing');
  if(manifest(build)!==buildManifest)throw Error('Fixed build changed while testing');
  console.log('Independent Python, Go, and real loopback HTTP suites passed. No deployed server or model used.');
} finally {
  if(process.env.PLAYER_INTEROP_KEEP==='1')console.log(`Retained isolated evidence: ${temporary}`);
  else rmSync(temporary,{recursive:true,force:true});
}
