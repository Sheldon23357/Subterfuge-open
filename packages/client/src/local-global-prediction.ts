import type { LabView } from "../../contracts/src/index.js";

import { globalPredictionKey, type GlobalPredictionSource } from './prediction-source.js';

export type GlobalPredictionRequest =
  | { kind: "cancel"; id: number }
  | { kind: "predict"; id: number; targetTick: number; source: GlobalPredictionSource; activity?: LabView["activity"] };
export type GlobalPredictionReply =
  | { id: number; frame: LabView }
  | { id: number; error: string };

export interface GlobalPredictionWorker {
  onmessage: ((event: MessageEvent<GlobalPredictionReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: GlobalPredictionRequest): void;
  terminate(): void;
}

/** One private worker per laboratory revision. No full world enters player workers. */
export class LocalGlobalPrediction {
  private worker: GlobalPredictionWorker | undefined;
  private sourceKey = "";
  constructor(private createWorker: () => GlobalPredictionWorker = () => new Worker("/global-prediction-worker.js", {type: "module"})) {}
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (frame: LabView) => void;
      reject: (error: Error) => void;
      cleanup: () => void;
    }
  >();
  predict(
    targetTick: number,
    source: GlobalPredictionSource,
    signal?: AbortSignal,
    activity?: LabView["activity"],
  ): Promise<LabView> {
    if (signal?.aborted)
      return Promise.reject(
        new DOMException("Prediction cancelled", "AbortError"),
      );
    const key = globalPredictionKey(source);
    if (this.sourceKey !== key) { this.dispose(); this.sourceKey = key; }
    if (!this.worker) {
      const worker = this.worker = this.createWorker();
      this.worker.onmessage = (event: MessageEvent<GlobalPredictionReply>) => {
        if (this.worker !== worker) return;
        const reply = event.data,
          request = this.pending.get(reply.id);
        if (!request) return;
        this.pending.delete(reply.id);
        request.cleanup();
        if ("error" in reply) request.reject(Error(reply.error));
        else request.resolve(reply.frame);
      };
      this.worker.onerror = () => {
        if (this.worker === worker) this.dispose(Error("全局推演加载失败，请刷新网页重试。"));
      };
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        this.worker?.postMessage({ kind: "cancel", id });
        reject(new DOMException("Prediction cancelled", "AbortError"));
      };
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.worker!.postMessage({ kind: "predict", id, targetTick, source, ...(activity ? {activity} : {}) }); }
      catch (error) { this.pending.delete(id); signal?.removeEventListener("abort", abort); reject(error); }
    });
  }
  dispose(
    reason: Error = new DOMException(
      "Prediction context changed",
      "AbortError",
    ),
  ) {
    this.worker?.terminate();
    this.worker = undefined;
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(reason);
    }
    this.pending.clear();
  }
}
