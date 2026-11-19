export type TickTimeSource = 'state-write' | 'automatic' | 'manual' | 'realtime' | 'startup' | 'database-trigger';
export interface TickTimeAnchor {
  id: number;
  revision: number;
  fromTick: number | null;
  tick: number;
  wallTimeMs: number;
  monotonicMs: number;
  sessionId: string;
  kind: 'observed' | 'advance' | 'batch';
  source: TickTimeSource;
}
export interface TickTimeInterval {
  tick: number;
  nextTick: number;
  startedAtMs: number;
  finishedAtMs: number;
  wallElapsedMs: number;
  monotonicElapsedMs: number | null;
  status: 'complete' | 'partial-start' | 'batch' | 'clock-adjusted';
}
/** Server-owned persistence boundaries. No workstation database or clock is required. */
export interface TickTimePage {
  roomId:string;
  headTick:number;
  ended:boolean;
  serverTimeMs:number;
  headElapsedMs:number|null;
  records:TickTimeAnchor[];
  nextCursor:number;
  hasMore:boolean;
}
/** Durations describe recorded persistence boundaries, including waiting and
 * downtime. They are never CPU timings or interpolated intermediate ticks. */
export function tickTimeIntervals(anchors: TickTimeAnchor[]): TickTimeInterval[] {
  return anchors.slice(1).map((end, index) => {
    const start = anchors[index]!;
    const wallElapsedMs = end.wallTimeMs - start.wallTimeMs;
    const monotonicElapsedMs = start.sessionId === end.sessionId ? end.monotonicMs - start.monotonicMs : null;
    const adjusted = wallElapsedMs < 0 || monotonicElapsedMs !== null &&
      (monotonicElapsedMs < 0 || Math.abs(wallElapsedMs - monotonicElapsedMs) > 1000);
    const status = adjusted ? 'clock-adjusted' : end.fromTick !== start.tick || end.tick !== start.tick + 1 || end.kind === 'batch' ? 'batch' : start.kind === 'observed' ? 'partial-start' : 'complete';
    return { tick: start.tick, nextTick: end.tick, startedAtMs: start.wallTimeMs, finishedAtMs: end.wallTimeMs, wallElapsedMs, monotonicElapsedMs, status };
  });
}
