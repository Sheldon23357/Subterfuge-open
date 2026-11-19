import { createKnownPrediction,previewKnownDeployment } from '../../prediction/src/index.js';
import type { PredictionRequest, PredictionReply } from './prediction-protocol.js';

// This entry point is bundled separately and runs only in a module Worker.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<PredictionRequest>) => void;
  postMessage: (message: PredictionReply) => void;
};
let session: ReturnType<typeof createKnownPrediction> | undefined;
let generation = 0, activeId = 0;
const channel = new MessageChannel(), yields: (() => void)[] = [];
channel.port1.onmessage = () => yields.shift()?.();
const yieldToMessages = () => new Promise<void>(resolve => { yields.push(resolve); channel.port2.postMessage(0); });
scope.onmessage = event => {
  const request = event.data;
  if (request.kind === 'cancel') { if (request.id === activeId) generation++; return; }
  const job = ++generation;
  activeId = request.id;
  void (async () => {
    try {
      if(request.kind==='deploy'){const result=previewKnownDeployment(request.observation,request.draft);if(job===generation)scope.postMessage({id:request.id,deployment:{...result,roomId:request.observation.roomId,revision:request.observation.revision}});return;}
      if (request.observation) session = createKnownPrediction(request.observation);
      if (!session) throw Error('Missing player observation');
      session.begin(request.targetTick);
      while (job === generation && !session.step(request.targetTick))
        await yieldToMessages();
      if (job === generation) scope.postMessage({ id: request.id, response: session.result() });
    } catch (error) {
      if (job === generation) scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : 'Local prediction failed' });
    }
  })();
};
