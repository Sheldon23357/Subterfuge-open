/** Derived, persistent-linked journal. No notification data changes authoritative
 * snapshots, command hashes, event sequences or append-only storage records. */
export interface NotificationBattle {
  attacker: { player: number | null; before: number; after: number };
  defender: { player: number | null; before: number; after: number };
  shield: { before: number; after: number };
  outcome: string;
}
export interface GameplayNotification {
  generateAlert?:boolean;
  kind: string;
  tick: number;
  seconds: number;
  text: string;
  details: string | null;
  urgent: boolean;
  sendNotification: boolean;
  location: {
    kind: "outpost" | "fleet";
    id: string;
    position: { x: number; y: number };
  } | null;
  battle?: NotificationBattle;
}
interface Entry {
  player: number;
  notification: GameplayNotification;
  previous: Entry | null;
}
export interface ActivityEvent {
  id:number;kind:string;tick:number;seconds:number;actor:number|null;subject:string;
  source:string|null;destination:{kind:string;id:string}|null;
  drillers:number|null;enabled:boolean|null;
  arrival?:{outpost:string;outcome:'delivered'|'defeated';drillers:number|null};
  termination?:{outcome:'recovered'|'removed';outpost:string|null;drillers:number};
  transfer?:{from:number;to:number;reason:'gift'|'capture'};
  battle?:{attacker:{player:number|null;loss:number};defender:{player:number|null;loss:number}};
}
interface ActivityEntry {event:ActivityEvent;previous:ActivityEntry|null}
const activityJournals = new WeakMap<object,ReadonlyMap<number,ActivityEntry|null>>();
const commandHeads=new WeakMap<object,ReadonlyMap<number,{id:string;tick:number}>>();
export function appendCommandHead(s:object,command:{player:number;id:string;tick:number}){
 const next=new Map(commandHeads.get(s));next.set(command.player,{id:command.id,tick:command.tick});commandHeads.set(s,next);
}
export function readCommandHead(s:object,player:number){return commandHeads.get(s)?.get(player)??null;}
const battleLossMatrices = new WeakMap<ActivityEntry,number[][]>();
/** Public cumulative drillers lost: row = victim, column = opponent.
 * Read the full global journal, independently of the ten-entry live feed.
 */
export function readGlobalBattleLosses(s:object,players:number):number[][] {
  const head=activityJournals.get(s)?.get(-1)??null;
  const pending:ActivityEntry[]=[];
  let cursor=head;
  while(cursor&&!battleLossMatrices.has(cursor)){pending.push(cursor);cursor=cursor.previous;}
  const matrix=cursor?structuredClone(battleLossMatrices.get(cursor)!):Array.from({length:players},()=>Array<number>(players).fill(0));
  for(const entry of pending.reverse()){
    const battle=entry.event.battle;
    if(!battle)continue;
    const a=battle.attacker.player,d=battle.defender.player;
    if(a===null||d===null||a===d||!matrix[a]||!matrix[d])continue;
    matrix[a]![d]!+=battle.attacker.loss;
    matrix[d]![a]!+=battle.defender.loss;
  }
  if(head)battleLossMatrices.set(head,matrix);
  return structuredClone(matrix);
}
export function appendActivity(s:object,player:number,event:ActivityEvent){
  const next=new Map(activityJournals.get(s));
  const prior=next.get(player)??null;
  next.set(player,{event:{...event,id:(prior?.event.id??-1)+1},previous:prior});
  activityJournals.set(s,next);
}
/** Restore only the already-projected global activity of a private OB branch.
 * This does not reconstruct player notification archives or authoritative state.
 * Copy the retained IDs so future appendActivity calls continue their sequence. */
