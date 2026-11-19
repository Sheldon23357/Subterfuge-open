import {exportFleetReplay,replayFleetScenario,type FleetScenario} from './fleet-scenario.js';
/** Whitelist source-confirmed announcements. Only mine notifications carry a public location. */
export function projectPlayerAnnouncements(s:FleetScenario,player:number){
 if(!Number.isInteger(player)||player<0||player>=s.economy.players.length)throw Error('Invalid player');
 const events=s.events.some(e=>e.kind==='mine-created'&&!Object.hasOwn(e,'audience'))?replayFleetScenario(exportFleetReplay(s),{trustedLocalStorage:true}).events:s.events;
 return events.filter(e=>e.kind==='mine-created'&&e.audience?.includes(player)).map(e=>{
  const time={tick:e.tick,seconds:Math.round(e.fraction*600),player:e.details.owner as number|null};
  return {kind:'mine-created' as const,...time,outpostId:e.subject};
 });
}
