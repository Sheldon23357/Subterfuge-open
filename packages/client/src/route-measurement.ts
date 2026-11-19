type Point = {x: number; y: number};
type Estimate = {minutes: number | null; arrivalTick: number | null};
type Request = {
  source: string;
  point: Point;
  tick: number;
  estimate: (source: string, point: Point, tick: number, signal: AbortSignal) => Promise<Estimate>;
  result: (value: Estimate) => void;
  error: () => void;
};

/** Sample the latest pointer position without postponing work on every move. */
export class RouteMeasurement {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private pending: Request | null = null;
  private key = '';

  schedule(request: Request) {
    const key = JSON.stringify([request.source, request.point.x, request.point.y, request.tick]);
    if (key === this.key) return;
    this.key = key;
    this.controller?.abort();
    this.pending = request;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const latest = this.pending!;
      this.pending = null;
      const controller = new AbortController();
      this.controller = controller;
      void (async () => {
        try {
          const value = await latest.estimate(latest.source, latest.point, latest.tick, controller.signal);
          if (!controller.signal.aborted) latest.result(value);
        } catch {
          if (!controller.signal.aborted) {
            this.key = '';
            latest.error();
          }
        }
      })();
    }, 70);
  }

  cancel() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.pending = null;
    this.key = '';
  }
}
