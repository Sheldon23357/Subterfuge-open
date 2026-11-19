import type {PlayerActivityEvent} from '../../contracts/src/index.js';
import {playerNames} from './theme.js';

const titles:Record<string,string>={
  'launch-ordered':'出兵指令','launch-cancelled':'取消舰队',departed:'舰队出发',
  'fleet-recalled':'舰队返航',
  battle:'发生冲突','outpost-captured':'占领据点','mine-ordered':'修建矿场','mine-cancelled':'取消修建矿场','mine-created':'矿场建成',
  'shield-order':'护盾调整','shield-disabled':'护盾已暂停',
};
const side=(player:number|null)=>player===null?'中立':playerNames[player]??`玩家 ${player+1}`;
export function activityText(event:PlayerActivityEvent,name:(id:string)=>string){
  const title=event.kind==='shield-order'?(event.enabled?'恢复护盾':'暂停护盾'):titles[event.kind]??'海域事件';
  if(event.kind==='battle'){
    const location=event.destination?event.destination.kind==='fleet'?'舰队交战':name(event.destination.id):name(event.subject);
    return `${title} · ${location} · ${event.battle?`${side(event.battle.attacker.player)}损失 ${event.battle.attacker.loss} 兵力 · ${side(event.battle.defender.player)}损失 ${event.battle.defender.loss} 兵力`:'双方战损未知'}`;
  }
  if(event.transfer)return `${event.transfer.reason==='gift'?'舰队已实际赠送':'舰队已被俘获'} · ${side(event.transfer.from)} → ${side(event.transfer.to)} · ${event.drillers??'未知'} 兵力`;
  if(event.kind==='fleet-recalled')return `舰队返航 · 剩余 ${event.drillers??'未知'} 兵力`;
  if(event.termination)return event.termination.outcome==='recovered'?`舰队已回收 · ${event.termination.outpost?name(event.termination.outpost):'回收据点未知'} · 回收 ${event.termination.drillers} 兵力`:`舰队已移除 · 移除时 ${event.termination.drillers} 兵力`;
  if(event.arrival)return `舰队已抵达 · ${name(event.arrival.outpost)} · ${event.arrival.outcome==='delivered'?`已交付 ${event.arrival.drillers??'未知'} 兵力`:'进攻被击败'}`;
  if(event.drillers!==null){
    return `${title} · ${event.drillers} 兵力${event.source?` · ${name(event.source)}`:''}${event.destination?` → ${event.destination.kind==='fleet'?'舰队':name(event.destination.id)}`:''}`;
  }
  return `${title} · ${name(event.subject)}`;
}
