import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {pathToFileURL} from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function files(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(root, join(prefix, entry.name)) : [join(prefix, entry.name).replaceAll('\\', '/')]).sort();
}
function run(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? '')); return result.stdout;
}
/** Extract ZIP's actual central-directory entries, validating paths and local record sizes. */
function unzip(bytes: Buffer, directory: string) {
  const end = bytes.length - 22; assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  assert.equal(start + length, end); let cursor = start; const entries: string[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50); assert.equal(bytes.readUInt16LE(cursor + 10), 0);
    const size = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.ok(name && !name.startsWith('/') && !name.split('/').includes('..') && !name.includes('\\')); assert.ok(!entries.includes(name)); entries.push(name);
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50); assert.equal(bytes.readUInt16LE(offset + 8), 0); assert.equal(bytes.readUInt32LE(offset + 22), size);
    assert.equal(bytes.readUInt32LE(offset + 14), bytes.readUInt32LE(cursor + 16));
    const localName = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28); assert.equal(bytes.subarray(offset + 30, offset + 30 + localName).toString('utf8'), name);
    const content = offset + 30 + localName + localExtra, destination = join(directory, name);
    assert.ok(content + size <= start); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, bytes.subarray(content, content + size));
    cursor += 46 + nameLength + extra + comment;
  }
  assert.equal(cursor, end); return entries.sort();
}

