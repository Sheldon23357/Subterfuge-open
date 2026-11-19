import {
  createFleetScenario,
  type FleetScenario,
} from "../../engine/src/index.js";
/** Symmetric 4×2 sectors on a torus: identical starting resources for eight seats. */
export function createEightPlayerScenario(): FleetScenario {
  const home = [
    "织女星",
    "白鲸",
    "天枢",
    "蓝湾",
    "金砂",
    "幽兰",
    "银翼",
    "翡翠",
  ];
  const generator = [
    "回声",
    "红礁",
    "熔岩",
    "寒泉",
    "余晖",
    "紫晶",
    "月井",
    "碧潮",
  ];
  const neutral = [
    "暮光",
    "静海",
    "长夜",
    "冰原",
    "沙洲",
    "雾港",
    "星屿",
    "翠谷",
  ];
  const positions: Record<string, { x: number; y: number }> = {};
  const outposts: Parameters<
    typeof createFleetScenario
  >[0]["economy"]["outposts"] = [];
  for (let seat = 0; seat < 8; seat++) {
    const x = -3 + (seat % 4) * 2,
      y = -1.5 + Math.floor(seat / 4) * 3;
    const points = [
      {
        id: home[seat]!,
        x: x - 0.35,
        y: y + 0.05,
        type: "factory" as const,
        owner: seat,
      },
      {
        id: generator[seat]!,
        x: x + 0.35,
        y: y + 0.65,
        type: "generator" as const,
        owner: seat,
      },
      {
        id: neutral[seat]!,
        x: x + 0.65,
        y: y - 0.8,
        type: "factory" as const,
        owner: null,
      },
      {
        id: `深井 ${seat + 1}`,
        x: x - 0.6,
        y: y - 0.9,
        type: "mine" as const,
        owner: null,
      },
    ];
    for (const p of points) {
      positions[p.id] = { x: p.x, y: p.y };
      outposts.push({
        id: p.id,
        owner: p.owner,
        type: p.type,
        drillers: p.owner === null ? 12 : 100,
        shield: 20,
        shieldMax: 20,
        shieldsEnabled: true,
        productionProgress: 0,
        miningProgress: 0,
        shieldProgress: 0,
        minePending: false,
        shieldDisablePending: false,
      });
    }
  }
  return createFleetScenario({
    size: { width: 8, height: 6 },
    positions,
    economy: {
      initialTick: 100,
      teamSize: 0,
      players: Array.from({ length: 8 }, () => ({
        neptunium: 40,
        active: true,
        minesCreated: 0,
      })),
      outposts,
    },
  });
}
