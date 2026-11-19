import { build } from 'esbuild';

await build({
  entryPoints:['packages/client/src/agent-console-main.tsx'],
  bundle:true,
  external:['/assets/*'],
  outfile:'packages/client/agent-console-public/agent-console.js',
  format:'esm',
  platform:'browser',
  sourcemap:false,
  minify:false,
});
