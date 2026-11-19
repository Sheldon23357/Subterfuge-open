import {exportFleetReplay,replayFleetScenario,type FleetScenario} from './fleet-scenario.js';
import {createActualSonarCollector,type ForecastSonarNotice} from './forecast-notifications.js';

const histories=new WeakMap<FleetScenario,ForecastSonarNotice[][]>();
/** Derived actual contacts, rebuilt from executed commands only. No pending
 * orders, current-visibility shortcut or forecast world can serve as evidence.
 * Cache a single all-seat replay for this immutable authoritative snapshot.
 */
export function projectHistoricalSonar(state:FleetScenario,player:number):ForecastSonarNotice[]{
 if(!Number.isInteger(player)||!state.economy.players[player])throw Error('Invalid sonar player');
 let history=histories.get(state);
 if(!history){
  const replay=exportFleetReplay(state);
  let collectors:ReturnType<typeof createActualSonarCollector>[]|undefined;
  replayFleetScenario(replay,{trustedLocalStorage:true},frame=>{
   if(!collectors)collectors=frame.economy.players.map((_,seat)=>createActualSonarCollector(frame,seat));
   else for(const collector of collectors)collector.sample(frame);
  });
  history=collectors!.map(c=>c.result());histories.set(state,history);
 }
 return structuredClone(history[player]!);
}
