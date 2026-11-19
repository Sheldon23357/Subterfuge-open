import {createHash} from 'node:crypto';
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {resolve, relative, join, basename} from 'node:path';
import {spawn} from 'node:child_process';

async function files(root, directory) {
  const result=[];
  for (const entry of await readdir(resolve(root,directory),{withFileTypes:true})) {
    if (entry.name==='node_modules') continue;
    const name=join(directory,entry.name);
    if (entry.isDirectory()) result.push(...await files(root,name));
    else if (entry.isFile()) result.push(name);
    else throw Error(`Build input/output is not a regular file: ${name}`);
  }
  return result;
}
async function digest(root,names) {
  const hash=createHash('sha256');
  for (const name of names.sort()) {
    hash.update(relative(root,resolve(root,name)).replaceAll('\\','/'));
    hash.update('\0');hash.update(await readFile(resolve(root,name)));hash.update('\0');
  }
  return hash.digest('hex');
}
export async function sourceDigest(root) {
  const names=['package.json','package-lock.json','tsconfig.json',
    'node_modules/typescript/package.json','node_modules/esbuild/package.json'];
  // Track build checks and their local helpers, including newly added helpers.
  // Restart orchestration and Markdown do not change emitted code.
  names.push(...(await files(root,'scripts')).filter(name=>!basename(name).startsWith('quick-restart')));
  names.push(...await files(root,'tests'));
  names.push(...(await files(root,'protocol')).filter(name=>/\.(?:json|ts)$/.test(name)));
  for (const pkg of await readdir(resolve(root,'packages'),{withFileTypes:true})) {
    if (!pkg.isDirectory()) continue;
    const metadata=join('packages',pkg.name,'package.json');
    try {await readFile(resolve(root,metadata));names.push(metadata);}
    catch(error){if(error.code!=='ENOENT')throw error;}
    try {names.push(...await files(root,join('packages',pkg.name,'src')));}
    catch(error) {if(error.code!=='ENOENT')throw error;}
  }
  return digest(root,names);
}
async function outputDigest(root) {
  const names=await files(root,'dist');
  for(const dir of ['packages/client/public','packages/client/agent-console-public']) {
    names.push(...(await files(root,dir)).filter(name=>/\.(?:js|map)$/.test(name)));
  }
  for(const required of ['dist/packages/server/src/main.js','dist/packages/ai/src/application/agent-cli.js',
    'packages/client/public/app.js','packages/client/agent-console-public/agent-console.js']) {
    await readFile(resolve(root,required));
  }
  return digest(root,names);
}
export async function verifyBuild(root,receiptPath) {
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  if(receipt.format!=='dev-build/1'||resolve(receipt.root)!==resolve(root)||receipt.node!==process.version||
    receipt.source!==await sourceDigest(root)||receipt.output!==await outputDigest(root)) {
    throw Error('Prebuilt receipt is stale; run quick-restart again to build current source.');
  }
  return receipt;
}
export async function prepareBuild(root,receiptPath,run=runBuild) {
  try {return {...await verifyBuild(root,receiptPath),cached:true};}catch{}
  const before=await sourceDigest(root);
  await run(root);
  if(before!==await sourceDigest(root))throw Error('Source changed during build; restart was not attempted.');
  const receipt={format:'dev-build/1',root:resolve(root),node:process.version,source:before,
    output:await outputDigest(root),builtAt:new Date().toISOString()};
  await mkdir(resolve(receiptPath,'..'),{recursive:true});
  await writeFile(receiptPath,JSON.stringify(receipt,null,2));
  return {...receipt,cached:false};
}
async function runBuild(root) {
  // web:build includes TypeScript/boundary checks AND the agent console bundle.
  const command=process.platform==='win32'?(process.env.ComSpec??'cmd.exe'):'npm';
  const args=process.platform==='win32'?['/d','/s','/c','npm run web:build']:['run','web:build'];
  await new Promise((done,reject)=>{
    const child=spawn(command,args,{cwd:root,stdio:'inherit'});
    child.once('error',reject);child.once('exit',code=>code===0?done():reject(Error(`Build failed (${code})`)));
  });
}
