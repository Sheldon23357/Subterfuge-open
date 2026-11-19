import {fleetMatchOutcome,type FleetScenario} from './fleet-scenario.js';
import {fleetVisibility} from './visibility.js';

export interface ForecastSonarNotice {
 kind:'sonar-contact';tick:number;minutesBeforeSending:number;fleetId:string;
 position:{x:number;y:number};multiple:boolean;sendNotification:boolean;generateAlert:boolean;
}
/** Pc's 72-tick standard-speed horizon. This collector accepts only isolated
 * forecast states; it cannot discover fleets removed at the knowledge boundary.
 */
export function createForecastSonarCollector(initial:FleetScenario,player:number,observedSeconds:number){
 return createSonarCollector(initial,player,observedSeconds,false);
}
/** Server-side actual history only; never a way to expand forecast knowledge. */
export function createActualSonarCollector(initial:FleetScenario,player:number){
 return createSonarCollector(initial,player,0,true);
}
function createSonarCollector(initial:FleetScenario,player:number,observedSeconds:number,actual:boolean){
 if(!Number.isInteger(player)||!initial.economy.players[player])throw Error('Invalid sonar player');
 const startTick=initial.economy.tick;
 let lastTick=startTick;
 function visibility(s:FleetScenario){
  if(actual){
   if(s.forecastPlayer!==undefined||s.forecastVictoryEnabled!==undefined)throw Error('Authoritative sonar history required');
  }else if(s.forecastPlayer!==player)throw Error('Restricted forecast perspective required');
  const visible=fleetVisibility(s,player).fleets;
  return new Map(s.fleets.filter(f=>f.used).map(f=>[f.slot,visible[f.id]??0]));
 }
 let previous=visibility(initial);
 const notices:ForecastSonarNotice[]=[];
 return {
  horizonTick:startTick+72,
  sample(s:FleetScenario){
   if(s.economy.tick!==lastTick+1||!actual&&s.economy.tick>startTick+72)throw Error('Forecast notification ticks must be consecutive');
   const current=visibility(s),fleets=s.fleets.filter(f=>f.used).sort((a,b)=>a.slot-b.slot);
   const contacts=fleets.filter(f=>f.owner!==player&&(previous.get(f.slot)??0)!==2&&current.get(f.slot)===2&&f.state!=='waiting');
   const f=contacts[0],multiple=contacts.length>1,minutesBeforeSending=forecastEventMinutes(startTick,observedSeconds,s.economy.tick);
   if(f&&(multiple||f.state==='moving'&&f.drillers>=10)&&minutesBeforeSending!==null&&(s.economy.players[player]!.active||fleetMatchOutcome(s)))
    notices.push({kind:'sonar-contact',tick:s.economy.tick,minutesBeforeSending,fleetId:f.id,position:{...f.position},multiple,sendNotification:true,generateAlert:false});
   // wn.compute writes only used slots; unused slots retain their last value.
   // Preserve that behavior if a later launch reuses the same numeric slot.
   for(const [slot,level] of current)previous.set(slot,level);
   lastTick=s.economy.tick;
  },
  result:()=>structuredClone(notices),
 };
}

export function forecastEventMinutes(startTick:number,observedSeconds:number,tick:number){
 const seconds=(tick-startTick)*600-observedSeconds;
 return seconds<0?null:Math.trunc(seconds/60)+1;
}
