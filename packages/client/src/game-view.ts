import type {
  LabView,
  OutpostMetrics,
  PlayerObservation,
  PlayerMapView,
  PlayerForecastResult,
  PlayerIntelStatistics,
  PlayerActivityEvent,
} from "../../contracts/src/index.js";
export type GameOutpost = Omit<LabView["outposts"][number], "metrics"> & {
  metrics: OutpostMetrics | null;
};
export type GameFleet = Omit<LabView["fleets"][number], "departureMinutes"> & {
  departureMinutes: number | null;
  arrivalTick?: number | null;
};
export function fleetArrivalOffset(
  fleet: GameFleet,
  tick: number,
  seconds = 0,
) {
  if (fleet.arrivalTick != null) return fleet.arrivalTick - tick;
  return fleet.arrivalMinutes === null
    ? null
    : Math.ceil(fleet.arrivalMinutes / 10 + seconds / 600);
}
/** Shared renderer input. Unseen bases remain separate geometry with absent
 * armies; ownership is public. They never become fabricated neutral/zero-strength units. */
export interface GameView
  extends Omit<LabView, "outposts" | "fleets" | "players"> {
  activity?:PlayerActivityEvent[];
  outposts: GameOutpost[];
  fleets: GameFleet[];
  players: {
    active: boolean;
    neptunium: number | null;
    minesCreated?: number;
  }[];
  perspective?: {
    observation?: PlayerObservation;
    arrivalObservation?:PlayerObservation;
    player: number;
    roomId: string;
    revision: string;
    historyStartTick: number;
    seconds: number;
    unseenOutposts: PlayerMapView["outposts"];
    outpostNames: Record<string,string>;
    sonar: PlayerMapView["sonar"];
    fullMapVisible: boolean;
    self: PlayerMapView["self"] | null;
    intel: PlayerIntelStatistics[];
    conditional: boolean;
    unknownArrivals: PlayerForecastResult["unknownArrivals"];
  };
}
export function playerGameView(
  observation: PlayerObservation,
  frame: PlayerMapView | PlayerForecastResult = observation.view,
  intel: PlayerIntelStatistics[] = observation.intel,
  seconds = observation.secondsSinceLastTick,
): GameView {
  const conditional = "certainty" in frame;
  const outposts: GameOutpost[] = frame.outposts.flatMap((o) =>
    o.visibility === 2 &&
    o.owner !== undefined &&
    o.drillers !== undefined &&
    o.shield !== undefined &&
    o.type
      ? [
          {
            id: o.id,
            name: observation.outpostNames?.[o.id] ?? o.id,
            owner: o.owner,
            type: o.type,
            drillers: o.drillers,
            shield: o.shield,
            shieldMax: o.shieldMax ?? o.shield,
            shieldsEnabled: o.shieldsEnabled ?? true,
            minePending: o.minePending ?? false,
            metrics: o.metrics ?? null,
            position: { ...o.position },
          },
        ]
      : [],
  );
  const visible = new Set(outposts.map((o) => o.id));
  return {
    tick: "targetTick" in frame ? frame.targetTick : frame.tick,
    size: { ...frame.size },
    realtime: observation.realtime,
    players: Array.from({ length: frame.playerCount }, (_, player) => ({
      active: conditional
        ? (player === frame.player ? frame.self.active : (intel.find((p) => p.player === player)?.active ?? true))
        : (intel.find((p) => p.player === player)?.active ?? true),
      neptunium: conditional
        ? (player === frame.player ? frame.self.neptunium : null)
        : (intel.find((p) => p.player === player)?.neptunium ?? null),
    })),
    funding: [],
    outposts,
    fleets: frame.fleets.map((f) => ({
      id: f.id,
      owner: f.owner,
      drillers: f.drillers,
      destination: f.destination?.id ?? "",
      position: { ...f.position },
      state: f.state,
      gift: f.gift,
      canCancelLaunch: f.canCancelLaunch ?? false,
      returned:f.returned??false,canReturn:f.canReturn??false,
      departureCommitted: f.departureCommitted ?? false,
      departureMinutes:
        f.launchRemainingSeconds === undefined
          ? null
          : f.launchRemainingSeconds / 60,
      arrivalMinutes: null,
    })),
    events: [],
    activity:observation.activity??[],
    ...(observation.battleLosses?{battleLosses:observation.battleLosses}:{}),
    ...(observation.diplomacy?{diplomacy:observation.diplomacy}:{}),
    scheduled: [],
    orders: observation.scheduled,
    ...("match" in frame && frame.match
      ? { match: { ...frame.match, ended: conditional ? !!frame.match.ended : frame.match.ended as boolean, teamSize: frame.teamSize } }
      : {}),
    perspective: {
      observation,
      ...(!conditional&&frame.tick!==observation.view.tick?{arrivalObservation:{...observation,view:frame as PlayerMapView,scheduled:[],secondsSinceLastTick:seconds,revision:`history:${observation.roomId}:${frame.tick}:${seconds}`}}:{}),
      player: frame.player,
      roomId: observation.roomId,
      revision: observation.revision,
      historyStartTick: observation.historyStartTick,
      seconds,
      outpostNames: {...observation.outpostNames},
      unseenOutposts: frame.outposts
        .filter((o) => !visible.has(o.id))
        .map((o) => ({ ...o, position: { ...o.position } })),
      sonar: frame.sonar.map((a) => ({
        center: { ...a.center },
        radius: a.radius,
      })),
      fullMapVisible: frame.fullMapVisible ?? false,
      self: "self" in frame ? frame.self : null,
      intel: conditional ? [] : intel,
      conditional,
      unknownArrivals: conditional ? frame.unknownArrivals : [],
    },
  };
}
