import {
  advanceFleetScenario,
  submitFleetOrder,
  applyOriginalFutureQueue,
  fleetMatchOutcome,
  type FleetScenario,
  type FleetOrder,
} from "../../engine/src/index.js";
import type {
  ScheduledLaunch,
  MapInitialization,
  GameScenarioInfo,
} from "../../contracts/src/index.js";
export interface LabPredictionPlan extends FleetOrder {
  launchSlot?: number;
  failed?: boolean;
  issueTick: number;
  status: "pending" | "executed" | "failed" | "cancelled";
  reason?: string;
}
/** Private omniscient laboratory branch. Never used by player predictions. */
export interface LabPredictionRoom {
  state: FleetScenario;
  scheduled: ScheduledLaunch[];
  scheduledOrders?: LabPredictionPlan[];
  agendaOrder?: string[];
  map?: MapInitialization;
  scenario?: GameScenarioInfo;
}
export function launchIdentity(plan: {
  id: string;
  action: FleetOrder["action"];
}) {
  return plan.action.kind === "launch"
    ? (plan.action.fleetId ?? plan.id)
    : plan.id;
}
export function launchSlot(
  room: LabPredictionRoom,
  plan: { id: string; action: FleetOrder["action"]; launchSlot?: number },
) {
  const id = launchIdentity(plan);
  return (
    plan.launchSlot ??
    room.state.fleetReservations.find((r) => r.id === id)?.slot ??
    room.state.fleets.find((f) => f.id === id)?.slot ??
    -1
  );
}
/** Stable numeric slots are part of the original future-action identity, even
 * after a sub has sunk and its storage slot has subsequently been reused. */
export function futureQueueEntries(room: LabPredictionRoom) {
  const order = scheduleIds(room);
  return [...room.scheduled, ...(room.scheduledOrders ?? [])]
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    .map((plan) => ({
      plan,
      uid: plan.id,
      playerIndex: plan.player,
      scheduledTick: plan.issueTick,
      canceled: plan.status === "cancelled",
      failed: plan.failed ?? plan.status === "failed",
      type: plan.action.kind === "launch" ? 2 : 0,
      launchSubData:
        plan.action.kind === "launch"
          ? {
              srcOutpostIndex: plan.action.source,
              dstItemType: "outpost",
              dstItemIndex: plan.action.destination,
              subIndex: launchSlot(room, plan),
            }
          : null,
    }));
}
export function scheduleIds(room: LabPredictionRoom) {
  return (
    room.agendaOrder ?? [
      ...room.scheduled.map((p) => p.id),
      ...(room.scheduledOrders ?? []).map((p) => p.id),
    ]
  );
}
export function advanceLabBranch<T extends LabPredictionRoom>(
  room: T,
  target: number,
  simulatedFuture = false,
  policy?:{beforeScheduledOrder?:(room:T,order:FleetOrder)=>void;afterScheduledOrder?:(before:T,after:T,order:FleetOrder)=>Partial<T>|void},
): T {
  if (
    !Number.isInteger(target) ||
    target < room.state.economy.tick ||
    target > 1e7 ||
    target - room.state.economy.tick > 10000
  )
    throw Error("Invalid advance time");
  const next: T = {
    ...room,
    state: room.state,
    scheduled: structuredClone(room.scheduled),
    ...(room.scheduledOrders
      ? { scheduledOrders: structuredClone(room.scheduledOrders) }
      : {}),
  };
  const plans = [...next.scheduled, ...(next.scheduledOrders ?? [])];
  const order = scheduleIds(room);
  plans.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const due = [
    ...new Set(
      plans
        .filter((p) => p.status === "pending" && p.issueTick <= target)
        .map((p) => p.issueTick),
    ),
  ].sort((a, b) => a - b);
  for (const tick of due) {
    next.state = advanceFleetScenario(
      next.state,
      Math.max(next.state.economy.tick, tick),
      simulatedFuture,
    );
    const actions = futureQueueEntries(next);
    for (const entry of actions)
      if (entry.plan.status !== "pending") entry.canceled = true;
    applyOriginalFutureQueue(
      actions,
      tick,
      (entry: (typeof actions)[number]) => {
        const plan = entry.plan;
        try {
          if (fleetMatchOutcome(next.state)) throw Error("Game has ended");
          let action = plan.action;
          if (action.kind === "launch") {
            const slot = entry.launchSubData!.subIndex;
            const fleet = next.state.fleets.find(
              (f) => f.used && f.slot === slot,
            );
            const reservation = next.state.fleetReservations.find(
              (r) => r.slot === slot && r.player === plan.player,
            );
            if (!fleet && !reservation)
              throw Error("Scheduled launch reservation missing");
            const identity = fleet?.id ?? reservation!.id;
            action = {
              ...action,
              ...(action.fleetId !== undefined || identity !== plan.id
                ? { fleetId: identity }
                : {}),
            };
            if (
              "departureTick" in plan &&
              typeof plan.departureTick === "number"
            )
              action = {
                ...action,
                delaySeconds:
                  Math.round(
                    (plan.departureTick - next.state.economy.tick) * 600,
                  ) - (next.state.secondsSinceLastTick ?? 0),
              };
          }
          try{policy?.beforeScheduledOrder?.(next,{id:plan.id,player:plan.player,action});}catch(error){
            // A rejected application-policy write is not an original game failure.
            // Do not propagate its failure to earlier manual launch modifications.
            if((error as {code?:string}).code==='MANUAL_COMMAND_CONFLICT')entry.type=0;
            throw error;
          }
          const applied = submitFleetOrder(next.state, {
            id: plan.id,
            player: plan.player,
            action,
          }).state;
          try{const extra=policy?.afterScheduledOrder?.(next,{...next,state:applied},{id:plan.id,player:plan.player,action});if(extra)Object.assign(next,extra);}catch(error){if((error as {code?:string}).code==='MANUAL_COMMAND_CONFLICT')entry.type=0;throw error;}
          next.state=applied;
          plan.status = "executed";
          return true;
        } catch (e) {
          plan.status = "failed";
          plan.reason =
            e instanceof Error ? e.message : "Scheduled command failed";
          return false;
        }
      },
    );
    // tr also changes the failed flag of earlier matching launch modifications.
    for (const entry of actions) {
      if (entry.plan.status === "pending") {
        if (entry.failed) entry.plan.failed = true;
        else delete entry.plan.failed;
        continue;
      }
      if (entry.plan.status === "cancelled") continue;
      delete entry.plan.failed;
      entry.plan.status = entry.failed ? "failed" : "executed";
      if (entry.failed && !entry.plan.reason)
        entry.plan.reason = "A related launch modification failed";
      if (!entry.failed) delete entry.plan.reason;
    }
  }
  next.state = advanceFleetScenario(next.state, target, simulatedFuture);
  if (fleetMatchOutcome(next.state))
    for (const p of plans)
      if (p.status === "pending") {
        p.status = "failed";
        p.reason = "Game has ended";
      }
  return next;
}
export function* fleetCountdownSteps(
  room: LabPredictionRoom,
  seconds = room.state.secondsSinceLastTick ?? 0,
): Generator<
  void,
  Map<string, { departureMinutes: number; arrivalMinutes: number | null }>
