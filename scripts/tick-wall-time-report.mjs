// Read-only audit of real wall-clock evidence. Does not advance or command a game.
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tickTimeIntervals } from '../dist/packages/server/src/tick-times.js';
import { RoomStore } from '../dist/packages/server/src/room-store.js';

const output = resolve(process.argv[2] ?? 'runtime/tick-wall-time-20261018');
await mkdir(output, { recursive: true });
const readStartedAt = Date.now();
const response = await fetch('http://127.0.0.1:4310/api/export', { signal: AbortSignal.timeout(20000), cache: 'no-store' });
if (!response.ok) throw Error(`Read export failed: HTTP ${response.status}`);
const room = await response.json(), readFinishedAt = Date.now();
const snapshot = JSON.parse(room.snapshot), head = snapshot.expected.economy.tick;
const start = snapshot.replay.initial.economy.initialTick;
const roomId = room.playerRoomId;
if (roomId !== 'd472a662-c383-4854-ba4b-35878bc49a64') throw Error('Room changed: verify chat source before reporting');
await writeFile(join(output, 'room-export.json'), JSON.stringify(room));
const tickAnchors=[];
let timingAvailable=true,cursor=0;
while(true){
  const timingResponse=await fetch(`http://127.0.0.1:4310/api/tick-times?after=${cursor}&limit=1000`,{signal:AbortSignal.timeout(20000),cache:'no-store'});
  if(timingResponse.status===404||timingResponse.status===405){
    // The live server can already be instrumented by transaction triggers
    // without a restart. Read that same store strictly read-only.
    const store=new RoomStore('runtime/subterfuge.sqlite',{readOnly:true});
    try{
      while(true){
        const page=store.tickTimes(cursor,1000);
        if(page.roomId!==roomId)throw Error('Room changed while reading tick times');
        tickAnchors.push(...page.records.filter(a=>a.tick<=head&&a.wallTimeMs<=readFinishedAt));
        if(!page.hasMore)break;cursor=page.nextCursor;
      }
    }finally{store.close();}
    break;
  }
  if(!timingResponse.ok)throw Error(`Read tick times failed: HTTP ${timingResponse.status}`);
  const page=await timingResponse.json();
  if(page.roomId!==roomId)throw Error('Room changed while reading tick times');
  tickAnchors.push(...page.records.filter(a=>a.tick<=head&&a.wallTimeMs<=readFinishedAt));
  if(!page.hasMore)break;
  if(page.nextCursor<=cursor)throw Error('Tick time cursor did not advance');
  cursor=page.nextCursor;
}
const chat = JSON.parse(await readFile('runtime/browser-eight-chat.json', 'utf8'));
const anchors = chat.messages.filter(m => m.tick >= start && m.tick <= head && m.sentAt <= readFinishedAt).map(m => ({
  tick: m.tick, earliestMs: m.sentAt, latestMs: m.sentAt, source: '聊天发送记录', id: m.id,
}));
anchors.push({ tick: head, earliestMs: readStartedAt, latestMs: readFinishedAt, source: '本次只读采样窗口', id: 'api/export' });
anchors.sort((a, b) => a.earliestMs - b.earliestMs);
for (let i = 1; i < anchors.length; i++) {
  if (anchors[i].tick < anchors[i - 1].tick) throw Error('Non-monotonic historical anchors: cannot infer time bounds');
}
// Entry boundary B(t) is bracketed by records below t and at/above t.
const boundaries = [];
for (let tick = start; tick <= head + 1; tick++) {
  const earlier = anchors.filter(a => a.tick < tick), later = anchors.filter(a => a.tick >= tick);
  const lower = earlier.length ? Math.max(...earlier.map(a => a.earliestMs)) : null;
  const upper = later.length ? Math.min(...later.map(a => a.latestMs)) : null;
  if (lower !== null && upper !== null && lower > upper) throw Error(`Inconsistent bounds at ${tick}`);
  boundaries[tick - start] = { lower, upper };
}
const rows = [];
const intervals=tickTimeIntervals(tickAnchors),intervalByTick=new Map(intervals.map(i=>[i.tick,i]));
for (let tick = start; tick <= head; tick++) {
  const current = boundaries[tick - start], next = boundaries[tick - start + 1];
  const own = anchors.filter(a => a.tick === tick);
  const minimumSeconds = current.upper !== null && next.lower !== null ? Math.max(0, next.lower - current.upper) / 1000 : null;
  const maximumSeconds = current.lower !== null && next.upper !== null ? (next.upper - current.lower) / 1000 : null;
  const recorded=intervalByTick.get(tick),complete=recorded?.status==='complete';
  rows.push({ tick, gameMinutes: tick * 10, exactSeconds: complete?recorded.wallElapsedMs/1000:null, minimumSeconds:complete?recorded.wallElapsedMs/1000:minimumSeconds, maximumSeconds:complete?recorded.wallElapsedMs/1000:maximumSeconds,
    entryEarliestMs: current.lower, entryLatestMs: current.upper,
    firstObservedMs: own.length ? Math.min(...own.map(a => a.latestMs)) : null,
    lastObservedMs: own.length ? Math.max(...own.map(a => a.earliestMs)) : null,
    records: own.length, recordedInterval:recorded??null,status: complete?'已记录完整提交边界':recorded?.status==='clock-adjusted'?'系统时钟调整，见单调时钟耗时':recorded?.status==='batch'?'批量跨度，未均摊':recorded?.status==='partial-start'?'接入首段，仅部分时长':tick === head ? '当前tick，尚未结束' : !own.length ? '无该tick时间锚点，无法细分' : '仅能确定范围' });
}

