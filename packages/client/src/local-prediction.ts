import type { PlayerObservation, PlayerForecastResponse } from '../../contracts/src/index.js';
import type { PredictionRequest, PredictionReply } from './prediction-protocol.js';
import type {LocalDeploymentResult} from './prediction-protocol.js';
import type {KnownPredictionDraft} from '../../prediction/src/index.js';

export interface PredictionWorker {
  onmessage: ((event: MessageEvent<PredictionReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: PredictionRequest): void;
  terminate(): void;
}

/** No forecast HTTP calls: only the current player observation crosses the
 * Worker boundary. A room/seat/revision switch terminates old computations. */
export class LocalPrediction {
  private worker: PredictionWorker | null = null;
  private context = '';
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: PlayerForecastResponse) => void; reject: (reason: Error) => void; cleanup: () => void }>();
  constructor(private createWorker: () => PredictionWorker = () => new Worker('/prediction-worker.js', { type: 'module' })) {}

  predict(observation: PlayerObservation, targetTick: number, signal?: AbortSignal): Promise<PlayerForecastResponse> {
    if (signal?.aborted) return Promise.reject(new DOMException('Prediction cancelled', 'AbortError'));
    const context = JSON.stringify([observation.roomId, observation.view.player, observation.revision, observation.secondsSinceLastTick]);
    let initialize = false;
    if (!this.worker || context !== this.context) {
      this.dispose();
      this.context = context;
      this.worker = this.createWorker();
      initialize = true;
      this.worker.onmessage = event => {
        const message = event.data, request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); request.cleanup();
        if ('error' in message) request.reject(Error(message.error));
        else if('deployment' in message)request.reject(Error('Unexpected prediction response'));
        else if (message.response.roomId !== observation.roomId || message.response.revision !== observation.revision ||
          message.response.status === 'conditional' && message.response.result.player !== observation.view.player)
          request.reject(Error('预测视角已更新'));
        else request.resolve(message.response);
      };
      this.worker.onerror = () => this.dispose(Error('本地推演加载失败，请刷新网页重试。'));
    }
    // A consumer keeps only its latest desired time. Do not leave a promise
    // pending when the Worker supersedes its previous job.
    for (const [oldId, request] of this.pending) {
      this.worker.postMessage({ kind: 'cancel', id: oldId });
      request.cleanup(); request.reject(new DOMException('Prediction superseded', 'AbortError'));
    }
    this.pending.clear();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', abort);
        this.worker?.postMessage({ kind: 'cancel', id });
        reject(new DOMException('Prediction cancelled', 'AbortError'));
      };
      this.pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.worker!.postMessage({ kind: 'predict', id, targetTick, ...(initialize ? { observation } : {}) }); }
      catch (error) { this.pending.delete(id); signal?.removeEventListener('abort', abort); reject(error); }
    });
  }
  dispose(reason: Error = new DOMException('Prediction context changed', 'AbortError')) {
    if (this.worker) { this.worker.onmessage = null; this.worker.onerror = null; this.worker.terminate(); }
    this.worker = null; this.context = '';
    for (const request of this.pending.values()) { request.cleanup(); request.reject(reason); }
    this.pending.clear();
  }
}

let shared: LocalPrediction | undefined;
export function localPlayerPreview(observation: PlayerObservation, targetTick: number, signal?: AbortSignal) {
  shared ??= new LocalPrediction();
  return shared.predict(observation, targetTick, signal);
}

/** Each draft owns an abortable worker; only the authorized observation crosses it. */
export function localPlayerDeploymentPreview(observation:PlayerObservation,draft:KnownPredictionDraft,signal?:AbortSignal):Promise<LocalDeploymentResult>{
 if(signal?.aborted)return Promise.reject(new DOMException('Prediction cancelled','AbortError'));
 return new Promise((resolve,reject)=>{
  const worker=new Worker('/prediction-worker.js',{type:'module'}),cleanup=()=>{signal?.removeEventListener('abort',abort);worker.terminate();},abort=()=>{cleanup();reject(new DOMException('Prediction cancelled','AbortError'));};
  worker.onmessage=(event:MessageEvent<PredictionReply>)=>{cleanup();const result=event.data;if('error'in result)reject(Error(result.error));else if('deployment'in result&&result.deployment.roomId===observation.roomId&&result.deployment.revision===observation.revision)resolve(result.deployment);else reject(Error('Prediction scope changed'));};
  worker.onerror=()=>{cleanup();reject(Error('本地部署推演加载失败。'));};signal?.addEventListener('abort',abort,{once:true});
  try{worker.postMessage({kind:'deploy',id:1,observation,draft} satisfies PredictionRequest);}catch(error){cleanup();reject(error);}
 });
}
