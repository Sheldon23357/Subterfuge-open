import { createLabHistory } from '../../prediction/src/index.js';
import type { HistoryRequest, HistoryReply } from './local-lab-history.js';
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<HistoryRequest>) => void;
  postMessage: (message: HistoryReply) => void;
};
let session: ReturnType<typeof createLabHistory> | undefined;
let generation = 0, activeId = 0;
const channel = new MessageChannel(), yields: (() => void)[] = [];
channel.port1.onmessage = () => yields.shift()?.();
const yieldToMessages = () => new Promise<void>(resolve => { yields.push(resolve); channel.port2.postMessage(0); });
scope.onmessage = ({ data }) => {
  if (data.kind === 'cancel') { if (data.id === activeId) generation++; return; }
  const job = ++generation;
  activeId = data.id;
  void (async () => {
    try {
      if (data.input) session = createLabHistory(data.input);
      if (!session) throw Error('缺少本局历史数据');
      session.begin(data.targetTick, data.player);
      let lastProgress = -1;
      while (job === generation && !session.step()) {
        const progress = session.progress();
        if (Math.floor(progress * 100) > lastProgress) {
          lastProgress = Math.floor(progress * 100);
          scope.postMessage({ id: data.id, progress });
        }
        await yieldToMessages();
      }
      if (job === generation) scope.postMessage({ id: data.id, frame: session.result() });
    } catch (error) {
      if (job === generation) scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : '历史局面读取失败' });
    }
  })();
};
