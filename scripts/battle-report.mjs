// Read-only observer reporting. Never invokes game commands or model runners.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fleetStandings, fleetPublicIntel, originalOutpostNames } from '../dist/packages/engine/src/index.js';
import { PLAYER_NAMES } from '../dist/packages/contracts/src/index.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = 'http://127.0.0.1:4310';
const get = async path => {
  const response = await fetch(`${base}/api/${path}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(`Report read ${path}: HTTP ${response.status}`);
  return response.json();
};
const readOptional = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshot = await get('export');
const state = JSON.parse(snapshot.snapshot).expected;
const capturedAt = new Date().toISOString();
const roomId = snapshot.playerRoomId ?? hash(state.initial);
const directory = join(root, 'runtime', 'battle-reports', hash(roomId).slice(0, 20));
await mkdir(directory, { recursive: true });
const previous = await readOptional(join(directory, 'latest.json'));
const continuous = previous && state.economy.tick >= previous.tick &&
  previous.commandHash === hash(state.commands.slice(0, previous.commandCount)) && state.events.length >= previous.eventCount;
const branch = continuous ? previous.branch : capturedAt.replace(/[^0-9]/g, '');
const names = originalOutpostNames(snapshot.map?.seed ?? 0, state.economy.outposts.length);
const nameById = Object.fromEntries(state.economy.outposts.map((post, i) => [post.id, names?.[i] ?? post.id]));
const intel = fleetPublicIntel(state);
const standings = fleetStandings(state);
const players = state.economy.players.map((player, seat) => {
  const stats = intel.find(p => p.player === seat);
  const owned = state.economy.outposts.filter(p => p.owner === seat && !p.destroyed);
  return { seat, name: PLAYER_NAMES[seat] ?? `席位${seat + 1}`, active: player.active,
    rank: standings.players.find(p => p.seat === seat).rank,
    neptunium: player.neptunium, mines: owned.filter(p => p.type === 'mine').length,
    outposts: owned.length, drillers: stats.drillers, capacity: stats.output,
    npPerDay: stats.npPerDay, drillerRate: stats.drillerRate,
    fleets: state.fleets.filter(f => f.used && f.owner === seat).length,
    delta: continuous ? Object.fromEntries(['neptunium', 'mines', 'outposts', 'drillers'].map(key =>
      [key, (key === 'outposts' ? owned.length : key === 'mines' ? owned.filter(p => p.type === 'mine').length : key === 'neptunium' ? player.neptunium : stats.drillers) - previous.players[seat][key]])) : null };
});
const keyKinds = new Set(['battle', 'outpost-captured', 'mine-created', 'player-eliminated', 'player-resigned', 'game-ended']);
const annotate = event => ({ ...event, locationName: nameById[event.details.target ?? event.subject] ?? null });
const periodEvents = continuous ? state.events.slice(previous.eventCount) : [];
const statusResults = await Promise.allSettled([get('ai'), get('state')]);
const ai = statusResults[0].status === 'fulfilled' ? statusResults[0].value : { unavailable: String(statusResults[0].reason) };
const service = statusResults[1].status === 'fulfilled' ? { tick: statusResults[1].value.tick, autoAdvance: statusResults[1].value.autoAdvance } : { unavailable: String(statusResults[1].reason) };
const chat = await readOptional(join(root, 'runtime', 'browser-eight-chat.json'));
const messages = chat?.messages?.filter(m => m.tick <= state.economy.tick) ?? [];
const newMessages = continuous ? messages.filter(m => m.sentAt > Date.parse(previous.capturedAt) && m.sentAt <= Date.parse(capturedAt)) : [];
const report = { format: 'battle-report/1', roomId, branch, capturedAt, tick: state.economy.tick,
  baseline: !continuous, resetReason: previous && !continuous ? 'Timeline changed; a new baseline was established.' : null,
  previousAt: continuous ? previous.capturedAt : null, previousTick: continuous ? previous.tick : null,
  gameHours: state.economy.tick / 6, commandCount: state.commands.length, commandHash: hash(state.commands), eventCount: state.events.length,
  goal: state.initial.match?.neptuniumGoal ?? null, mode: state.initial.match?.mode ?? 'mining', ended: standings.ended,
  winners: standings.winners, players, service, ai,
  eventCounts: Object.fromEntries([...new Set(periodEvents.map(e => e.kind))].map(kind => [kind, periodEvents.filter(e => e.kind === kind).length])),
  keyEvents: periodEvents.filter(e => keyKinds.has(e.kind)).map(annotate),
  latestHistoricalEvents: continuous ? [] : state.events.filter(e => keyKinds.has(e.kind)).slice(-12).map(annotate),
  diplomacyMessages: newMessages.map(m => ({ ...m, fromName: PLAYER_NAMES[m.from] })),
  map: { size: state.initial.size, outposts: state.economy.outposts.map(p => ({ id: p.id, name: nameById[p.id], owner: p.owner, type: p.type, position: state.initial.positions[p.id], destroyed: !!p.destroyed })) },
};
const stamp = capturedAt.replace(/[^0-9]/g, '');
const folder = join(directory, stamp);
await mkdir(folder, { recursive: true });
const index = await readOptional(join(directory, 'index.json')) ?? [];
const history = [];
for (const item of index.filter(item => item.branch === branch).slice(-23)) history.push(await readOptional(item.reportPath));
report.history = [...history.filter(Boolean).map(item => ({ capturedAt: item.capturedAt, tick: item.tick, players: item.players })), { capturedAt, tick: report.tick, players }];
await writeFile(join(folder, 'snapshot.json'), JSON.stringify(snapshot));
const reportPath = join(folder, 'report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2));
for (const [name, value] of [['latest.json', report], ['index.json', [...index, { branch, reportPath }]]]) {
  const temporary = join(directory, name + '.tmp');
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, join(directory, name));
}
console.log(JSON.stringify({ reportPath, chartPath: join(folder, 'overview.png'), mapPath: join(folder, 'map.png'), trendPath: report.history.length > 1 ? join(folder, 'trend.png') : null,
  plotScript: join(root, 'scripts', 'plot-battle-report.py'), tick: report.tick, baseline: report.baseline, players }, null, 2));
