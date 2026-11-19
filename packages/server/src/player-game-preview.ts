import {assertDispatchAllowed} from './dispatch-guard.js';
import {manualPredictionCoordination,coordinateHypotheticalManualOrder,assertManualCommandPriority,assertManualResourcesPreserved,type CommandSource} from './manual-commands.js';
import {
  prepareForecastKnowledge,
  buildForecastWorld,
  projectForecastResult,
  submitFleetOrder,
  type FleetOrder,
} from "../../engine/src/index.js";
import { advanceRoom, type LabRoom } from "./planning.js";
import { prepareForecastAgenda } from "./player-forecast.js";
import { samePreviewSource } from './room-preview-cache.js';
import {
  reserveScheduledLaunch,
  launchSlot,
  scheduleOrder,
  type ScheduledOrder,
} from "./scheduled-orders.js";

/** The full game renderer uses the same restricted knowledge as the v2 forecast query.
 * These queries never run the lab's omniscient deployment/arrival simulator. */
function prepare(room: LabRoom, player: number) {
  const knowledge = prepareForecastKnowledge(room.state, player),
    built = buildForecastWorld(knowledge);
  if (built.status === "unsupported") return built;
  let predicted: LabRoom = {
    state: built.state,
    scheduled: [],
    scheduledOrders: [],
    agendaOrder: [],
  };
  const coordination=manualPredictionCoordination(room,player,predicted);if(coordination)predicted.manualCoordination=coordination;
  for (const order of prepareForecastAgenda(room, player)) {
    try {
      const state = reserveScheduledLaunch(predicted, order, 0);
      const plan: ScheduledOrder = {
        ...structuredClone(order),
        status: "pending",
        ...(order.action.kind === "launch"
          ? { launchSlot: launchSlot({ ...predicted, state }, order) }
          : {}),
      };
      predicted = {
        ...predicted,
        state,
        scheduledOrders: [...predicted.scheduledOrders!, plan],
        agendaOrder: [...predicted.agendaOrder!, plan.id],
      };
    } catch {
      return {
        status: "unsupported" as const,
        reasons: ["known-schedule-reservation-unresolved"],
      };
    }
  }
  return { status: "conditional" as const, knowledge, predicted };
}
export function previewPlayerLaunch(
  room: LabRoom,
  player: number,
  order: FleetOrder,
  issueTick?: number,
  draftActor:CommandSource='manual',
) {
  if (order.player !== player || order.action.kind !== "launch")
    throw Error("Invalid deployment draft");
  assertDispatchAllowed(room,order);
  const prepared = prepare(room, player);
  if (prepared.status === "unsupported") return prepared;
  let future = prepared.predicted;
  if(draftActor==='agent')assertManualCommandPriority(future,order);
  const before=future;
  if(issueTick===undefined)future={...future,state:submitFleetOrder(future.state,order,room.state.secondsSinceLastTick??0).state};
  else future=scheduleOrder(future,{order,issueTick},0,{simulation:true});
  if(draftActor==='manual')future=coordinateHypotheticalManualOrder(before,future,order,issueTick===undefined?'order':'schedule');
  else if(issueTick===undefined)assertManualResourcesPreserved(before,future,player);
  const destination = order.action.destination;
  // Editing a waiting launch on the same route retains the original sub ID.
  const id =
    issueTick === undefined
      ? future.state.events.at(-1)!.subject
      : (order.action.fleetId ?? order.id);
  const end = Math.min(
    room.state.economy.tick + 1440,
    (issueTick ?? room.state.economy.tick) + 288,
  );
  for (let tick = room.state.economy.tick + 1; tick <= end; tick++) {
    const first = future.state.events.length,
      defender = future.state.economy.outposts.find(
        (o) => o.id === destination,
      )?.owner;
    future = advanceRoom(future, tick, true);
    if (
      future.scheduledOrders?.find((p) => p.id === order.id)?.status ===
      "failed"
    )
      throw Error("Deployment draft failed: "+(future.scheduledOrders?.find(p=>p.id===order.id)?.reason??"unknown"));
    const arrival = future.state.events
      .slice(first)
      .find(
        (e) =>
          e.subject === id &&
          ((e.kind === "unloaded" && e.details.outpost === destination) ||
            (e.kind === "battle" && e.details.target === destination) ||
            (e.kind === "future-unknown-arrival" &&
              e.details.outpost === destination)),
      );
    if (arrival) {
      const visible = projectForecastResult(
        prepared.knowledge,
        future.state,
      ).outposts.find((o) => o.id === destination);
      const target =
        visible &&
        "owner" in visible &&
        visible.owner !== undefined &&
        "drillers" in visible &&
        "shield" in visible
          ? {
              id: visible.id,
              owner: visible.owner,
              drillers: visible.drillers,
              shield: visible.shield,
            }
          : null;
      return {
        status: "conditional" as const,
        arrivalTick: tick,
        target,
        outcome: !target
          ? "unknown"
          : arrival.kind === "unloaded" && defender === player
            ? "reinforced"
            : target.owner === player
              ? "won"
              : "lost",
      };
    }
    if (
      tick >= (issueTick ?? room.state.economy.tick) &&
      !future.state.fleets.some((f) => f.id === id && f.used)
    )
      break;
  }
  return {
    status: "conditional" as const,
    arrivalTick: null,
    target: null,
    outcome: "unresolved",
  };
}

