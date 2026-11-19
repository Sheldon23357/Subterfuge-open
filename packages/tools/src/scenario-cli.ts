import fs from 'node:fs';
import path from 'node:path';
import {replayEconomicScenario,restoreEconomicSnapshot,saveEconomicSnapshot,exportEconomicReplay,economicTotals,type EconomicScenario} from '../../engine/src/index.js';

function main(){
  const [mode,input]=process.argv.slice(2);
  if(!input||!['replay','restore'].includes(mode??''))throw new Error('Usage: scenario-cli <replay|restore> <JSON file>');
  const text=fs.readFileSync(path.resolve(input),'utf8');
  const state:EconomicScenario=mode==='replay'?replayEconomicScenario(JSON.parse(text)):restoreEconomicSnapshot(text);
  fs.mkdirSync('runtime',{recursive:true});
  const output=fs.mkdtempSync(path.resolve('runtime/economy-lab-'));
  fs.writeFileSync(path.join(output,'snapshot.json'),saveEconomicSnapshot(state));
  fs.writeFileSync(path.join(output,'replay.json'),JSON.stringify(exportEconomicReplay(state),null,2)+'\n');
  const summary={scope:'经济规则验证场景；不包含航行、胜负和联机',profile:state.profile,tick:state.tick,
    elapsedSeconds:(state.tick-state.initial.initialTick)*600,acceptedCommands:state.commands.length,eventCount:state.events.length,
    players:state.players.map((p,index)=>({index,...p,...economicTotals(state)[index]})),outposts:state.outposts};
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  const csv=(value:unknown)=>'"'+String(value).replaceAll('"','""')+'"';
  fs.writeFileSync(path.join(output,'events.csv'),'\uFEFFsequence,tick,kind,subject,amount\n'+state.events.map(e=>[e.sequence,e.tick,e.kind,e.subject,e.amount].map(csv).join(',')).join('\n')+'\n');
  console.log(`经济场景运行完成：tick ${state.tick}，${state.commands.length} 条命令，${state.events.length} 条事件。`);
  console.log(`结果目录：${output}`);
  console.log('已输出 summary.json、snapshot.json、replay.json、events.csv。');
}
try{main();}catch(error){console.error(error instanceof Error?error.message:'Scenario failed');process.exitCode=1;}
