import {createHash} from 'node:crypto';
import {prepareForecastKnowledge} from '../../engine/src/index.js';
import {prepareForecastAgenda,simulatePlayerFuture} from './player-forecast.js';
import {observedRuleNotificationEntries,observedSonarNotificationEntries} from './notification-confirmation.js';
import {realtimeSeconds,tickMilliseconds} from './realtime.js';
import type {LabRoom} from './planning.js';
import type {NotificationScheduleStore} from './notification-schedule-store.js';
/** Call only inside the authority's serial executor, after clock catch-up.
 * Historical sonar confirmation uses executed replay, never current sight.
 */
export class NotificationRuntime{
 private revisions=new Map<string,string>();
 constructor(readonly store:NotificationScheduleStore){}
 refresh(roomId:string,room:LabRoom,now:number){
  if(!room.clock)return;
  for(let player=0;player<room.state.economy.players.length;player++){
   const key=roomId+':'+player;
   // Ignore mere passage of display seconds. State transitions, visible
   // runtime, public totals and known plans still invalidate the forecast.
   const revision=createHash('sha256').update(JSON.stringify({knowledge:prepareForecastKnowledge({...room.state,secondsSinceLastTick:0},player),agenda:prepareForecastAgenda(room,player)})).digest('hex');
   if(this.revisions.get(key)!==revision){
    const generation=this.store.generation(roomId,player);
    const current={...room,state:{...room.state,secondsSinceLastTick:realtimeSeconds(room,now)}};
    const forecast=simulatePlayerFuture(current,player,room.state.economy.tick+72);
    // Rebuild historical visibility only when an existing sonar prediction
    // has reached its event tick. One replay is shared by all seats.
    const sonarOccurred=this.store.needsSonarConfirmation(roomId,player,room.state.economy.tick)?observedSonarNotificationEntries(room.state,player):[];
    this.store.replace(roomId,player,generation,revision,now,
     forecast.status==='conditional'?forecast.notificationTimeline:[],
     [...observedRuleNotificationEntries(room.state,player),...sonarOccurred],tickMilliseconds(room));
    this.revisions.set(key,revision);
   }
   this.store.deliverDue(roomId,player,revision,now);
  }
 }
}
