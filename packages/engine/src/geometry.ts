import { nonnegative } from './numeric.js';
export interface Point { x: number; y: number }
export interface WorldSize { width: number; height: number }
function wrappedDelta(from: number, to: number, extent: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(extent) || extent <= 0) throw new RangeError('Invalid world geometry');
  const raw = to - from;
  const delta = ((raw % extent) + extent) % extent;
  // Antipodal tie uses original direction; pending reference geometry verification.
  return delta > extent / 2 ? delta - extent : delta === extent / 2 && raw < 0 ? -delta : delta;
}
export function torusDelta(from: Point, to: Point, size: WorldSize): Point {
  return { x: wrappedDelta(from.x, to.x, size.width), y: wrappedDelta(from.y, to.y, size.height) };
}
export function torusDistance(from: Point, to: Point, size: WorldSize): number {
  const d = torusDelta(from, to, size); return Math.hypot(d.x, d.y);
}
export function insideSonar(center: Point, target: Point, range: number, size: WorldSize): boolean {
  nonnegative(range, 'range'); return torusDistance(center, target, size) <= range;
}
