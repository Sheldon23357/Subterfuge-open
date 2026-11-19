import {
  exportFleetReplay,
  replayFleetScenario,
  type FleetScenario,
} from "./fleet-scenario.js";
import {
  readNotifications,
  inheritNotifications,
} from "./notification-journal.js";
export function projectPlayerNotifications(s: FleetScenario, player: number) {
  if (
    !Number.isInteger(player) ||
    player < 0 ||
    player >= s.economy.players.length
  )
    throw Error("Invalid player");
  let result = readNotifications(s, player);
  if (result === null) {
    const replayed = replayFleetScenario(exportFleetReplay(s), {
      trustedLocalStorage: true,
    });
    inheritNotifications(replayed, s);
    result = readNotifications(s, player)!;
  }
  return result;
}
