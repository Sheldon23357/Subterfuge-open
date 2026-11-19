import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,join} from 'node:path';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url);
const ts=require(join(root,'runtime/compiler/typescript/lib/typescript.js'));
if(process.argv.length!==3)throw Error('Usage: node tools/check-plugin.mjs plugins/your-bot');
const directory=resolve(process.argv[2]),manifest=JSON.parse(readFileSync(join(directory,'bot-plugin.json'),'utf8'));
const exports=JSON.parse(readFileSync(join(root,'plugin-sdk/API.json'),'utf8')).exports;
const paths=Object.fromEntries(exports.map(key=>['@subterfuge/bot-sdk'+(key==='.'?'':key.slice(1)),[join(root,'plugin-sdk/types/packages/bot-sdk/src',key==='.'?'index.d.ts':key.slice(2)+'.d.ts')]]));
paths['@subterfuge/hybrid']=[join(root,'plugins/hybrid/src/api.ts')];
const program=ts.createProgram([resolve(directory,manifest.entry)],{noEmit:true,strict:true,exactOptionalPropertyTypes:true,noUncheckedIndexedAccess:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,baseUrl:root,paths,typeRoots:[join(root,'plugin-sdk/types/node_modules/@types')]});
const diagnostics=ts.getPreEmitDiagnostics(program);
if(diagnostics.length){console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>directory,getNewLine:()=> '\n'}));process.exitCode=1;}
else {const result=spawnSync(process.execPath,[join(root,'runtime/agent-cli.mjs'),'--check-plugin',directory],{stdio:'inherit',cwd:root});process.exitCode=result.status??1;}