test('Player devkit ZIP runs independently with real configured console assets, no server sources, secrets or installed runtime dependencies', { timeout: 180_000 }, t => {
  const root = process.cwd(), temporary = mkdtempSync(join(tmpdir(), 'player-devkit-package-')), output = join(temporary, 'built'), extracted = join(temporary, 'unpacked'), foreign = join(temporary, 'unrelated-cwd');
  t.after(() => rmSync(temporary, { recursive: true, force: true })); mkdirSync(foreign);
  const sentinel = 'synthetic-build-secret-must-not-be-inlined-' + sha(temporary);
  run(process.execPath, ['scripts/build-player-devkit.mjs', '--out', output], root, { OPENAI_API_KEY: sentinel, PLAYER_EXECUTOR_TOKEN: sentinel });
  assert.ok(existsSync(output + '.zip')); assert.deepEqual(unzip(readFileSync(output + '.zip'), extracted), files(output));
  for (const name of files(output)) assert.deepEqual(readFileSync(join(output, name)), readFileSync(join(extracted, name)), name);
  const packedFiles = files(extracted);
  assert.ok(packedFiles.includes('examples/player-clients/go/cmd/player-client/main.go'));
  assert.ok(packedFiles.includes('examples/player-clients/python/client.py'));
  assert.ok(packedFiles.includes('web/agent-console.css'));
  assert.ok(packedFiles.includes('runtime/agent-cli.mjs'));
  assert.ok(packedFiles.includes('runtime/sdk-index.js'));
  assert.ok(packedFiles.includes('plugins/hybrid/src/background.ts'));
  assert.ok(packedFiles.includes('plugin-sdk/package.json'));
  assert.ok(packedFiles.includes('examples/bot-plugins/hybrid-copy/bot-plugin.json'));
  assert.ok(packedFiles.includes('runtime/bot-worker.js'));
  assert.ok(packedFiles.includes('runtime/tactical-forecast-worker.js'));
  assert.ok(!packedFiles.includes('runtime/bot-forecast-worker.js'));
  assert.ok(packedFiles.includes('runtime/protocol.mjs'));
  assert.ok(!packedFiles.some(name => (/(^|\/)(server|engine|\.git)(\/|$)/.test(name)&&!name.startsWith('plugin-sdk/types/'))||/\.(sqlite|db|pyc)$/.test(name)||name.includes('/node_modules/')&&!name.startsWith('plugin-sdk/types/node_modules/')));
  for (const name of files(join(root, 'protocol/player/v2'))) assert.deepEqual(readFileSync(join(root, 'protocol/player/v2', name)), readFileSync(join(extracted, 'protocol/player/v2', name)));
  const manifest = JSON.parse(readFileSync(join(extracted, 'BUILD-MANIFEST.json'), 'utf8'));
  assert.equal(manifest.optionalSdk, true);
  for (const bundle of manifest.bundles) {
    assert.ok(bundle.inputs.every((input: {path: string}) => !input.path.startsWith('packages/server/')));
    assert.ok(bundle.externalDependencies.every((path: string) => path.startsWith('node:')));
    if (bundle.artifact === 'runtime/protocol.mjs') assert.ok(bundle.inputs.every((input: {path: string}) => input.path.startsWith('packages/contracts/src/')));
    for (const input of bundle.inputs) assert.equal(input.sha256, sha(readFileSync(resolve(root, input.path))));
    for (const asset of bundle.assets??[]) assert.equal(asset.sha256,sha(readFileSync(join(extracted,asset.path))));
    for (const input of bundle.inputs) {
      if (resolve(root, input.path).replaceAll('\\', '/').includes('/node_modules/')) assert.ok(manifest.thirdPartyLicenses.some((notice: {inputs: string[]}) => notice.inputs.includes(input.path)), input.path);
    }
  }
  assert.deepEqual([...new Set(manifest.thirdPartyLicenses.map((notice: {package: string}) => notice.package))].sort(), ['lucide-react', 'react', 'react-dom', 'scheduler']);
  for (const notice of manifest.thirdPartyLicenses) {
    const actual = readFileSync(resolve(root, notice.source));
    assert.deepEqual(readFileSync(join(extracted, notice.artifact)), actual);
    assert.equal(notice.sha256, sha(actual)); assert.ok(actual.toString('utf8').trim());
  }
  for (const line of readFileSync(join(extracted, 'SHA256SUMS'), 'utf8').trim().split('\n')) { const [hash, name] = line.split('  '); assert.ok(hash && name); assert.equal(sha(readFileSync(join(extracted, name!))), hash); }
  for (const name of packedFiles) assert.ok(!readFileSync(join(extracted, name)).includes(sentinel), name);
  for (const name of ['start-console', 'start-mock', 'run-smoke']) {
    const sh = readFileSync(join(extracted, name + '.sh'), 'utf8'), cmd = readFileSync(join(extracted, name + '.cmd'), 'utf8');
    assert.match(sh, /^#!\/bin\/sh/); assert.match(sh, /\"\$@\"/); assert.match(cmd, /cd \/d "%~dp0"/); assert.match(cmd, /%\*/);
  }
  const result = run(process.execPath, [join(extracted, 'smoke.mjs')], foreign);
  assert.match(result, /"ok":true/); assert.match(result, /optional packed SDK/); assert.match(result, /official configured console/);
  assert.match(run(process.execPath, [join(extracted, 'custom-planner.mjs')], foreign), /"set-shields"/);
  // Exercise both real worker entry points from a standalone distribution.
  const setup=JSON.parse(readFileSync(join(root,'examples/fleet-lab.json'),'utf8')).initial;
  const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'packed-bot');
  const input=join(foreign,'bot-input.json');writeFileSync(input,JSON.stringify({o,routes:attackRoutes(o)}));
  const check=join(foreign,'check-bot.mjs');
  writeFileSync(check,`import {readFileSync} from 'node:fs';
const {computeBot}=await import(${JSON.stringify(pathToFileURL(join(extracted,'runtime/bot-worker.js')).href)});
const {o,routes}=JSON.parse(readFileSync(${JSON.stringify(input)},'utf8'));
const result=await computeBot(o,routes,{maxSimulations:12,maxElapsedMs:60000});
if(result.coverage.simulations>12||result.basisRevision!==o.revision)throw Error('Invalid packed bot result');
console.log('packed parallel bot completed');
`);
  assert.match(run(process.execPath,[check],foreign),/packed parallel bot completed/);

  const blocked = spawnSync(process.execPath, ['scripts/build-player-devkit.mjs', '--out', output], { cwd: root, encoding: 'utf8' }); assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /never overwritten/);
  const sentinelPath = join(temporary, 'existing'); mkdirSync(sentinelPath); writeFileSync(join(sentinelPath, 'player-work.txt'), 'do not overwrite');
  const rejected = spawnSync(process.execPath, ['scripts/build-player-devkit.mjs', '--out', sentinelPath], { cwd: root, encoding: 'utf8' }); assert.notEqual(rejected.status, 0); assert.equal(readFileSync(join(sentinelPath, 'player-work.txt'), 'utf8'), 'do not overwrite');
});