export function estimatePlayerArrivals(room: LabRoom, player: number) {
  const prepared = prepare(room, player);
  if (prepared.status === "unsupported") return prepared;
  const { knowledge } = prepared;
  const arrivals = knowledge.view.fleets.map((f) => ({
    id: f.id,
    arrivalTick: null as number | null,
    arrivalMinutes: null as number | null,
  }));
  if (!arrivals.length) return { status: "conditional" as const, arrivals };
  const pending = new Set(arrivals.map((f) => f.id));
  let future = prepared.predicted;
  for (
    let tick = room.state.economy.tick + 1;
    tick <= room.state.economy.tick + 288 && pending.size;
    tick++
  ) {
    const first = future.state.events.length;
    future = advanceRoom(future, tick, true);
    for (const e of future.state.events.slice(first)) {
      if (
        !pending.has(e.subject) ||
        !["unloaded", "battle", "future-unknown-arrival"].includes(e.kind)
      )
        continue;
      const target = knowledge.view.fleets.find(
        (f) => f.id === e.subject,
      )?.destination;
      if (!target || (e.details.outpost ?? e.details.target) !== target.id)
        continue;
      const row = arrivals.find((f) => f.id === e.subject)!;
      row.arrivalTick = tick;
      row.arrivalMinutes = Math.max(
        0,
        (tick - room.state.economy.tick - 1 + e.fraction) * 10 -
          knowledge.observedSeconds / 60,
      );
      pending.delete(e.subject);
    }
    for (const id of pending)
      if (!future.state.fleets.some((f) => f.id === id && f.used))
        pending.delete(id);
  }
  return { status: "conditional" as const, arrivals };
}

/** Polling the same frame must not rerun a 288-tick simulation. Keep the
 * private result scoped to its immutable world, agenda, player and phase. */
export function createPlayerArrivalsCache() {
  let source: LabRoom | undefined;
  const results = new Map<string, ReturnType<typeof estimatePlayerArrivals>>();
  return (room: LabRoom, player: number, seconds = room.state.secondsSinceLastTick ?? 0) => {
    if (!samePreviewSource(source, room)) {
      source = { ...room };
      results.clear();
    }
    const key = JSON.stringify([player, seconds]);
    let result = results.get(key);
    if (!result) {
      result = estimatePlayerArrivals({ ...room, state: { ...room.state, secondsSinceLastTick: seconds } }, player);
      results.set(key, result);
      if (results.size > 10) results.delete(results.keys().next().value!);
    }
    return result;
  };
}
