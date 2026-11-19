import {readFile,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
const css=await readFile('packages/client/src/hall-loading.css','utf8');
const htmlPath='packages/client/public/hall.html';
const html=await readFile(htmlPath,'utf8');
await writeFile(htmlPath,html.replace(/<style id="hall-loading-style">[\s\S]*?<\/style>/,`<style id="hall-loading-style">${css}</style>`));
await build({entryPoints:['packages/client/src/GameHall.tsx'],bundle:true,external:['/assets/*'],outfile:'packages/client/public/hall.js',format:'esm',platform:'browser',minify:true});
