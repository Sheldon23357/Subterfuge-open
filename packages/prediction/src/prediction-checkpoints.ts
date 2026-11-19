/** Keep broad coverage without sacrificing the four most recently advanced
 * states: cancellation followed by a small back-drag still has a nearby base.
 * Map insertion order tracks use, whereas sorted ticks determine coverage. */
export function retainPredictionCheckpoint<T>(points: Map<number, T>, tick: number, value: T) {
  points.delete(tick);
  points.set(tick, value);
  if (points.size <= 12) return;
  const recent = new Set([...points.keys()].slice(-4));
  const ticks = [...points.keys()].sort((a, b) => a - b);
  let remove: number | undefined, smallestSpan = Infinity;
  for (let i = 1; i < ticks.length - 1; i++) {
    const candidate = ticks[i]!;
    if (recent.has(candidate)) continue;
    const span = ticks[i + 1]! - ticks[i - 1]!;
    if (span < smallestSpan) { remove = candidate; smallestSpan = span; }
  }
  if (remove !== undefined) points.delete(remove);
}
