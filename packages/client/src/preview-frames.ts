/** One instance per room/seat/decision revision. Keep one request in flight,
 * coalesce pointer events, and reuse a bounded set of completed frames. */
export class PreviewFrames<T> {
  private frames = new Map<number, T>();
  private target = 0;
  private running = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller = new AbortController();

  constructor(
    private load: (ticks: number, signal: AbortSignal) => Promise<T>,
    private publish: (frame: T) => void,
    private status: (loading: boolean, error: string) => void,
    private delay = 16,
    private capacity = 32,
    private cancelSuperseded = false,
  ) {}

  select(ticks: number) {
    if (this.disposed) return;
    if (ticks !== this.target && this.running && this.cancelSuperseded) this.controller.abort();
    this.target = ticks;
    if (!ticks) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      this.status(false, "");
      return;
    }
    const cached = this.frames.get(ticks);
    if (cached !== undefined) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      this.frames.delete(ticks);
      this.frames.set(ticks, cached);
      this.publish(cached);
      this.status(false, "");
      return;
    }
    this.status(true, "");
    if (!this.running && this.timer === undefined) this.schedule();
  }

  private schedule() {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, this.delay);
  }

  private async run() {
    if (this.disposed || !this.target) return;
    const ticks = this.target;
    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const frame = await this.load(ticks, controller.signal);
      if (this.disposed || controller.signal.aborted) return;
      this.frames.set(ticks, frame);
      if (this.frames.size > this.capacity)
        this.frames.delete(this.frames.keys().next().value!);
      // An older request must not replace a newer cached selection or NOW.
      if (this.target && (this.target === ticks || !this.frames.has(this.target)))
        this.publish(frame);
      if (this.target === ticks) this.status(false, "");
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted && this.target === ticks)
        this.status(false, error instanceof Error ? error.message : "暂时无法推演");
    } finally {
      this.running = false;
      if (!this.disposed && this.target && (this.target !== ticks || controller.signal.aborted) && !this.frames.has(this.target))
        this.schedule();
    }
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.controller.abort();
    this.frames.clear();
  }
}
