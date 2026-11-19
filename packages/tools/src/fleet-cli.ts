import fs from 'node:fs';
import path from 'node:path';
import {replayFleetScenario,restoreFleetSnapshot,saveFleetSnapshot,exportFleetReplay,fleetScenarioTotals,type FleetEvent} from '../../engine/src/index.js';

function describe(e:FleetEvent):string{
  const d=e.details;
  switch(e.kind){
    case 'drillers-produced':return `${e.subject} 生产 ${d.amount} 钻机`;
    case 'neptunium-produced':return `${e.subject} 采集 ${d.amount} 矿`;
    case 'launch-ordered':return `${e.subject} 备航：${d.source} → ${d.destination}，${d.drillers} 钻机`;
    case 'departed':return `${e.subject} 发射，${d.drillers} 钻机`;
    case 'battle':return `${e.subject} 对 ${d.target}：${d.attackerBefore} 对 ${d.defenderBefore} + 护盾 ${d.shieldBefore}；${d.winner==='attacker'?'攻方胜':d.winner==='defender'?'守方胜':'平局'}，剩余 ${d.attacker} / ${d.defender}，护盾 ${d.shield}`;
    case 'outpost-captured':return `${e.subject} 归玩家 ${d.owner} 所有（原所有者 ${d.before??'中立'}）`;
    case 'mine-loss':return `玩家 ${d.owner} 丢失 ${e.subject}，矿 ${d.before} → ${d.after}`;
    case 'unloaded':return `${e.subject} 在 ${d.outpost} 卸载 ${d.drillers} 钻机`;
    case 'fleet-removed':return `${e.subject} 空艇清理`;
    case 'fleet-returned':return `${e.subject} 返航 ${d.destination}`;
    case 'fleet-recalled':return `${e.subject} 返航，剩余 ${d.drillers} 钻机，损失 ${d.lost} 钻机`;
    default:return `${e.kind} ${e.subject} ${JSON.stringify(d)}`;
  }
}
function main(){
  const [mode,input]=process.argv.slice(2);
  if(!input||!['replay','restore'].includes(mode??''))throw new Error('Usage: fleet-cli <replay|restore> <JSON file>');
  const text=fs.readFileSync(path.resolve(input),'utf8');
  const state=mode==='replay'?replayFleetScenario(JSON.parse(text)):restoreFleetSnapshot(text);
  fs.mkdirSync('runtime',{recursive:true});const output=fs.mkdtempSync(path.resolve('runtime/fleet-lab-'));
  const summary={scope:'普通舰队场景：本地规则结算与存档重演',profile:state.profile,tick:state.economy.tick,
    acceptedCommands:state.commands.length,eventCount:state.events.length,players:state.economy.players.map((p,i)=>({index:i,...p,...fleetScenarioTotals(state)[i]})),
    outposts:state.economy.outposts,fleets:state.fleets.filter(f=>f.used)};
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  fs.writeFileSync(path.join(output,'snapshot.json'),saveFleetSnapshot(state));
  fs.writeFileSync(path.join(output,'replay.json'),JSON.stringify(exportFleetReplay(state),null,2)+'\n');
  fs.writeFileSync(path.join(output,'events.json'),JSON.stringify(state.events,null,2)+'\n');
  fs.writeFileSync(path.join(output,'battle-report.txt'),'普通舰队场景战报\n'+state.events.map(e=>`[${e.sequence}] tick ${e.tick} + ${e.fraction.toFixed(6)}  ${describe(e)}`).join('\n')+'\n');
  console.log(`舰队场景完成：tick ${state.economy.tick}，${state.commands.length} 条命令，${state.events.length} 条事件。`);
  console.log(`输出：${output}`);
  for(const e of state.events)if(['battle','outpost-captured','mine-loss'].includes(e.kind))console.log(describe(e));
}
try{main();}catch(e){console.error(e instanceof Error?e.message:'Fleet scenario failed');process.exitCode=1;}
