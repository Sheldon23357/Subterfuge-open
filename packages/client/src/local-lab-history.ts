import type { LabHistoryInput, LabHistoryFrame } from '../../prediction/src/index.js';

export type HistoryRequest = { kind: 'cancel'; id: number } | { kind: 'read'; id: number; targetTick: number; player: number; input?: LabHistoryInput };
export type HistoryReply = { id: number; frame: LabHistoryFrame } | { id: number; error: string } | { id: number; progress: number };

/** Admin browser only. Preserve the Worker and checkpoints between selections;
 * stale requests are cancelled without throwing away the historical index. */
export class LocalLabHistory {
  private input: Promise<LabHistoryInput> | undefined;
  private worker: Worker | undefined;
  private sequence = 0;
  private epoch = 0;
  private pending = new Map<number, { resolve: (frame: LabHistoryFrame) => void; reject: (error: Error) => void; cleanup: () => void; progress: (fraction: number) => void }>();
  constructor(private onBounds: (start: number) => void = () => {}) {}
  private load() {
    return this.input ??= fetch('/api/export', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw Error('无法读取本局历史');
      const room = await response.json(), snapshot = JSON.parse(room.snapshot);
      this.onBounds(snapshot.replay.initial.economy.initialTick);
      return { replay: snapshot.replay, ...(room.map ? { map: room.map } : {}) };
    }).catch(error => { this.input = undefined; throw error; });
  }
  async read(targetTick: number, player: number, signal?: AbortSignal, onProgress: (fraction: number) => void = () => {}): Promise<LabHistoryFrame> {
    let epoch = this.epoch;
    let input = await this.load();
    if (epoch !== this.epoch) throw new DOMException('History context changed', 'AbortError');
    if (targetTick > input.replay.targetTick) { this.dispose(); epoch = this.epoch; input = await this.load(); }
    if (epoch !== this.epoch) throw new DOMException('History context changed', 'AbortError');
    if (signal?.aborted) throw new DOMException('History cancelled', 'AbortError');
    let initialize = false;
    if (!this.worker) {
      this.worker = new Worker('/lab-history-worker.js', { type: 'module' });
      initialize = true;
      this.worker.onmessage = (event: MessageEvent<HistoryReply>) => {
        const message = event.data, request = this.pending.get(message.id);
        if (!request) return;
        if ('progress' in message) { request.progress(message.progress); return; }
        this.pending.delete(message.id); request.cleanup();
        if ('error' in message) request.reject(Error(message.error)); else request.resolve(message.frame);
      };
      this.worker.onerror = () => this.dispose(Error('历史回放加载失败，请刷新网页重试。'));
    }
    for (const [id, request] of this.pending) {
      this.worker.postMessage({ kind: 'cancel', id } satisfies HistoryRequest);
      request.cleanup(); request.reject(new DOMException('History superseded', 'AbortError'));
    }
    this.pending.clear();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => { this.pending.delete(id); signal?.removeEventListener('abort', abort); this.worker?.postMessage({ kind: 'cancel', id } satisfies HistoryRequest); reject(new DOMException('History cancelled', 'AbortError')); };
      this.pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort), progress: onProgress });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.worker!.postMessage({ kind: 'read', id, targetTick, player, ...(initialize ? { input } : {}) } satisfies HistoryRequest); }
      catch (error) { this.pending.delete(id); signal?.removeEventListener('abort', abort); reject(error); }
    });
  }
  dispose(reason: Error = new DOMException('History context changed', 'AbortError')) {
    this.epoch++; this.worker?.terminate(); this.worker = undefined; this.input = undefined;
    for (const request of this.pending.values()) { request.cleanup(); request.reject(reason); }
    this.pending.clear();
  }
}
