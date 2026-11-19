import {projectHistoricalSonar,projectPlayerNotifications,type FleetScenario,type ForecastNotificationEntry} from '../../engine/src/index.js';
/** Server-only evidence from event-time recipient filtering. Never accept this
 * list from a browser, an AI tool, or a hypothetical forecast branch.
 */
export function observedRuleNotificationEntries(state:FleetScenario,player:number):ForecastNotificationEntry[]{
 if(state.forecastPlayer!==undefined)throw Error('Confirmation requires authoritative events');
 return projectPlayerNotifications(state,player).map((notification,sequence)=>({
  source:'rule',sequence,notification:{...notification,minutesBeforeSending:1},
 }));
}
export function observedSonarNotificationEntries(state:FleetScenario,player:number):ForecastNotificationEntry[]{
 return projectHistoricalSonar(state,player).map((notification,sequence)=>({source:'sonar',sequence,notification}));
}
