import { worldMinutes } from "./time.js";

const fields: Record<string, string> = {
  source: "起点",
  destination: "目的地",
  drillers: "舰数",
  target: "目标",
  attackerOwner: "攻击方",
  defenderOwner: "防守方",
  attackerBefore: "进攻前舰数",
  defenderBefore: "防守前舰数",
  attackerAfter: "进攻剩余",
  defenderAfter: "防守剩余",
  winner: "胜方",
  outpost: "据点",
  owner: "所属席位",
  before: "之前",
  after: "之后",
  amount: "数量",
  enabled: "启用",
  pending: "等待生效",
  side: "作用方",
  captor: "俘获方",
  fleet: "潜艇",
  destinationKind: "目标类型",
};
const values: Record<string, string> = {
  attacker: "进攻方",
  defender: "防守方",
  none: "无",
  outpost: "据点",
  fleet: "潜艇",
};
export function eventDetails(
  json: string,
  locationName: (id: string) => string = (id) => id,
  kind?: string,
): string {
  try {
    return Object.entries(JSON.parse(json) as Record<string, unknown>)
      .map(
        ([key, value]) => {
          // Only this typed event defines minutes as an internal rule duration.
          // Other events, arbitrary text, and the stored JSON remain unchanged.
          if (
            kind === "inactivity-warning" && key === "minutes" &&
            typeof value === "number" && Number.isFinite(value) && value >= 0
          ) {
            return `不活跃时长：${worldMinutes(value)}`;
          }
          return `${fields[key] ?? key}：${value === null ? "无" : typeof value === "boolean" ? (value ? "是" : "否") : (values[String(value)] ?? (["source", "destination", "target", "outpost", "fleet"].includes(key) && typeof value === "string" ? locationName(value) : String(value).length > 25 ? String(value).slice(0, 8) : String(value)))}`;
        },
      )
      .join(" · ");
  } catch {
    return json;
  }
}
export function errorMessage(message: string): string {
  const translations: Record<string, string> = {
    "Outpost not owned by issuer": "只能从当前控制席位的据点发出指令。",
    "Invalid scenario horizon":
      "已到达此测试场景的时间范围上限，请导出存档并新建场景。",
    "Inactive or unknown player": "当前席位不可操作。",
  };
  return translations[message] ?? message;
}
