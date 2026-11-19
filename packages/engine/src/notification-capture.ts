import type {FleetScenario} from './fleet-scenario.js';
import {appendNotification,appendForecastNotification,capturesForecastNotifications,type GameplayNotification,type NotificationBattle} from './notification-journal.js';

const globalKinds=new Set(['game-ended','player-eliminated','player-resigned','mine-created','mine-captured']);
const kinds=new Set([...globalKinds,'departed','dormant-arrival','battle','funding-toggled','funding-expired','inactivity-warning']);
/** Record event-time recipients. Current sonar must never retroactively expose
 * a hidden battle when the notification archive is read later. */
export function captureRuleNotification(s:FleetScenario,kind:string,subject:string,details:Record<string,string|number|boolean|null>={},fraction=(s.secondsSinceLastTick??0)/600,_existing?:unknown,battle?:NotificationBattle){
 if(!kinds.has(kind)||s.forecastPlayer!==undefined&&!capturesForecastNotifications(s))return;
 const fleet=s.fleets.find(f=>f.id===subject),targetId=typeof details.target==='string'?details.target:typeof details.outpost==='string'?details.outpost:subject;
 const post=s.economy.outposts.find(o=>o.id===targetId),target=fleet?s.economy.outposts.find(o=>o.id===fleet.destination):post;
 const location:GameplayNotification['location']=post?{kind:'outpost',id:post.id,position:{...s.initial.positions[post.id]!}}:fleet?{kind:'fleet',id:fleet.id,position:{...fleet.position}}:null;
 const owner=fleet?.owner??post?.owner??Number(subject),team=s.economy.initial.teamSize;
 const allied=(a:number,b:number)=>team>0?Math.floor(a/team)===Math.floor(b/team):a===b;
 for(let player=0;player<s.economy.players.length;player++){
  if(s.forecastPlayer!==undefined&&player!==s.forecastPlayer)continue;
  if(kind!=='game-ended'&&!s.economy.players[player]!.active)continue;
  let authorized=globalKinds.has(kind)||owner===player||target?.owner===player;
  if(kind==='battle')authorized=battle?.attacker.player===player||battle?.defender.player===player;
  if(kind==='departed')authorized=!!fleet&&target?.owner===player&&!fleet.gift&&!allied(fleet.owner,player);
  if(kind==='dormant-arrival')authorized=owner===player;
  if(kind==='mine-created')authorized=post?.owner!==player;
  if(kind==='funding-toggled'||kind==='funding-expired')authorized=subject.split(':').map(Number).includes(player);
  if(kind==='inactivity-warning')authorized=Number(subject)===player;
  if(!authorized)continue;
  const winners=typeof details.player==='number'?(team>0&&typeof details.team==='number'?s.economy.players.flatMap((_,i)=>Math.floor(i/team)===details.team?[`P${i}`]:[]):[`P${details.player}`]):[];
  const text=kind==='battle'?`${subject}: ${battle?.outcome??details.winner}`:kind==='player-eliminated'?`P${subject} was eliminated.`:kind==='game-ended'?`Game over.${winners.length?` ${winners.join(' and ')} wins.`:''}`:kind==='inactivity-warning'?`You have been away from the game for ${Number(details.minutes)/60} hours.`:kind==='mine-created'?`Seismic activity detected in P${owner}'s territory. A new mine has been drilled!`:`${kind}: ${subject}`;
  const event:GameplayNotification={kind,tick:s.economy.tick+(kind==='departed'&&details.immediate===true?1:0),seconds:Math.round(fraction*600),text,details:null,urgent:kind==='battle'||kind==='departed'||kind==='player-eliminated',sendNotification:kind!=='funding-toggled',location,...battle?{battle:structuredClone(battle)}:{}};
  (s.forecastPlayer!==undefined?appendForecastNotification:appendNotification)(s,player,event);
 }
}
