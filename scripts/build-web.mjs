import { build } from "esbuild";
await import('./build-hall.mjs');
await build({
  entryPoints: ["packages/client/src/fleet-arrival-worker.ts"], bundle:true,
  outfile:"packages/client/public/fleet-arrival-worker.js", format:"esm",platform:"browser",minify:true,
});
await build({
  entryPoints: ['packages/client/src/global-prediction-worker.ts'], bundle: true,
  outfile: 'packages/client/public/global-prediction-worker.js', format: 'esm',
  platform: 'browser', minify: true,
});
await build({
  entryPoints: ['packages/client/src/lab-history-worker.ts'], bundle: true,
  outfile: 'packages/client/public/lab-history-worker.js', format: 'esm',
  platform: 'browser', minify: true,
});
await build({
  entryPoints: ['packages/client/src/prediction-worker.ts'], bundle: true,
  outfile: 'packages/client/public/prediction-worker.js', format: 'esm',
  platform: 'browser', minify: true,
});
await build({
  entryPoints: ["packages/client/src/main.tsx"],
  bundle: true,
  external: ["/assets/*"],
  outfile: "packages/client/public/app.js",
  format: "esm",
  sourcemap: true,
  minify: false,
});
await build({
  entryPoints:["packages/client/src/player-main.tsx"],bundle:true,external:["/assets/*"],
  outfile:"packages/client/public/player.js",format:"esm",sourcemap:false,minify:false,
});
await build({
  entryPoints:['packages/client/src/agent-console-main.tsx'],bundle:true,external:['/assets/*'],
  outfile:'packages/client/agent-console-public/agent-console.js',format:'esm',platform:'browser',sourcemap:false,minify:false,
});
