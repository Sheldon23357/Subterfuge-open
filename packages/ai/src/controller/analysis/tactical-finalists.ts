import type {
  PlayerObservation,
  AttackRoutes,
} from "../../../../contracts/src/index.js";
import type { BotAssessment } from "./tactical-planner.js";
import { botOpponentScenarios } from "./tactical-opponents.js";

/** Ordinary utility can rank optional expansion ahead of a critical outpost
 * reinforcement. Keep one response to the existing concentrated-pressure
 * hypothesis in the bounded stress shortlist; only forecasts can accept it. */
export function botStressShortlist(
  o: PlayerObservation,
  routes: AttackRoutes,
  ranked: readonly BotAssessment[],
  horizon: number,
  preferredCombination?:BotAssessment,
): BotAssessment[] {
  const shortlist = preferredCombination
    ? [...new Set([...(ranked[0]?[ranked[0]]:[]),preferredCombination,...ranked])].slice(0,4)
    : ranked.slice(0, 4);
  const launches =
    botOpponentScenarios(o, routes, [], horizon).find(
      (s) => s.id === "counterattack",
    )?.enemyLaunches ?? [];
  if (
    launches.length !== 2 ||
    launches.some(
      (l) =>
        l.player !== launches[0]!.player ||
        l.destination !== launches[0]!.destination,
    )
  )
    return shortlist;
  const target = o.view.outposts.find(
    (p) => p.id === launches[0]!.destination && p.owner === o.view.player,
  );
  if(!target||(target.type!=='mine'&&o.view.outposts.filter(p=>p.owner===o.view.player&&!p.destroyed).length!==1))return shortlist;
  if (
    launches.reduce((n, l) => n + l.drillers, 0) <=
    (target.drillers ?? 0) + (target.shield ?? 0)
  )
    return shortlist;
  const defense = ranked.find(
    (a) =>
      a.candidate.kind === "defense" && a.candidate.targets.includes(target.id),
  );
  return defense
    ? [defense, ...shortlist.filter((a) => a !== defense)].slice(0, 4)
    : shortlist;
}
