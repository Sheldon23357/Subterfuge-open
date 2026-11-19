#!/usr/bin/env node
/** Closed host artifacts plus editable plugins. Never reads runtime state or credentials. */
import {build} from 'esbuild';
import {buildBotSdk} from './build-bot-sdk.mjs';
import {spawnSync} from 'node:child_process';
import {createRequire,builtinModules} from 'node:module';
import {createHash} from 'node:crypto';
import {cpSync,readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync,renameSync,chmodSync,statSync} from 'node:fs';
import {resolve,dirname,join,relative,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url);
const args=process.argv.slice(2);let output,archive=true;
for(let i=0;i<args.length;i++){if(args[i]==='--out'&&!output&&args[i+1])output=resolve(args[++i]);else if(args[i]==='--no-archive'&&archive)archive=false;else throw Error('Usage: node scripts/build-bot-release.mjs --out DIRECTORY [--no-archive]');}
if(!output)throw Error('--out is required');if(existsSync(output)||archive&&existsSync(output+'.zip'))throw Error('Output already exists; release builds never overwrite previous work');
mkdirSync(output,{recursive:true});
const put=(path,data)=>{const target=join(output,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,data,{flag:'wx'});};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const exports=JSON.parse(readFileSync(join(root,'packages/bot-sdk/exports.json'),'utf8'));
const entries={'agent-cli':'packages/ai/src/application/agent-cli.ts','bot-worker':'packages/ai/src/controller/local/bot-worker.ts','tactical-worker':'packages/ai/src/controller/analysis/tactical-worker.ts','tactical-forecast-worker':'packages/ai/src/controller/analysis/tactical-forecast-worker.ts'};
for(const key of Object.keys(exports))entries['sdk-'+key.replaceAll('/','--')]='packages/bot-sdk/src/'+key+'.ts';
const host=await build({absWorkingDir:root,entryPoints:entries,outdir:join(output,'runtime'),bundle:true,splitting:true,chunkNames:'shared-[hash]',format:'esm',platform:'node',target:'node22',minify:true,sourcemap:false,legalComments:'eof',metafile:true,define:{__BOT_PLUGIN_BUNDLED__:'true'}});
renameSync(join(output,'runtime/agent-cli.js'),join(output,'runtime/agent-cli.mjs'));
for(const input of Object.keys(host.metafile.inputs)){const path=resolve(root,input),local=relative(root,path).replaceAll('\\','/');if(local.startsWith('plugins/')||local.startsWith('packages/server/')||local==='packages/ai/src/reference.ts')throw Error('Host bundles concrete strategy or server code: '+local);}
for(const artifact of Object.values(host.metafile.outputs))for(const dependency of artifact.imports)if(dependency.external&&!dependency.path.startsWith('node:')&&!builtinModules.includes(dependency.path))throw Error('Host has unbundled dependency: '+dependency.path);
const web=await build({absWorkingDir:root,entryPoints:['packages/client/src/agent-console-main.tsx'],outfile:join(output,'web/agent-console.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,sourcemap:false,metafile:true,legalComments:'eof',external:['/assets/abyss-command.png']});
for(const file of ['index.html','assets/abyss-command.png']){const target=join(output,'web',file);mkdirSync(dirname(target),{recursive:true});cpSync(join(root,'packages/client/agent-console-public',file),target);}
const plugin=join(root,'plugins/hybrid');for(const file of ['bot-plugin.json','package.json',...readdirSync(join(plugin,'src')).filter(f=>f.endsWith('.ts')).map(f=>'src/'+f)])put('plugins/hybrid/'+file,readFileSync(join(plugin,file)));
const sdk=buildBotSdk(join(output,'plugin-sdk'),{root});
put('plugins/hybrid/tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,exactOptionalPropertyTypes:true,noUncheckedIndexedAccess:true,noEmit:true,baseUrl:'../..',paths:{'@subterfuge/bot-sdk':['plugin-sdk/types/packages/bot-sdk/src/index.d.ts'],'@subterfuge/bot-sdk/*':['plugin-sdk/types/packages/bot-sdk/src/*.d.ts']},typeRoots:['../../plugin-sdk/types/node_modules/@types']},include:['src/**/*.ts']},null,2)+'\n');
// Preserve esbuild's package self-reference and native binary fallback without node_modules.
const esbuildMain=require.resolve('esbuild'),esbuildRoot=dirname(dirname(esbuildMain)),nativeName='@esbuild/'+process.platform+'-'+process.arch;
const nativeSubpath=process.platform==='win32'?'esbuild.exe':'bin/esbuild',native=require.resolve(nativeName+'/'+nativeSubpath);
put('runtime/compiler/esbuild/lib/main.js',readFileSync(esbuildMain));
put('runtime/compiler/esbuild/package.json',JSON.stringify({name:'esbuild',version:JSON.parse(readFileSync(join(esbuildRoot,'package.json'),'utf8')).version,type:'commonjs',main:'./lib/main.js',exports:{'.':'./lib/main.js'}}));
const nativeTarget='runtime/compiler/esbuild/lib/downloaded-'+nativeName.replace('/','-')+'-'+basename(nativeSubpath);put(nativeTarget,readFileSync(native));chmodSync(join(output,nativeTarget),0o755);
const typescriptRoot=dirname(require.resolve('typescript/package.json'));
put('runtime/compiler/typescript/package.json',readFileSync(join(typescriptRoot,'package.json')));
for(const file of readdirSync(join(typescriptRoot,'lib')).filter(f=>f==='typescript.js'||f.endsWith('.d.ts')))put('runtime/compiler/typescript/lib/'+file,readFileSync(join(typescriptRoot,'lib',file)));
const dependencies=new Map();
function packageRoot(input){for(let directory=dirname(resolve(root,input));dirname(directory)!==directory;directory=dirname(directory)){const parent=dirname(directory);if(basename(parent)==='node_modules'||basename(parent).startsWith('@')&&basename(dirname(parent))==='node_modules')return directory;}return null;}
for(const result of [host,web])for(const input of Object.keys(result.metafile.inputs)){const directory=packageRoot(input);if(directory)dependencies.set(directory,true);}
for(const directory of [esbuildRoot,typescriptRoot,dirname(require.resolve('@types/node/package.json')),dirname(require.resolve('undici-types/package.json'))])dependencies.set(directory,true);
const notices=[];
for(const directory of [...dependencies.keys()].sort()){
 const metadata=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));const expectedName=basename(dirname(directory))==='node_modules'?basename(directory):basename(dirname(directory))+'/'+basename(directory);if(metadata.name!==expectedName)throw Error('Bundled dependency package name mismatch: '+expectedName);if(!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(metadata.name))throw Error('Invalid dependency package name');
 const license=['LICENSE','LICENSE.md','LICENSE.txt'].map(f=>join(directory,f)).find(existsSync);if(!license)throw Error('Missing bundled dependency license: '+metadata.name);if(!readFileSync(license,'utf8').trim())throw Error('Empty bundled dependency license: '+metadata.name);
 let file='licenses/'+metadata.name.replace('/','--')+'.txt';if(existsSync(join(output,file))&&!readFileSync(join(output,file)).equals(readFileSync(license)))file='licenses/'+metadata.name.replace('/','--')+'/'+sha(readFileSync(license))+'.txt';if(!existsSync(join(output,file)))put(file,readFileSync(license));notices.push({package:metadata.name,version:metadata.version,license:file,sha256:sha(readFileSync(license))});
 if(existsSync(join(directory,'ThirdPartyNoticeText.txt')))put('licenses/'+metadata.name.replace('/','--')+'-third-party.txt',readFileSync(join(directory,'ThirdPartyNoticeText.txt')));
}
for(const file of ['README.md','DEVELOPING.md','launch.mjs','start.sh','start.cmd','tools/check-plugin.mjs'])put(file,readFileSync(join(root,'examples/bot-release',file)));
put('LICENSE',readFileSync(join(root,'LICENSE')));
for(const file of ['bot-plugin.json','index.ts'])put('examples/minimal-bot/'+file,readFileSync(join(root,'examples/bot-plugins/minimal-bot',file)));
put('examples/minimal-bot/tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,exactOptionalPropertyTypes:true,noUncheckedIndexedAccess:true,noEmit:true,baseUrl:'../..',paths:{'@subterfuge/bot-sdk':['plugin-sdk/types/packages/bot-sdk/src/index.d.ts'],'@subterfuge/bot-sdk/*':['plugin-sdk/types/packages/bot-sdk/src/*.d.ts']},typeRoots:['../../plugin-sdk/types/node_modules/@types']},include:['*.ts']},null,2)+'\n');
chmodSync(join(output,'start.sh'),0o755);put('package.json',JSON.stringify({name:'subterfuge-bot',private:true,type:'module',version:'1.0.0',engines:{node:'>=22.13.0'},scripts:{start:'node launch.mjs',check:'node tools/check-plugin.mjs plugins/hybrid'}},null,2)+'\n');
const hostInputs=Object.keys(host.metafile.inputs).map(file=>relative(root,resolve(root,file)).replaceAll('\\','/')).filter(p=>!p.includes('node_modules')).sort();
put('BUILD-INFO.json',JSON.stringify({format:'bot-release/1',platform:process.platform,arch:process.arch,pluginApi:1,sdk,hostInputs,hostBuildInputs:Object.keys(host.metafile.inputs).map(path=>({path,sha256:sha(readFileSync(resolve(root,path)))})),notices,nativeCompiler:{package:nativeName,version:JSON.parse(readFileSync(join(esbuildRoot,'package.json'),'utf8')).version,license:'licenses/esbuild.txt'}},null,2)+'\n');
const files=[];function walk(directory){for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.isSymbolicLink())throw Error('Release cannot contain symlinks');const full=join(directory,entry.name);if(entry.isDirectory())walk(full);else files.push(relative(output,full).replaceAll('\\','/'));}}walk(output);
const fixed=Object.fromEntries(files.filter(file=>/^(runtime\/|web\/|tools\/|plugin-sdk\/)/.test(file)).map(file=>[file,sha(readFileSync(join(output,file)))]));
for(const file of Object.keys(fixed))chmodSync(join(output,file),file===nativeTarget?0o555:0o444);
put('HOST-MANIFEST.json',JSON.stringify({format:'host-integrity/1',platform:process.platform,arch:process.arch,files:fixed},null,2)+'\n');files.push('HOST-MANIFEST.json');
put('SHA256SUMS',files.map(file=>sha(readFileSync(join(output,file)))+'  '+file).join('\n')+'\n');
if(archive){const result=spawnSync(process.execPath,[join(root,'scripts/archive-distribution.mjs'),output],{encoding:'utf8'});if(result.status!==0)throw Error(result.stdout+result.stderr);}
console.log(JSON.stringify({output,archive:archive?output+'.zip':null,platform:process.platform,arch:process.arch,pluginModules:readdirSync(join(plugin,'src')).length,sdk,hostInputs:hostInputs.length},null,2));