const db = new DatabaseSync('runtime/lab-ai.sqlite', { readOnly: true });
const journal = db.prepare("SELECT id,seat,kind,payload FROM journal WHERE room=? AND kind IN ('started','call-reserved','completed','paused','error') ORDER BY id").all(roomId);
db.close();
const active = new Map(), rounds = [];
for (const record of journal) {
  const p = JSON.parse(record.payload);
  if (record.kind === 'started') active.set(record.seat, { tick: p.tick, sequence: p.sequence, startId: record.id, startMs: null });
  else if (record.kind === 'call-reserved') {
    const round = active.get(record.seat);
    if (round && round.startMs === null && round.sequence === p.sequence && Number.isFinite(p.startedAt) && Number.isFinite(p.roundElapsedMs)) round.startMs = p.startedAt - p.roundElapsedMs;
  } else if (record.kind === 'completed') {
    const round = active.get(record.seat);
    if (round && Number.isFinite(p.durationMs) && round.tick >= start && round.tick <= head) {
      rounds.push({ ...round, seat: record.seat, durationMs: p.durationMs, endMs: round.startMs === null ? null : round.startMs + p.durationMs, endId: record.id });
    }
    active.delete(record.seat);
  } else active.delete(record.seat);
}
const top = rows.filter(r => r.minimumSeconds > 0).sort((a, b) => b.minimumSeconds - a.minimumSeconds).slice(0, 12);
const report = { roomId, start, head, readStartedAt, readFinishedAt,
  definition: 'tick t耗时指进入t至进入t+1之间的现实时间，包含AI等待、暂停和服务停机，不等于CPU计算时间。',
  method: '连续已记录的单tick提交边界给出完整现实间隔；接入前的历史仅由聊天与采样约束。批量不均摊；时钟跳变单独标注。下限0不代表瞬时完成。',
  sources: ['http://127.0.0.1:4310/api/export', 'http://127.0.0.1:4310/api/tick-times', 'runtime/browser-eight-chat.json (tick/sentAt only)', 'runtime/lab-ai.sqlite (readOnly; AI rounds only)'],
  timingAvailable,knownExactDurations: rows.filter(r=>r.exactSeconds!==null).length, anchoredTicks: new Set(anchors.map(a => a.tick)).size, anchorCount: anchors.length,
  rows, anchors, tickAnchors,intervals,rounds, top };
await writeFile(join(output, 'tick-wall-time.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, roomId, ticks: rows.length, head, timingAvailable,tickAnchors:tickAnchors.length,anchors: anchors.length, anchoredTicks: report.anchoredTicks, exactDurations: report.knownExactDurations, aiRounds: rounds.length, top }, null, 2));
