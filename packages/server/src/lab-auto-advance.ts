import { randomUUID } from 'node:crypto';
import { SerialExecutor } from './player-access.js';

/** One service-owned clock; browser polling never drives or duplicates it. */
export class LabAutoAdvance {
  private runId: string | null = null;
  private pending = false;
  private error: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private serial: SerialExecutor, private advance: (runId: string) => Promise<void>, private onTiming?:(sample:{startedAt:number;durationMs:number;queueMs:number;executionMs:number})=>void) {}
  status() { return { enabled: this.runId !== null, error: this.error }; }
  setEnabled(enabled: boolean) {
    if (enabled && this.runId !== null) return;
    this.runId = enabled ? randomUUID() : null;
    this.error = null;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pulse(); }, 1000);
    this.timer.unref();
  }
  async pulse() {
    const runId = this.runId;
    if (!runId || this.pending) return;
    this.pending = true;
    const startedAt=Date.now();let enteredAt:number|undefined;let executionMs=0,executed=false;
    try {
      await this.serial.run(async () => {
        enteredAt=Date.now();
        if (this.runId === runId){executed=true;const executingAt=Date.now();try{await this.advance(runId);}finally{executionMs=Date.now()-executingAt;}}
      });
    } catch (error) {
      if (this.runId === runId) {
        this.runId = null;
        this.error = error instanceof Error ? error.message : '自动推进失败';
        console.error('Lab automatic advance failed:', this.error);
      }
    } finally { this.pending = false;if(executed&&enteredAt!==undefined)try{this.onTiming?.({startedAt,durationMs:Date.now()-startedAt,queueMs:enteredAt-startedAt,executionMs});}catch{} }
  }
  stop() { clearInterval(this.timer); this.timer = undefined; this.setEnabled(false); }
}