test('Player devkit without optional SDK retains a working Node-only direct-protocol mock, planner and configured console', { timeout: 120_000 }, t => {
  const temporary = mkdtempSync(join(tmpdir(), 'player-devkit-no-sdk-')), output = join(temporary, 'devkit'); t.after(() => rmSync(temporary, { recursive: true, force: true }));
  run(process.execPath, ['scripts/build-player-devkit.mjs', '--out', output, '--without-sdk', '--no-archive'], process.cwd());
  assert.equal(existsSync(join(output, 'sdk')), false); assert.equal(existsSync(output + '.zip'), false);
  const result = run(process.execPath, [join(output, 'smoke.mjs')], temporary); assert.match(result, /"ok":true/); assert.doesNotMatch(result, /PASS optional packed SDK/);
});


test('Player devkit dependency paths classify absolute, relative, scoped and nested node_modules and fail closed outside the repository', () => {
  const root = process.cwd(), script = readFileSync(join(root, 'scripts/build-player-devkit.mjs'), 'utf8');
  const start = script.indexOf('function dependencyPackage(input) {'), end = script.indexOf('const dependencyRoots = new Map();', start);
  assert.ok(start >= 0 && end > start);
  const classify = new Function('root', 'resolve', 'dirname', 'basename', 'relative', 'isAbsolute', script.slice(start, end) + ';return dependencyPackage;')(root, resolve, dirname, basename, relative, isAbsolute) as (input: string) => string | null;
  const external = resolve(root, '..', 'external-fixture');
  for (const packagePath of ['react', '@synthetic/notice', 'outer/node_modules/inner', '.pnpm/demo/node_modules/@synthetic/scoped']) {
    const expected = join(external, 'node_modules', packagePath);
    assert.equal(classify(join(expected, 'dist', 'index.js')), expected);
    assert.equal(classify(relative(root, join(expected, 'dist', 'index.js'))), expected);
  }
  assert.equal(classify('packages/contracts/src/protocol-index.ts'), null);
  assert.match(script, /sha\(readFileSync\(resolve\(root, path\)\)\)/);
  assert.equal(sha(readFileSync(resolve(root, resolve(root, 'packages/contracts/src/protocol-index.ts')))), sha(readFileSync(join(root, 'packages/contracts/src/protocol-index.ts'))));
  assert.throws(() => classify(join(external, 'unclassified', 'index.js')), /Unclassified external bundle input/);
});

