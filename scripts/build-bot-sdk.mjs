import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync,statSync,mkdtempSync,rmSync} from 'node:fs';
import {dirname,resolve,relative,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import ts from 'typescript';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function buildBotSdk(output,{root=project,compiled=join(root,'dist')}={}){
 if(existsSync(output))throw Error('SDK output already exists');mkdirSync(output,{recursive:true});
 const entries=JSON.parse(readFileSync(join(root,'packages/bot-sdk/exports.json'),'utf8'));
 const generated=mkdtempSync(join(tmpdir(),'subterfuge-bot-types-'));
 try{
 const parsed=ts.parseJsonConfigFileContent(ts.readConfigFile(join(root,'tsconfig.json'),ts.sys.readFile).config,ts.sys,root);
 const program=ts.createProgram(Object.keys(entries).map(k=>join(root,'packages/bot-sdk/src',k+'.ts')),{...parsed.options,rootDir:root,outDir:generated,noEmit:false,declaration:true,emitDeclarationOnly:true,incremental:false});
 const diagnostics=ts.getPreEmitDiagnostics(program);if(diagnostics.length)throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}));
 program.emit();compiled=generated;
 const pending=Object.keys(entries).map(k=>'packages/bot-sdk/src/'+k+'.d.ts'),copied=new Set();
 while(pending.length){
  const path=pending.pop();if(copied.has(path))continue;
  if(path.startsWith('../')||path.startsWith('plugins/')||path.startsWith('packages/server/'))throw Error('SDK declarations crossed the host boundary: '+path);
  const absolute=resolve(compiled,path),raw=readFileSync(absolute,'utf8');
  // TS may shorten inferred import() types using the repository baseUrl.
  // Published declarations must resolve without that repository or compiler setting.
  const source=raw.replace(/(['"])((?:packages|plugins)\/[^'"\r\n]+\.js)\1/g,(_match,quote,spec)=>{let local=relative(dirname(absolute),resolve(compiled,spec)).replaceAll('\\','/');if(!local.startsWith('.'))local='./'+local;return quote+local+quote;});copied.add(path);
  const target=join(output,'types',path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,source);
  const syntax=ts.createSourceFile(absolute,source,ts.ScriptTarget.Latest,true);
  function visit(node){let spec;if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))spec=node.moduleSpecifier;if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument))spec=node.argument.literal;if(spec&&ts.isStringLiteral(spec)&&spec.text.startsWith('.')){const dep=relative(compiled,resolve(dirname(absolute),spec.text.replace(/\.js$/,'.d.ts'))).replaceAll('\\','/');if(!dep.endsWith('.d.ts'))throw Error('Unexpected SDK type dependency: '+dep);pending.push(dep);}ts.forEachChild(node,visit);}visit(syntax);
 }
 const require=createRequire(join(root,'package.json')),types=resolve(dirname(require.resolve('@types/node/package.json'))),undici=resolve(dirname(require.resolve('undici-types/package.json')));
 for(const [name,directory]of [['@types/node',types],['undici-types',undici]])cpSync(directory,join(output,'types/node_modules',name),{recursive:true,filter:path=>statSync(path).isDirectory()||/\.d\.ts$|package\.json$|LICENSE(?:\.txt)?$/.test(path)});
 const exports=Object.fromEntries(Object.keys(entries).map(key=>[key==='index'?'.':'./'+key,{types:'./types/packages/bot-sdk/src/'+key+'.d.ts',default:'./host-only.mjs'}]));
 writeFileSync(join(output,'package.json'),JSON.stringify({name:'@subterfuge/bot-sdk',version:'1.0.0',type:'module',exports},null,2)+'\n');
 writeFileSync(join(output,'host-only.mjs'),"throw Error('The bot SDK is loaded by SubterfugeBot. Use tools/check-plugin.mjs or the console to run a plugin.');\n");
 writeFileSync(join(output,'API.json'),JSON.stringify({apiVersion:1,exports:Object.keys(exports),declarations:[...copied].sort()},null,2)+'\n');
 return {entries:Object.keys(exports).length,declarations:copied.size};
 }finally{rmSync(generated,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==4||process.argv[2]!=='--out')throw Error('Usage: node scripts/build-bot-sdk.mjs --out DIRECTORY');console.log(JSON.stringify(buildBotSdk(resolve(process.argv[3]))));
}
