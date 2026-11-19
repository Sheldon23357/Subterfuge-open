import type {FleetScenario} from './fleet-scenario.js';
import {captureRuleNotification} from './notification-capture.js';
import {ACTIVITY_RULES} from '../../rules/src/index.js';
import {retirePlayer,inactivityWarningCount,shouldAutoResign} from './lifecycle.js';
export interface PlayerActivity {lastCheckinTime:number;inactivityWarningCount:number;autoResigned:boolean}
function bridge(s:FleetScenario){
 if(!s.activity&&!s.forecastActivity)throw Error('Activity requires match lifecycle');
 if(s.forecastActivity&&s.forecastPlayer!==s.forecastActivity.player)throw Error('Invalid forecast activity');
 const seats=s.activity?.map(a=>({...a}))??[];
 if(s.forecastActivity)seats[s.forecastActivity.player]={...s.forecastActivity.value};
 // Sparse forecast seats remain unknown; no other player's last-seen time is invented.
 return {seats,seconds:s.economy.tick*600+(s.secondsSinceLastTick??0),
   resign:(i:number)=>{
     captureRuleNotification(s,'player-resigned',String(i));
     retirePlayer(s.economy.players,s.economy.funding,i,s.initial.match?.activityRules===ACTIVITY_RULES);seats[i]!.autoResigned=true;
     s.events.push({sequence:s.events.length,tick:s.economy.tick,fraction:0,kind:'player-resigned',subject:String(i),details:{owner:i,automatic:true}});return true;
   },
   listener:{handleInactivityWarning:(_n:unknown,i:number,minutes:number)=>{const details={owner:i,minutes,count:seats[i]!.inactivityWarningCount};s.events.push({sequence:s.events.length,tick:s.economy.tick,fraction:0,kind:'inactivity-warning',subject:String(i),details});captureRuleNotification(s,'inactivity-warning',String(i),details);}},
 };
}
function persist(s:FleetScenario,seats:PlayerActivity[]){
 const copy=(a:PlayerActivity)=>({lastCheckinTime:a.lastCheckinTime,inactivityWarningCount:a.inactivityWarningCount,autoResigned:a.autoResigned});
 if(s.forecastActivity)s.forecastActivity.value=copy(seats[s.forecastActivity.player]!);
 else s.activity=seats.map(copy);
}
export function tickInactivity(s:FleetScenario,simulatedFuture=false){
 if(!s.activity&&!s.forecastActivity)return;
 const n=bridge(s);
 for(let player=0;player<s.economy.players.length;player++){
  const a=n.seats[player];if(!a||!s.economy.players[player]!.active)continue;
  const minutes=s.economy.tick*10-a.lastCheckinTime/60;
  if(shouldAutoResign(s.economy.tick,a.lastCheckinTime,simulatedFuture,s.initial.match?.activityRules,s.initial.match?.realtimeTickMilliseconds)){n.resign(player);continue;}
  const count=inactivityWarningCount(Math.max(0,minutes));
  if(count>a.inactivityWarningCount){a.inactivityWarningCount=count;n.listener.handleInactivityWarning(n,player,minutes);}
  a.inactivityWarningCount=count;
 }
 persist(s,n.seats);
}
export function checkInPlayer(s:FleetScenario,player:number,cancelWarning:boolean){
 if(s.forecastActivity&&player!==s.forecastActivity.player)throw Error('Unknown forecast activity');
 const n=bridge(s),a=n.seats[player];if(!a)throw Error('Unknown forecast activity');
 if(cancelWarning)a.inactivityWarningCount=0;
 if(cancelWarning||s.economy.players[player]?.active)a.lastCheckinTime=n.seconds;
 persist(s,n.seats);
}

/** Only call after an order has passed validation and executed successfully. */
export function recordCommandActivity(s:FleetScenario,player:number,kind:string){
 if(!s.activity&&!s.forecastActivity||s.forecastActivity&&player!==s.forecastActivity.player||kind==='check-in'||kind==='cancel-inactivity-warning')return;
 checkInPlayer(s,player,true);
}

/** Replay commands retain the activity effect recorded when they were accepted. */
export function clearCommandWarning(s:FleetScenario,player:number,kind:string){
 if(!s.activity&&!s.forecastActivity||s.forecastActivity&&player!==s.forecastActivity.player||kind==='check-in')return;
 const n=bridge(s);n.seats[player]!.inactivityWarningCount=0;persist(s,n.seats);
}
