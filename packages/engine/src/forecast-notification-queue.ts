import type {ForecastSonarNotice} from './forecast-notifications.js';
import type {GameplayNotification} from './notification-journal.js';
export type ForecastRuleNotice=GameplayNotification&{minutesBeforeSending:number};
export type ForecastNotificationEntry=
 |{sequence:number;source:'rule';notification:ForecastRuleNotice}
 |{sequence:number;source:'sonar';notification:ForecastSonarNotice};
/** Private-player equivalent of Pc.gameEvents. Hidden recipients must not
 * consume this queue or reveal their event count through its truncation.
 */
export function createForecastNotificationQueue(){
 const queue={count:0,capacity:1024,elements:[] as ForecastNotificationEntry[]};
 return {
  full:()=>queue.count===queue.capacity,
  rule(notification:ForecastRuleNotice){
   if(queue.count<queue.capacity)queue.elements[queue.count++]={sequence:queue.count-1,source:'rule',notification:structuredClone(notification)};
  },
  sonar(notification:ForecastSonarNotice){
   if(queue.count<queue.capacity)queue.elements[queue.count++]={sequence:queue.count-1,source:'sonar',notification:structuredClone(notification)};
  },
  result:()=>structuredClone(queue.elements.slice(0,queue.count)),
 };
}
