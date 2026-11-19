import {projectGlobalDiplomacy,fleetDiplomacyWorld,fleetMatchOutcome,type FleetScenario} from '../../engine/src/index.js';

/** Additional controls for the host's explicitly omniscient laboratory UI. */
export function labRuleView(s:FleetScenario,secondsSinceLastTick=s.secondsSinceLastTick??0){
  return {
    diplomacy:projectGlobalDiplomacy(s.diplomacy,fleetDiplomacyWorld(s)),
    ...(s.initial.match?{match:{...s.initial.match,teamSize:s.economy.initial.teamSize,ended:fleetMatchOutcome(s)!==null}}:{}),
  };
}
