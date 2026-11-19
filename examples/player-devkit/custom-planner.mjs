#!/usr/bin/env node
/**
 * A local, pure planner example, not a stable plugin ABI, a security sandbox,
 * a game-rules simulator, or the official AI's dynamically loaded strategy.
 *
 * Input is a COMPLETE, already verified, player-restricted snapshotDocument.
 * No transport, executor token, model key, engine or private database is passed
 * to the planner. Memory/model/scheduler choices belong to the caller, outside
 * the public wire contract. This file does not make network or model requests.
 */
import {readFileSync, realpathSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Return one local intent, or null; never mutate the snapshot or execute it. */
export function plan(snapshotDocument) {
  if (!object(snapshotDocument) || snapshotDocument.coverage?.observation !== 'complete') {
    throw new Error('Expected a complete player-restricted snapshotDocument, not a snapshot page or full-world export.');
  }
  const view = snapshotDocument.observation?.view;
  if (!object(view) || view.format !== 'player-observation/2'
    || !Number.isSafeInteger(view.player) || view.player < 0
    || !object(view.self) || !Array.isArray(view.outposts)) {
    throw new Error('Expected the supported player-observation/2 view and its verified player identity.');
  }
  if (view.self.active !== true) return null;

  // Deliberately trivial fixture exercise, NOT strategic advice. Unknown,
  // foreign, destroyed, non-factory and already-disabled records are skipped.
  // JavaScript length counts the UTF-16 units required by the action contract.
  const ownFactory = view.outposts.find(outpost => object(outpost)
    && outpost.owner === view.player
    && outpost.visibility === 2
    && outpost.type === 'factory'
    && outpost.destroyed === false
    && outpost.shieldsEnabled === true
    && typeof outpost.id === 'string'
    && outpost.id.length > 0 && outpost.id.length <= 128);
  if (!ownFactory) return null;

  // The transport layer, not the planner, binds fresh scope/revision,
  // instructions, session/fence and a durable logical key after explicit start.
  // The server remains the final authority on whether this action is legal.
  return {
    kind: 'order',
    payload: {
      action: {kind: 'set-shields', outpostId: ownFactory.id, enabled: false},
    },
  };
}

function readJson(path) {
  if (statSync(path).size > 8 * 1024 * 1024) throw new Error('Snapshot input exceeds the 8 MiB example limit.');
  // This is a LOCAL teaching input reader, not a strict public wire decoder.
  // A real transport must implement protocol/player/v2/README.md validation.
  return JSON.parse(readFileSync(path, 'utf8'));
}

function defaultSnapshot() {
  const relativePaths = [
    './protocol/player/v2/fixtures/wire-examples.json', // Extracted devkit.
    '../../protocol/player/v2/fixtures/wire-examples.json', // Source checkout.
  ];
  for (const relativePath of relativePaths) {
    const path = fileURLToPath(new URL(relativePath, import.meta.url));
    try { return readJson(path).snapshotDocument; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  throw new Error('Normative fixture not found. Keep the devkit directory intact or pass --snapshot PATH.');
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node custom-planner.mjs [--snapshot PATH]\n'
      + 'Reads a complete restricted snapshotDocument; prints one intent or null. Never sends it.\n'
      + 'Without --snapshot, uses the synthetic public wire fixture. No token or model is needed.\n');
    return;
  }
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--snapshot'
    && args[1] && !args[1].startsWith('--'))) {
    throw new Error('Usage: node custom-planner.mjs [--snapshot PATH]');
  }
  const snapshot = args.length ? readJson(resolve(args[1])) : defaultSnapshot();
  process.stdout.write(JSON.stringify(plan(snapshot), null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`Planner example: ${error instanceof Error ? error.message : 'Invalid local input'}\n`);
    process.exitCode = 1;
  }
}
