import {originalGameOver} from './original-endgame.generated.js';
import {RULES,TICK_SECONDS,ACTIVITY_RULES,INACTIVITY_RULE_SECONDS,type ActivityRules} from '../../rules/src/index.js';
import {integer,nonnegative} from './numeric.js';

export interface SeatSummary { alive:boolean; neptunium:number; outposts:number }
export interface EndCondition { ended:boolean; triggeringSeat:number|null; triggeringTeam:number|null }
/** Team grouping follows contiguous seats, not arbitrary player-supplied membership lists. */
export function teamSeats(playerCount:number,teamSize:number,team:number):number[] {
  integer(playerCount,'playerCount');integer(teamSize,'teamSize');integer(team,'team');
  if(playerCount<2||playerCount>10||teamSize>playerCount)throw new RangeError('Invalid room size');
  const first=teamSize>0?team*teamSize:team,end=teamSize>0?Math.min(first+teamSize,playerCount):Math.min(first+1,playerCount);
  return Array.from({length:Math.max(0,end-first)},(_,i)=>first+i);
}
/** Mirrors isGameOver/$2e, not calculatePlayerTableOrder or final medal/ranking assignment. */
export function detectEndCondition(seats:readonly SeatSummary[],teamSize:number,mode:'mining'|'domination',neptuniumGoal=200):EndCondition {
  const count=seats.length;
  teamSeats(count,teamSize,0);
  integer(neptuniumGoal,'neptuniumGoal');
  if(neptuniumGoal===0)throw new RangeError('Victory goal must be positive');
  for(const seat of seats){integer(seat.neptunium,'neptunium');integer(seat.outposts,'outposts');}
  if(teamSize>0&&mode==='domination'&&RULES.GameParams.TeamDominationRequirementByPlayerCount[count]===0)throw new RangeError('Unsupported team domination size');
  const state={info:{maxPlayerCount:count,teamSize,noMines:mode==='domination',rulesVersion:4300,neptuniumGoal},
    playerStates:{get:(i:number)=>({timeOfDeathInSecs:seats[i]!.alive?-1:0})},
    world:{cachedValues:{get:(i:number)=>({neptunium:seats[i]!.neptunium,outpostCountByType:[0,seats[i]!.outposts,0]})}}};
  const result=originalGameOver(state);
  return {ended:result.ended,triggeringSeat:result.player<0?null:result.player,triggeringTeam:result.team<0?null:result.team};
}
/** Retirement clears funding; inactivity under the current match policy preserves inventory. */
export function retirePlayer(players:{active:boolean;neptunium:number}[],funding:boolean[][],owner:number,preserveNeptunium=false){
  const player=players[owner];if(!player||!player.active)throw Error('Inactive or unknown player');
  player.active=false;if(!preserveNeptunium)player.neptunium=0;funding[owner]!.fill(false);
  for(const row of funding)row[owner]=false;
}
export function shouldAutoResign(worldTick:number,lastCheckinSeconds:number,forecast=false,activityRules?:ActivityRules,realtimeTickMilliseconds=10000):boolean {
  integer(worldTick,'worldTick');nonnegative(lastCheckinSeconds,'lastCheckinSeconds');
  const limit=activityRules===ACTIVITY_RULES?INACTIVITY_RULE_SECONDS*10000/realtimeTickMilliseconds:RULES.GameParams.HoursOfInactivityBeforeAutoresign*3600;
  return !forecast&&worldTick*TICK_SECONDS-lastCheckinSeconds>=limit;
}
/** Exact H2e behavior: the first two thresholds both return 1, not 1 then 2. */
export function inactivityWarningCount(minutes:number):number {
  nonnegative(minutes,'minutes');
  const first=RULES.GameParams.MinutesOfInactivityBeforeFirstWarning,interval=RULES.GameParams.MinutesOfInactivityBetweenWarnings;
  if(minutes<first)return 0;
  if(minutes<first+interval)return 1;
  return Math.trunc(Math.trunc(minutes-first)/interval);
}

