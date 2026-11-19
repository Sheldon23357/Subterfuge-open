import {ruleSecondsToWorldDays,ruleMinutesToWorldDays,legacyDailyRateToWorldDailyRate,ruleNotificationWorldTime} from '../../../../contracts/src/index.js';
/** Model-only projection. Never write derived fields into observations, commands,
 * archives or snapshots. Names are an explicit protocol allowlist: arbitrary
 * seconds, timestamps and notification delivery delays are deliberately absent. */
const minuteFields = ['cycleMinutes','nextMinutes','departureMinutes','arrivalMinutes','courseCooldownMinutes'];
const secondFields = ['secondsUntilLaunch','launchRemainingSeconds','giftPendingSeconds','secondsUntilCommitted','observedSeconds','atSeconds','expiresAt','reviewAt','lastCheckinTime','firstSeconds','lastSeconds'];

/** Exact engine templates only, and only in known notification containers. */
export function projectRuleNotification(value:unknown,verifiedRuleSource=true):unknown {
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const original=value as Record<string,unknown>;
  const clock=ruleNotificationWorldTime(verifiedRuleSource?original:{});
  const conflicting=Object.entries(clock).filter(([key,value])=>Object.hasOwn(original,key)&&original[key]!==value);
  if(conflicting.length){
   const previous=Array.isArray(original.timeProjectionConflicts)?original.timeProjectionConflicts:[];
   const added=conflicting.filter(([displayField])=>!previous.some(item=>item&&typeof item==='object'&&(item as Record<string,unknown>).displayField===displayField&&JSON.stringify((item as Record<string,unknown>).rawFields)===JSON.stringify(['kind','tick','seconds'])));
   return {...original,derivedEventClock:clock,timeProjectionConflicts:[...previous,...added.map(([displayField])=>({rawFields:['kind','tick','seconds'],displayField,status:'unresolved'}))]};
  }
  const row:Record<string,unknown>={...original,...clock};
  if(!verifiedRuleSource||clock.eventTimeBasis==='unknown'||typeof row.text!=='string')return row;
  const patterns:[RegExp,(...parts:string[])=>string][]=[
    [/^(.+) just launched a sub from (.+)\. It is estimated to arrive at (.+) in about (\d+) hours\.$/,(_m,p,src,dst,h)=>`${p}从${src}派出潜艇，预计约${Number(h)*6}世界天抵达${dst}。`],
    [/^Your absence from the game impacts other players negatively\. You will autoresign in (\d+) hours unless you log in\.$/,(_m,h)=>`请回到对局保持活跃。继续离线${Number(h)*6}世界天将自动退出。`],
    [/^You have been away from the game for (\d+) hours\.$/,(_m,h)=>`你已离开对局${Number(h)*6}世界天。`],
  ];
  for(const [pattern,render] of patterns){const match=row.text.match(pattern);if(match)return {...row,text:render(...match)};}
  return row;
}

export function worldTimeContext(value:unknown):unknown {
  if(Array.isArray(value))return value.map(worldTimeContext);
  if(!value||typeof value!=='object')return value;
  const row=value as Record<string,unknown>;
  const result=Object.fromEntries(Object.entries(row).map(([key,cell])=>[key,worldTimeContext(cell)]));
  const derive=(key:string,value:number)=>{if(!Object.prototype.hasOwnProperty.call(row,key))result[key]=value;};
  for(const key of ['notifications','ruleNotifications'])if(Array.isArray(result[key]))result[key]=(result[key] as unknown[]).map(item=>projectRuleNotification(item));
  if(Array.isArray(result.notificationTimeline))result.notificationTimeline=result.notificationTimeline.map(entry=>{
    if(!entry||typeof entry!=='object')return entry;
    const item=entry as Record<string,unknown>;
    return item.source==='rule'?{...item,notification:projectRuleNotification(item.notification)}:item;
  });
  if(result.lossReports&&typeof result.lossReports==='object'){
    const losses=result.lossReports as Record<string,unknown>;
    if(Array.isArray(losses.events))result.lossReports={...losses,events:losses.events.map(item=>projectRuleNotification(item,losses.eventSource==='rule-notification'))};
  }
  for(const key of minuteFields)if(typeof row[key]==='number')derive(key.replace(/Minutes$/,'WorldDays'),ruleMinutesToWorldDays(row[key] as number));
  for(const key of secondFields)if(typeof row[key]==='number')derive(`${key}WorldDays`,ruleSecondsToWorldDays(row[key] as number));
  for(const key of ['npPerDay','drillerRate','ownMineIncomePerDay','enemyIncomePerDay'])if(typeof row[key]==='number')derive(`${key}PerWorldDay`,legacyDailyRateToWorldDailyRate(row[key] as number));
  // Only task timing's secondsRemaining is rule time; lobby countdowns are real time.
  if(typeof row.observedSeconds==='number'&&Array.isArray(row.waitingDepartures))result.waitingDepartures=row.waitingDepartures.map(v=>{
    const projected=worldTimeContext(v) as Record<string,unknown>;
    if(v&&typeof v==='object'&&typeof (v as Record<string,unknown>).secondsRemaining==='number'&&!Object.prototype.hasOwnProperty.call(v,'remainingWorldDays'))projected.remainingWorldDays=((v as Record<string,unknown>).secondsRemaining as number)/600;
    return projected;
  });
  return result;
}