test('Player devkit external dependency symlink preserves actual notices and refuses missing, empty or misidentified licenses', { timeout: 180_000 }, t => {
  const root = process.cwd(), temporary = mkdtempSync(join(tmpdir(), 'player-devkit-license-')), fixture = join(temporary, 'source'), dependencies = join(temporary, 'external', 'node_modules');
  t.after(() => rmSync(temporary, { recursive: true, force: true, maxRetries: 5 })); mkdirSync(fixture); mkdirSync(dependencies, { recursive: true });
  const copy = (source: string) => { const target = join(fixture, source); mkdirSync(dirname(target), { recursive: true }); cpSync(join(root, source), target, { recursive: true, filter: path => !/(?:^|[/\\])(?:node_modules|dist|__pycache__)(?:[/\\]|$)/.test(path) }); };
  for (const path of ['LICENSE', 'packages', 'protocol/player/v2', 'examples/player-clients', 'examples/player-devkit', 'examples/bot-plugins','examples/bot-release','plugins','tsconfig.json','package.json', 'docs/open-client', 'docs/rules/data/profile-diplomacy-core-v1.json', 'docs/development/player-devkit.md', 'scripts/build-player-devkit.mjs', 'scripts/build-player-sdk.mjs','scripts/build-bot-release.mjs','scripts/build-bot-sdk.mjs','scripts/archive-distribution.mjs']) copy(path);
  // Only test-owned copies are altered; never remove a notice from installed dependencies.
  for (const name of ['react', 'react-dom', 'scheduler', 'lucide-react', 'esbuild','typescript','undici-types']) cpSync(realpathSync(join(root, 'node_modules', name)), join(dependencies, name), { recursive: true });
  cpSync(realpathSync(join(root, 'node_modules', '@types')),join(dependencies,'@types'),{recursive:true});
  cpSync(realpathSync(join(root, 'node_modules', '@esbuild')), join(dependencies, '@esbuild'), { recursive: true });
  symlinkSync(dependencies, join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const output = join(temporary, 'packed'); run(process.execPath, ['scripts/build-player-devkit.mjs', '--out', output, '--without-sdk'], fixture);
  const manifest = JSON.parse(readFileSync(join(output, 'BUILD-MANIFEST.json'), 'utf8'));
  assert.deepEqual(manifest.thirdPartyLicenses.map((notice: {package: string}) => notice.package).sort(), ['lucide-react', 'react', 'react-dom', 'scheduler']);
  assert.ok(manifest.thirdPartyLicenses.every((notice: {packageRoot: string}) => notice.packageRoot.startsWith('../external/node_modules/')));
  for (const notice of manifest.thirdPartyLicenses) assert.deepEqual(readFileSync(join(output, notice.artifact)), readFileSync(resolve(fixture, notice.source)));
  const makeDependency = (directory: string, name: string, version: string, notice: string, code: string) => {
    mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'index.js' })); writeFileSync(join(directory, 'LICENSE'), notice); writeFileSync(join(directory, 'index.js'), code);
  };
  makeDependency(join(dependencies, 'synthetic-dual'), 'synthetic-dual', '1.0.0', 'Synthetic first-version notice', 'exports.value = 1;');
  makeDependency(join(dependencies, '@synthetic/notice/node_modules/synthetic-dual'), 'synthetic-dual', '2.0.0', 'Synthetic second-version notice', 'exports.value = 2;');
  makeDependency(join(dependencies, '@synthetic/notice'), '@synthetic/notice', '1.0.0', 'Synthetic scoped-package notice', "console.log(require('synthetic-dual').value);");
  const consoleEntry = join(fixture, 'packages/client/src/agent-console-main.tsx'), originalEntry = readFileSync(consoleEntry);
  writeFileSync(consoleEntry, "import {value} from 'synthetic-dual'; import '@synthetic/notice'; console.log(value);\n" + originalEntry.toString('utf8'));
  const nested = join(temporary, 'nested-packed'); run(process.execPath, ['scripts/build-player-devkit.mjs', '--out', nested, '--without-sdk'], fixture);
  const nestedManifest = JSON.parse(readFileSync(join(nested, 'BUILD-MANIFEST.json'), 'utf8')), versions = nestedManifest.thirdPartyLicenses.filter((notice: {package: string}) => notice.package === 'synthetic-dual');
  assert.equal(versions.length, 2); assert.equal(new Set(versions.map((notice: {artifact: string}) => notice.artifact)).size, 2);
  assert.deepEqual(versions.map((notice: {version: string}) => notice.version).sort(), ['1.0.0', '2.0.0']);
  for (const notice of nestedManifest.thirdPartyLicenses) assert.deepEqual(readFileSync(join(nested, notice.artifact)), readFileSync(resolve(fixture, notice.source)));
  writeFileSync(consoleEntry, originalEntry);
  const license = join(dependencies, 'react', 'LICENSE'), original = readFileSync(license), metadata = join(dependencies, 'react', 'package.json'), originalMetadata = readFileSync(metadata);
  const rejected = (name: string, error: RegExp) => {
    const destination = join(temporary, name), result = spawnSync(process.execPath, ['scripts/build-player-devkit.mjs', '--out', destination, '--without-sdk'], { cwd: fixture, encoding: 'utf8', timeout: 120_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, error); assert.equal(existsSync(destination + '.zip'), false);
  };
  rmSync(license); rejected('missing-notice', /Missing bundled dependency license: react/);
  writeFileSync(license, '   \n'); rejected('empty-notice', /Empty bundled dependency license: react/); writeFileSync(license, original);
  writeFileSync(metadata, JSON.stringify({ ...JSON.parse(originalMetadata.toString('utf8')), name: 'not-react' })); rejected('mismatched-name', /Bundled dependency package name mismatch: react/); writeFileSync(metadata, originalMetadata);
  writeFileSync(consoleEntry, "console.log('synthetic console with no third-party imports');\n"); rejected('unidentified-console-dependencies', /Console bundle has no identifiable third-party packages/);
});