> {
  const now = room.state.economy.tick,
    result = new Map<
      string,
      { departureMinutes: number; arrivalMinutes: number | null }
    >();
  const targets = new Map<string, string>();
  for (const f of room.state.fleets.filter((f) => f.used)) {
    targets.set(f.id, f.destination);
    result.set(f.id, {
      departureMinutes:
        f.state === "waiting"
          ? Math.max(0, (f.secondsUntilLaunch - Math.trunc(seconds)) / 60)
          : 0,
      arrivalMinutes: null,
    });
  }
  for(const plan of [...room.scheduled,...(room.scheduledOrders??[])])if(plan.status==='pending'&&plan.action.kind==='launch'&&!result.has(plan.id)){
    targets.set(plan.id,plan.action.destination);
    const departure='departureTick' in plan&&typeof plan.departureTick==='number'?plan.departureTick:plan.issueTick+(plan.action.delaySeconds??0)/600;
    result.set(plan.id,{departureMinutes:Math.max(0,(departure-now)*10-Math.trunc(seconds)/60),arrivalMinutes:null});
  }
  if (!result.size) return result;
  let projected = room;
  const end = Math.min(
    now + 288,
    Math.min(1e7, room.state.economy.tick + 10000),
  );
  for (let tick = now + 1; tick <= end; tick++) {
    const first = projected.state.events.length;
    projected = advanceLabBranch(projected, tick, true);
    for (const event of projected.state.events.slice(first)) {
      const r = result.get(event.subject);
      if (!r || r.arrivalMinutes !== null) continue;
      const destination = targets.get(event.subject);
      if (
        (event.kind === "unloaded" && event.details.outpost === destination) ||
        (event.kind === "battle" && event.details.target === destination)
      )
        r.arrivalMinutes = Math.max(
          0,
          (event.tick - now - 1 + event.fraction) * 10 -
            Math.trunc(seconds) / 60,
        );
    }
    yield;
    if (fleetMatchOutcome(projected.state)) break;
    if (
      [...result.entries()].every(
        ([id, r]) =>
          r.arrivalMinutes !== null ||
          !projected.state.fleets.some((f) => f.used && f.id === id)&&![...projected.scheduled,...(projected.scheduledOrders??[])].some(p=>p.id===id&&p.status==='pending'),
      )
    )
      break;
  }
  return result;
}

export function fleetCountdowns(
  room: LabPredictionRoom,
  seconds = room.state.secondsSinceLastTick ?? 0,
) {
  const steps = fleetCountdownSteps(room, seconds);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
