import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {cpSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const arguments_=process.argv.slice(2);
if(arguments_.length&&!(arguments_.length===2&&arguments_[0]==='--out'))throw Error('Usage: node scripts/build-player-sdk.mjs [--out OUTPUT_DIRECTORY]');
const output=arguments_.length?resolve(arguments_[1]):join(root,'artifacts','player-sdk');
mkdirSync(join(output,'dist'),{recursive:true});
await build({absWorkingDir:root,entryPoints:[join(root,'packages/player-sdk/src/index.ts')],outfile:join(output,'dist/index.js'),bundle:true,platform:'node',format:'esm',target:'node22',sourcemap:true,metafile:true}).then(result=>{
  const inputs=Object.keys(result.metafile.inputs);
  if(inputs.some(name=>!/^packages\/(player-sdk|contracts)\/src\//.test(name.replaceAll('\\','/'))))throw Error('SDK bundle crossed its public dependency boundary');
  writeFileSync(join(output,'dist/bundle-inputs.json'),JSON.stringify(inputs,null,2)+'\n');
});
const result=spawnSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--declaration','--emitDeclarationOnly','--strict','--skipLibCheck','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--rootDir',join(root,'packages'),'--outDir',join(output,'dist/types'),join(root,'packages/player-sdk/src/index.ts')],{cwd:root,encoding:'utf8'});
if(result.status!==0)throw Error(result.stdout+result.stderr);
const source=JSON.parse(readFileSync(join(root,'packages/player-sdk/package.json'),'utf8'));
const {scripts:_,...manifest}=source;
writeFileSync(join(output,'package.json'),JSON.stringify(manifest,null,2)+'\n');
cpSync(join(root,'packages/player-sdk/README.md'),join(output,'README.md'));
cpSync(join(root,'LICENSE'),join(output,'LICENSE'));
console.log(JSON.stringify({package:source.name,output,module:'dist/index.js',types:source.types,dependencies:[]},null,2));
