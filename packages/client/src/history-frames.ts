import { PreviewFrames } from './preview-frames.js';

/** Absolute history ticks, including tick zero. The underlying zero sentinel
 * remains reserved for NOW; room/seat changes dispose the entire instance. */
export class HistoryFrames<T> {
  private frames: PreviewFrames<T>;
  constructor(load: (tick: number, signal: AbortSignal) => Promise<T>, publish: (frame: T) => void,
    status: (loading: boolean, error: string) => void, delay = 16) {
    this.frames = new PreviewFrames((key, signal) => load(key - 1, signal), publish, status, delay, 32, true);
  }
  select(tick: number) { this.frames.select(tick + 1); }
  dispose() { this.frames.dispose(); }
}