export function restoreGlobalPredictionActivity(s:object,events:readonly ActivityEvent[]){
  const next=new Map(activityJournals.get(s));
  let head:ActivityEntry|null=null;
  for(const event of structuredClone(events).slice(-10))head={event,previous:head};
  next.set(-1,head);
  activityJournals.set(s,next);
}
export function readActivity(s:object,player:number):ActivityEvent[]|null {
  if(!activityJournals.has(s))return null;
  const events:ActivityEvent[]=[];
  for(let head=activityJournals.get(s)!.get(player);head&&events.length<10;head=head.previous)events.push(head.event);
  return structuredClone(events.reverse());
}
/** Complete authorized journal, paged at a fixed exclusive upper cursor. */
export function readActivityPage(s:object,player:number,after:number,through:number,limit:number){
 const head=activityJournals.get(s)?.get(player),upper=(head?.event.id??-1)+1;
 if(!Number.isSafeInteger(after)||!Number.isSafeInteger(through)||after<0||through<after||through>upper||!Number.isInteger(limit)||limit<1||limit>200)throw Error('Invalid activity cursor');
 const end=Math.min(through,after+limit),events:ActivityEvent[]=[];
 for(let entry=head;entry&&entry.event.id>=after;entry=entry.previous)if(entry.event.id<end)events.push(entry.event);
 events.reverse();
 if(events.length!==end-after)throw Error('Activity history is incomplete');
 return {events:structuredClone(events),nextCursor:end,hasMore:end<through,through};
}
const journals = new WeakMap<object, Entry | null>();
const forecastJournals = new WeakMap<object, Entry | null>();
/** Private local recovery cache; never part of a player projection or portable replay. */
export function saveNotificationCheckpoint(s:object){
 const notifications:{player:number;notification:GameplayNotification}[]=[];
 for(let head=journals.get(s);head;head=head.previous)notifications.push({player:head.player,notification:head.notification});
 const activity=[...(activityJournals.get(s)??[])].map(([player,head])=>{
  const events:ActivityEvent[]=[];for(;head;head=head.previous)events.push(head.event);
  return {player,events:events.reverse()};
 });
 return {notifications:notifications.reverse(),activity,heads:[...(commandHeads.get(s)??[])]};
}
export function restoreNotificationCheckpoint(s:object,data:ReturnType<typeof saveNotificationCheckpoint>){
 initializeNotifications(s);
 for(const {player,notification}of data.notifications)appendNotification(s,player,notification);
 for(const {player,events}of data.activity)for(const event of events)appendActivity(s,player,event);
 commandHeads.set(s,new Map(data.heads));
}
export function enableForecastNotifications(s:object){forecastJournals.set(s,null);}
export function disableForecastNotifications(s:object){forecastJournals.delete(s);}
export function capturesForecastNotifications(s:object){return forecastJournals.has(s);}
export function appendForecastNotification(s:object,player:number,notification:GameplayNotification){
 forecastJournals.set(s,{player,notification,previous:forecastJournals.get(s)??null});
}
export function readForecastNotifications(s:object,player:number){
 const result:GameplayNotification[]=[];
 for(let entry=forecastJournals.get(s);entry;entry=entry.previous)if(entry.player===player)result.push(entry.notification);
 return structuredClone(result.reverse());
}
export function initializeNotifications(s: object) {
  commandHeads.set(s,new Map());
  activityJournals.set(s,new Map());
  journals.set(s, null);
}
export function inheritNotifications(source: unknown, target: unknown) {
  if(source&&target&&typeof source==='object'&&typeof target==='object'&&commandHeads.has(source))commandHeads.set(target,commandHeads.get(source)!);
  if(source&&target&&typeof source==='object'&&typeof target==='object'&&activityJournals.has(source))activityJournals.set(target,activityJournals.get(source)!);
  if(source&&target&&typeof source==='object'&&typeof target==='object'&&forecastJournals.has(source))forecastJournals.set(target,forecastJournals.get(source)!);
  if (
    source &&
    target &&
    typeof source === "object" &&
    typeof target === "object" &&
    journals.has(source)
  ) {
    journals.set(target, journals.get(source)!);
  }
}
export function appendNotification(
  s: object,
  player: number,
  notification: GameplayNotification,
) {
  journals.set(s, { player, notification, previous: journals.get(s) ?? null });
}
export function readNotifications(
  s: object,
  player: number,
): GameplayNotification[] | null {
  if (!journals.has(s)) return null;
  const result: GameplayNotification[] = [];
  for (let entry = journals.get(s); entry; entry = entry.previous)
    if (entry.player === player) result.push(entry.notification);
  return structuredClone(result.reverse());
}
