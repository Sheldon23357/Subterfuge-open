#!/usr/bin/env node
/** Opinionated safe launcher. Advanced raw CLI options are deliberately not passed through. */
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || major === 22 && minor < 13) throw Error('Install Node.js 22.13.0 or newer first');
const root = dirname(fileURLToPath(import.meta.url));
let config = join(root, 'config/offline-console.json'), provider = 'offline', port = '0';
const seen = new Set();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1];
  if (!['--config', '--provider', '--port'].includes(flag) || seen.has(flag) || !value || value.startsWith('--')) throw Error('Usage: node launch-console.mjs [--config PATH] [--provider offline|env] [--port 0..65535]');
  seen.add(flag);
  if (flag === '--config') config = resolve(value);
  if (flag === '--provider') provider = value;
  if (flag === '--port') port = value;
}
if (!['offline', 'env'].includes(provider) || !/^(0|[1-9][0-9]*)$/.test(port) || Number(port) > 65535) throw Error('Invalid provider or port');
const child = spawn(process.execPath, [join(root, 'runtime/agent-cli.mjs'), '--config', config, '--console', port, '--console-mode', 'configured', '--console-web-root', join(root, 'web'), '--provider', provider], { cwd: root, env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.on('error', () => { console.error('Unable to start the packaged runtime'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
