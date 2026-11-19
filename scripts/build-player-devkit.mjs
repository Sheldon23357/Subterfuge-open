#!/usr/bin/env node
/** Build a standalone distribution without changing repository build outputs. */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let requested, sdk = true, archive = true;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && !requested && args[i + 1] && !args[i + 1].startsWith('--')) requested = resolve(args[++i]);
  else if (args[i] === '--without-sdk' && sdk) sdk = false;
  else if (args[i] === '--no-archive' && archive) archive = false;
  else throw Error('Usage: node scripts/build-player-devkit.mjs [--out DIRECTORY] [--without-sdk] [--no-archive]');
}
const output = requested ?? mkdtempSync(join(tmpdir(), 'subterfuge-player-devkit-'));
const zipPath = output + '.zip';
// Never remove/reuse a previous package: it may now contain the player's changes.
if (existsSync(output) && (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink() || readdirSync(output).length)) throw Error('Output must be a new or empty directory; existing files are never overwritten');
if (archive && existsSync(zipPath)) throw Error('Archive already exists; choose a new output path');
mkdirSync(output, { recursive: true });
const put = (path, contents) => { mkdirSync(dirname(join(output, path)), { recursive: true }); writeFileSync(join(output, path), contents, { flag: 'wx' }); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = (source, target = source) => { mkdirSync(dirname(join(output, target)), { recursive: true }); cpSync(join(root, source), join(output, target), { recursive: true, force: false, errorOnExist: true, filter: path => !/(?:^|[/\\])(?:__pycache__|node_modules|\.git)(?:[/\\]|$)/.test(path) && !/\.(?:pyc|sqlite|sqlite-wal|sqlite-shm)$/.test(path) }); };
const bundles = [];
async function bundle(name, entry, platform, target) {
  const bundledAsset=dep=>platform==='browser'&&dep.path==='/assets/abyss-command.png';
  const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile: join(output, name), bundle: true, platform, format: 'esm', target, define:{__BOT_PLUGIN_BUNDLED__:'true'}, sourcemap: false, metafile: true, legalComments: 'eof', minify: false, ...(platform==='browser'?{external:['/assets/abyss-command.png']}:{}) });
  const inputs = Object.keys(result.metafile.inputs).sort();
  if (inputs.some(path => path.startsWith('packages/server/'))) throw Error('Distribution must not bundle a game server');
  if (name === 'runtime/protocol.mjs' && inputs.some(path => !path.startsWith('packages/contracts/src/'))) throw Error('Mock wire helpers crossed their public contract boundary');
  for (const artifact of Object.values(result.metafile.outputs)) for (const dependency of artifact.imports) {
    const packagedAsset=platform==='browser'&&dependency.path==='/assets/abyss-command.png'&&existsSync(join(root,'packages/client/agent-console-public',dependency.path.slice(1)));
    if (dependency.external && !packagedAsset && !(platform === 'node' && (dependency.path.startsWith('node:') || builtinModules.includes(dependency.path)))) throw Error('Unbundled external runtime dependency: ' + dependency.path);
  }
  bundles.push({ artifact: name, inputs: inputs.map(path => ({ path, sha256: sha(readFileSync(resolve(root, path))) })), assets: platform==='browser'?[{path:'web/assets/abyss-command.png',sha256:sha(readFileSync(join(root,'packages/client/agent-console-public/assets/abyss-command.png')))}]:[], externalDependencies: [...new Set(Object.values(result.metafile.outputs).flatMap(value => value.imports.filter(dep => dep.external&&!bundledAsset(dep)).map(dep => dep.path)))].sort() });
}
// Reuse the same strategy-free host, SDK and bundled compilers as the standalone bot release.
const staged=mkdtempSync(join(tmpdir(),'subterfuge-devkit-host-')),hostOutput=join(staged,'host');
const hostBuild=spawnSync(process.execPath,[join(root,'scripts/build-bot-release.mjs'),'--out',hostOutput,'--no-archive'],{cwd:root,encoding:'utf8',timeout:120000});
if(hostBuild.status!==0)throw Error('Host build failed: '+hostBuild.stdout+hostBuild.stderr);
const hostInfo=JSON.parse(readFileSync(join(hostOutput,'BUILD-INFO.json'),'utf8'));
copy('LICENSE');
for(const folder of ['runtime','plugins','plugin-sdk','tools'])cpSync(join(hostOutput,folder),join(output,folder),{recursive:true,errorOnExist:true});
bundles.push({artifact:'runtime/agent-cli.mjs',inputs:hostInfo.hostBuildInputs,assets:[],externalDependencies:['node:builtins']});
for(const file of ['bot-plugin.json','index.ts'])copy('examples/bot-plugins/hybrid-copy/'+file);
await bundle('runtime/protocol.mjs', 'packages/contracts/src/protocol-index.ts', 'node', 'node22');
await bundle('web/agent-console.js', 'packages/client/src/agent-console-main.tsx', 'browser', 'es2022');
copy('packages/client/agent-console-public/index.html', 'web/index.html');
copy('packages/client/agent-console-public/assets/abyss-command.png', 'web/assets/abyss-command.png');
copy('protocol/player/v2');
for (const source of ['python/README.md', 'python/client.py', 'python/test_client.py', 'go/README.md', 'go/go.mod', 'go/client.go', 'go/client_test.go', 'go/cmd/player-client/main.go']) copy('examples/player-clients/' + source);
copy('examples/player-clients/interop/number-vectors.json');
copy('docs/open-client');
copy('docs/development/player-devkit.md');
// Explicit template allowlist: a developer's .env, local state, logs or extra files must never enter a release.
const templateFiles = ['README.md', 'DEVELOPING.md', 'FEATURE-MATRIX.md', 'RELEASE-NOTES.md', 'custom-planner.mjs', 'offline-mock.mjs', 'smoke.mjs', 'launch-console.mjs', '.env.example', 'config/game.example.json', 'config/ai.example.json', 'config/development.json', 'config/offline-console.json', 'start-console.sh', 'start-console.cmd', 'start-mock.sh', 'start-mock.cmd', 'run-smoke.sh', 'run-smoke.cmd'];
for (const entry of templateFiles) copy('examples/player-devkit/' + entry, entry);
for (const name of readdirSync(output).filter(name => name.endsWith('.sh'))) chmodSync(join(output, name), 0o755);
// esbuild resolves dependency symlinks by default. Inputs may be relative to an
// external node_modules directory or absolute, including scoped/nested packages.
// Locate the closest actual package root rather than assuming ^node_modules/.
function dependencyPackage(input) {
  const absolute = resolve(root, input);
  for (let directory = dirname(absolute); dirname(directory) !== directory; directory = dirname(directory)) {
    const parent = dirname(directory);
    if (basename(parent) === 'node_modules' || (basename(parent).startsWith('@') && basename(dirname(parent)) === 'node_modules')) return directory;
  }
  const location = relative(root, absolute);
  if (location === '..' || location.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(location)) throw Error('Unclassified external bundle input; cannot verify its license: ' + input);
  return null;
}
const dependencyRoots = new Map();
for (const bundle of bundles) for (const input of bundle.inputs) {
  const directory = dependencyPackage(input.path);
  if (directory) {
    const entry = dependencyRoots.get(directory) ?? { inputs: [], artifacts: new Set() };
    entry.inputs.push(input.path); entry.artifacts.add(bundle.artifact); dependencyRoots.set(directory, entry);
  }
}
if (![...dependencyRoots.values()].some(entry => entry.artifacts.has('web/agent-console.js'))) throw Error('Console bundle has no identifiable third-party packages; cannot verify license completeness');
const thirdPartyLicenses = [], licenseContents = new Map();
for (const [directory, entry] of [...dependencyRoots].sort(([a], [b]) => a.localeCompare(b))) {
  const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')), name = metadata.name;
  const expectedName = basename(dirname(directory)) === 'node_modules' ? basename(directory) : basename(dirname(directory)) + '/' + basename(directory);
  if (name !== expectedName) throw Error('Bundled dependency package name mismatch: ' + expectedName);
  if (typeof name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || name.split('/').some(part => part === '.' || part === '..')) throw Error('Invalid bundled dependency package name');
  const source = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map(file => join(directory, file)).find(file => existsSync(file));
  if (!source) throw Error('Missing bundled dependency license: ' + name);
  const contents = readFileSync(source);
  if (!contents.toString('utf8').trim()) throw Error('Empty bundled dependency license: ' + name);
  let artifact = 'licenses/' + name + '.txt';
  // Multiple versions may contain different notices. Keep all of them.
  if (licenseContents.has(artifact) && !licenseContents.get(artifact).equals(contents)) artifact = 'licenses/' + name + '/' + sha(contents) + '.txt';
  if (!licenseContents.has(artifact)) { put(artifact, contents); licenseContents.set(artifact, contents); }
  thirdPartyLicenses.push({ package: name, version: metadata.version, packageRoot: relative(root, directory).replaceAll('\\', '/'), source: relative(root, source).replaceAll('\\', '/'), artifact, sha256: sha(contents), inputs: [...new Set(entry.inputs)].sort(), artifacts: [...entry.artifacts].sort() });
}
for(const notice of hostInfo.notices){const target=join(output,notice.license);if(!existsSync(target)){mkdirSync(dirname(target),{recursive:true});cpSync(join(hostOutput,notice.license),target);}else if(!readFileSync(target).equals(readFileSync(join(hostOutput,notice.license))))throw Error('Dependency notice conflict');}
for(const file of readdirSync(join(hostOutput,'licenses')).filter(name=>name.endsWith('-third-party.txt')))cpSync(join(hostOutput,'licenses',file),join(output,'licenses',file));
rmSync(staged,{recursive:true,force:true});
if (sdk) {
  const child = spawnSync(process.execPath, [join(root, 'scripts/build-player-sdk.mjs'), '--out', join(output, 'sdk')], { cwd: root, encoding: 'utf8', timeout: 120000 });
  if (child.status !== 0) throw Error('Optional SDK build failed: ' + child.stdout + child.stderr);
}
put('package.json', JSON.stringify({ name: 'subterfuge-player-devkit', version: '0.1.0', private: true, type: 'module', engines: { node: '>=22.13.0' }, scripts: { console: 'node launch-console.mjs', mock: 'node offline-mock.mjs', smoke: 'node smoke.mjs', plan: 'node custom-planner.mjs' } }, null, 2) + '\n');
put('.gitignore', '/.private/\n/.env\n/.env.*\n!/.env.example\n/config/*.local.json\n/examples/player-clients/python/__pycache__/\n/examples/player-clients/go/player-client\n/examples/player-clients/go/player-client.exe\n');
put('BUILD-MANIFEST.json', JSON.stringify({ format: 'player-devkit-build/1', version: '0.1.0', node: '>=22.13.0', optionalSdk: sdk, platform:process.platform,arch:process.arch,bundledCompilers:hostInfo.nativeCompiler,sdk:hostInfo.sdk,compilerLicenses:hostInfo.notices,bundles,thirdPartyLicenses, boundaries: { official: 'Compiled reference AI includes existing prediction/engine helpers, but no game-server module or private authority database.', mock: 'Only public contracts wire validation and synthetic fixtures. No engine/server/AI model imports.', default: 'Configured console; offline provider; paused; no local game bindings discovery.', runtimeDependencies: 'External Node.js only; bundled plugin compilers target this build platform. Python and Go are optional, separately installed tools for their independent examples.' } }, null, 2) + '\n');
const files = [];
function walk(directory) { for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const path = join(directory, entry.name); if (entry.isSymbolicLink()) throw Error('No symlinks permitted in a distribution'); if (entry.isDirectory()) walk(path); else if (entry.isFile()) files.push(relative(output, path).replaceAll('\\', '/')); } }
walk(output);
put('SHA256SUMS', files.map(path => sha(readFileSync(join(output, path))) + '  ' + path).join('\n') + '\n');
files.push('SHA256SUMS');
// Portable ZIP (stored entries, UTF-8 names, fixed timestamps). No executable tools or ZIP dependency.
if (archive) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = data => { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
  let offset = 0; const chunks = [], directory = [];
  for (const path of files.sort()) {
    const data = readFileSync(join(output, path)), name = Buffer.from(path), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    chunks.push(header, name, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((lstatSync(join(output,path)).mode & 0xffff) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42); directory.push(central, name); offset += header.length + name.length + data.length;
  }
  const center = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(center.length, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(zipPath, Buffer.concat([...chunks, center, end]), { flag: 'wx' });
}
console.log(JSON.stringify({ output, archive: archive ? zipPath : null, files: files.length, sdk, bytes: files.reduce((sum, path) => sum + lstatSync(join(output, path)).size, 0) }, null, 2));
