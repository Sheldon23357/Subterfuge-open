import {
  createLabPrediction,
  type LabPredictionRoom,
} from "../../prediction/src/index.js";
import type {
  GlobalPredictionRequest,
  GlobalPredictionReply,
} from "./local-global-prediction.js";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<GlobalPredictionRequest>) => void;
  postMessage: (reply: GlobalPredictionReply) => void;
};
let input: Promise<LabPredictionRoom> | undefined;
let sourceKey = "";
let session: ReturnType<typeof createLabPrediction> | undefined;
let generation = 0,
  activeId = 0;
const channel = new MessageChannel(),
  yields: (() => void)[] = [];
channel.port1.onmessage = () => yields.shift()?.();
const yieldToMessages = () =>
  new Promise<void>((resolve) => {
    yields.push(resolve);
    channel.port2.postMessage(0);
  });
scope.onmessage = (event) => {
  const request = event.data;
  if (request.kind === "cancel") {
    if (request.id === activeId) generation++;
    return;
  }
  const job = ++generation;
  activeId = request.id;
  void (async () => {
    try {
      const key = JSON.stringify([request.source.roomId, request.source.revision, request.source.startTick]);
      if (sourceKey !== key) { sourceKey = key; input = undefined; session = undefined; }
      input ??= fetch(`/api/prediction-source?roomId=${encodeURIComponent(request.source.roomId)}&revision=${encodeURIComponent(request.source.revision)}`, { cache: "no-store" })
        .then(async response => {
          if (!response.ok) throw Error("对局已更新，正在等待最新视图。");
          const value = await response.json();
          if (value.roomId !== request.source.roomId || value.revision !== request.source.revision || value.room?.state?.economy?.tick !== request.source.startTick)
            throw Error("全局推演起点已更新");
          return value.room as LabPredictionRoom;
        })
        .catch(error => { if (sourceKey === key) input = undefined; throw error; });
      const source = await input;
      if (job !== generation) return;
      if (source.state.economy.tick !== request.source.startTick)
        throw Error("对局已更新，正在等待最新视图。");
      session ??= createLabPrediction(source, request.activity);
      session.begin(request.targetTick);
      while (job === generation && !session.step(request.targetTick))
        await yieldToMessages();
      if (job !== generation) return;
      const frames = session.result();
      let frame = frames.next();
      while (!frame.done && job === generation) {
        await yieldToMessages();
        if (job !== generation) return;
        frame = frames.next();
      }
      if (job === generation && frame.done)
        scope.postMessage({ id: request.id, frame: frame.value });
    } catch (error) {
      if (job === generation)
        scope.postMessage({
          id: request.id,
          error: error instanceof Error ? error.message : "全局推演失败",
        });
    }
  })();
};
