import {
  generateOriginalMap,
  hasGameplayMapComposition,
  applyGameplayMapComposition,
  generateQuantityPriorityMap,
  createFleetScenario,
  submitFleetOrder,
  type GeneratedMap,
} from "../../engine/src/index.js";
import type { LabRoom } from "./planning.js";
import {ACTIVITY_RULES} from '../../rules/src/index.js';
import type { MapGenerationMode,MatchCreation } from "../../contracts/src/index.js";
import {applyEndgameScenario,chooseEndgameScenario,endgameOrders,endgameScenarioInfo,scenarioMessages,scenarioMemory,type EndgameScenarioId} from './endgame-scenarios.js';
export type StartMode='fresh'|'endgame';
export function matchCreation(players:number,input:unknown={}):MatchCreation{
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('无效对局规则');
  const raw=input as Record<string,unknown>;
  if(Object.keys(raw).some(k=>!['mode','teamSize','neptuniumGoal'].includes(k)))throw Error('未知对局规则');
  const mode=raw.mode??'mining',teamSize=raw.teamSize??0,neptuniumGoal=raw.neptuniumGoal??200;
  if(teamSize!==0)throw Error('当前版本不开放组队玩法');
  if(mode!=='mining'&&mode!=='domination'||!Number.isSafeInteger(neptuniumGoal)||Number(neptuniumGoal)<1||Number(neptuniumGoal)>100000)throw Error('无效对局规则');
  return {mode,teamSize:Number(teamSize),neptuniumGoal:Number(neptuniumGoal)};
}
export async function createGeneratedRoom(
  players = 8,
  seed = 4300,
  mode: MapGenerationMode = 'quantity-priority',
  rules:unknown={},
  startMode:StartMode='fresh',
): Promise<LabRoom> {
  if(mode!=='quantity-priority' && mode!=='original')throw Error('无效地图模式');
  if(startMode!=='fresh'&&startMode!=='endgame')throw Error('无效开局方式');
  const match=matchCreation(players,rules);
  const generate = mode==='original' ? generateOriginalMap : generateQuantityPriorityMap;
  const map = await generate(
    players,
    seed,
    () => new Promise((resolve) => setImmediate(resolve)),
    hasGameplayMapComposition,
    applyGameplayMapComposition,
  );
  const preset=startMode==='endgame'?chooseEndgameScenario(seed,players):undefined;
  return roomFromMap(map,match,preset?.id);
}
export function roomFromMap(map: GeneratedMap,input:unknown={},scenarioId?:EndgameScenarioId): LabRoom {
  const match=matchCreation(map.players,input);
  const id = (i: number) => `据点 ${String(i + 1).padStart(2, "0")}`;
  const setup = {
    match: {mode:match.mode,neptuniumGoal:match.neptuniumGoal,activityRules:ACTIVITY_RULES},
    size: { width: map.width, height: map.height },
    positions: Object.fromEntries(
      map.outposts.map((o, i) => [id(i), o.position]),
    ),
    economy: {
      initialTick: 0,
      teamSize: match.teamSize,
      players: Array.from({ length: map.players }, () => ({
        neptunium: 0,
        active: true,
        minesCreated: 0,
      })),
      outposts: map.outposts.map((o, i) => ({
        id: id(i),
        owner: o.owner < 0 ? null : o.owner,
        type: o.type === 1 ? ("factory" as const) : ("generator" as const),
        drillers: o.drillers,
        shield: o.shield,
        shieldMax: o.shieldMax,
        shieldsEnabled: true,
        productionProgress: o.productionProgress,
        miningProgress: 0,
        shieldProgress: 0,
        minePending: false,
        shieldDisablePending: false,
      })),
    },
  } as Parameters<typeof createFleetScenario>[0];
  const preset=scenarioId?chooseEndgameScenario(map.requestedSeed,map.players):undefined;
  if(preset&&preset.id!==scenarioId)throw Error('Scenario seed mismatch');
  if(preset)applyEndgameScenario(setup,match.mode,preset);
  let state = createFleetScenario(setup);
  if(preset)for(const order of endgameOrders(state,preset.id))state=submitFleetOrder(state,order).state;
  const scenarioInfo=preset?endgameScenarioInfo(preset.id):undefined;
  return {
    state,
    scheduled: [],
    map: {
      algorithm: map.algorithm,
      ...(map.composition?{composition:map.composition}:{}),
      ...('selection' in map ? {selection: structuredClone(map.selection)} : {}),
      players: map.players,
      requestedSeed: map.requestedSeed,
      seed: map.seed,
      score: map.score,
      startingOrigins: map.startingOutposts.map((q) => ({
        owner: q.owner,
        outpostId: id(q.outpost),
      })),
    },
    ...(scenarioInfo?{scenario:scenarioInfo}:{}),
  };
}
export {scenarioMessages,scenarioMemory};
