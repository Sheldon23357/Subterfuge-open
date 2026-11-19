import {previewKnownRoute} from '../../prediction/src/index.js';
import type { PlayerObservation } from "../../contracts/src/index.js";
import { PlayerConnection } from "./player-connection.js";
import { playerGameView } from "./game-view.js";
import { localPlayerPreview,localPlayerDeploymentPreview } from './local-prediction.js';

export interface GameOrder {
  id: string;
  player?: number;
  action: Record<string, unknown>;
}
/** The shared renderer includes its seat for lab commands. Authentication, not
 * that field, determines the player on every player request. */
export function playerGameCommand(
  now: PlayerObservation,
  path: string,
  input: unknown,
) {
  const data = input as {
    id?: string;
    order?: GameOrder;
    action?: Record<string, unknown>;
    issueTick?: number;
    departureTick?: number;
  };
  if (path === "cancel-schedule" && typeof data.id === "string")
    return { kind: "cancel" as const, id: data.id };
  if (!["order", "schedule-order", "schedule"].includes(path))
    throw Error("玩家入口不支持此操作。");
  const order = (path === "order" ? data : data.order) as GameOrder;
  if (!order || typeof order.id !== "string" || !order.action)
    throw Error("无效指令。");
  if (order.player !== undefined && order.player !== now.view.player)
    throw Error("只能操作当前舰队。");
  if(path==='schedule'||order.action.kind==='launch'&&(path!=='order'||data.issueTick!==undefined||data.departureTick!==undefined||order.action.delaySeconds!==undefined&&order.action.delaySeconds!==0))
    throw Error('出兵仅支持立即出发，不支持预约或延迟出兵。');
  const action = { ...order.action },
    issueTick = path === "schedule-order" ? data.issueTick : undefined;
  if (
    (path === "schedule-order" || issueTick !== undefined) &&
    (typeof issueTick !== "number" || !Number.isInteger(issueTick) ||
      issueTick <= now.view.tick ||
      issueTick > now.view.tick + 1440)
  )
    throw Error("请选择未来的预约时间。");
  return {
    kind: "order" as const,
    id: order.id,
    action,
    ...(issueTick === undefined ? {} : { issueTick }),
  };
}

/** Read-only draft adapter. Deliberately not a flag on the real command path. */
function deploymentPreviewCommand(now:PlayerObservation,data:{order?:GameOrder;departureTick?:number}) {
  const validated=playerGameCommand(now,'order',data.order);
  if(validated.kind!=='order'||validated.action.kind!=='launch')throw Error('无效部署。');
  const departure=data.departureTick;
  if(departure===undefined)return validated;
  if(typeof departure!=='number'||!Number.isFinite(departure)||departure>now.view.tick+144||departure<=now.view.tick+now.secondsSinceLastTick/600)
    throw Error('请选择有效的推演出发时间。');
  const issue=Math.floor(departure+1e-9);
  const issueTick=issue>now.view.tick?issue:undefined;
  const delaySeconds=Math.max(0,Math.round((departure-(issueTick??now.view.tick))*600-(issueTick===undefined?now.secondsSinceLastTick:0)));
  return {kind:'order' as const,id:validated.id,action:{...validated.action,delaySeconds},...(issueTick===undefined?{}:{issueTick})};
}

export async function playerGameQuery(
  connection: PlayerConnection,
  now: PlayerObservation,
  path: string,
  input: unknown,
  signal?: AbortSignal,
  predict = localPlayerPreview,
) {
  const data = input as {
    ticks?: number;
    source?: string;
    point?: { x: number; y: number };
    issueTick?: number;
    order?: GameOrder;
    departureTick?: number;
  };
  if (path === "preview") {
    const ticks = data.ticks;
    if (typeof ticks !== "number" || !Number.isInteger(ticks) || ticks === 0)
      throw Error("无效预览时间。");
    if (ticks < 0) {
      const past = await connection.history(now.view.tick + ticks, signal);
      if (past.roomId !== now.roomId) throw Error("对局已更新，请重新连接。");
      return playerGameView(
        now,
        past.view,
        past.intel,
        past.secondsSinceLastTick,
      );
    }
    const future = await predict(
      now,
      now.view.tick + ticks,
      signal,
    );
    checkScope(future, now);
    if (future.status === "unsupported") throw Error("这段未来暂无法推演。");
    return playerGameView(now, future.result, [], 0);
  }
  if (path === "route-preview") {
    signal?.throwIfAborted();
    const result=previewKnownRoute(now,{source:data.source!,point:data.point!,issueTick:data.issueTick!});
    checkScope(result, now);
    return result;
  }
  if (path === "deployment-preview") {
    const command = deploymentPreviewCommand(now, data);
    if (command.kind !== "order") throw Error("无效部署。");
    const result=await localPlayerDeploymentPreview(now,{id:command.id,issueTick:command.issueTick??now.view.tick,action:command.action},signal);
    checkScope(result, now);
    if (result.status === "unsupported") throw Error("暂无法推演这条航线。");
    return result;
  }
  throw Error("玩家入口不支持此查询。");
}
export function checkScope(
  result: { roomId: string; revision: string },
  now: PlayerObservation,
) {
  if (result.roomId !== now.roomId || result.revision !== now.revision)
    throw Error("局势已更新，请重试。");
}
