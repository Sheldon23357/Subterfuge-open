import type {PlayerObservation} from '../../../../contracts/src/index.js';
import {observationRuleSeconds} from '../../../../contracts/src/index.js';
import {TICKS_PER_DAY} from '../../../../rules/src/index.js';

export type MiningPhase='early'|'mid'|'late';
export const MINING_LATE_PROGRESS=0.5;
export interface MiningPhaseHistory {
 format:'mining-phase/1';roomId:string;player:number;playerCount:number;goal:number;
 stage:MiningPhase;observedAtSeconds:number;observedTick:number;basisRevision:string;
 reason:'complete-public-roster-without-mining'|'observed-mining'|'observed-half-goal';
 evidence:{players:number[];maximumNeptunium:number;knownMines:number};
}
const rank:Record<MiningPhase,number>={early:0,mid:1,late:2};
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
export const phaseLabel=(phase:MiningPhase|null)=>phase===null?'未知':({early:'前期',mid:'中期',late:'后期'} as const)[phase];

/** History is an observed milestone, scoped to the same room, seat and rules.
 * A stale/future observation never imports later knowledge into an older map. */
export function applicableMiningHistory(o:PlayerObservation,previous:MiningPhaseHistory|null|undefined){
 if(!previous)return null;
 if(previous.format!=='mining-phase/1'||!Object.hasOwn(rank,previous.stage)||!finite(previous.observedAtSeconds)
   ||!Number.isSafeInteger(previous.observedTick)||previous.observedTick<0||typeof previous.basisRevision!=='string'
   ||!Number.isSafeInteger(previous.player)||!Number.isSafeInteger(previous.playerCount)||!finite(previous.goal)||previous.goal<=0
   ||!previous.evidence||!Array.isArray(previous.evidence.players)||!previous.evidence.players.every(p=>Number.isSafeInteger(p)&&p>=0&&p<previous.playerCount)
   ||!finite(previous.evidence.maximumNeptunium)||!Number.isSafeInteger(previous.evidence.knownMines)||previous.evidence.knownMines<0
   ||previous.reason!==({early:'complete-public-roster-without-mining',mid:'observed-mining',late:'observed-half-goal'} as const)[previous.stage])throw Error('Invalid mining phase history');
 const v=o.view;
 return previous.roomId===o.roomId&&previous.player===v.player&&previous.playerCount===v.playerCount
   &&previous.goal===v.match?.neptuniumGoal&&previous.observedAtSeconds<=observationRuleSeconds(o)?previous:null;
}

/** Current public economy only. No authority world, forecast, notebook or
 * hidden outpost type participates in deciding the global phase. */
export function miningPhaseContext(o:PlayerObservation,previous?:MiningPhaseHistory|null){
 const v=o.view;if(v.match?.mode!=='mining')return null;
 const goal=finite(v.match.neptuniumGoal)&&v.match.neptuniumGoal>0?v.match.neptuniumGoal:null;
 const previousHistory=applicableMiningHistory(o,previous);
 const rows=new Map<number,PlayerObservation['intel'][number]>();
 for(const p of o.intel)if(Number.isSafeInteger(p.player)&&p.player>=0&&p.player<v.playerCount&&typeof p.active==='boolean'
   &&finite(p.neptunium)&&Number.isSafeInteger(p.outposts.mine)&&p.outposts.mine>=0&&!rows.has(p.player))rows.set(p.player,p);
 const complete=rows.size===v.playerCount;
 const active=[...rows.values()].filter(p=>p.active&&p.player!==v.player);
 // The authorized self balance remains usable if a partial intel page omits
 // our own row. Missing opponents do not become zero or an early-game proof.
 const self={player:v.player,active:v.self.active,neptunium:v.self.neptunium,
   mines:rows.get(v.player)?.outposts.mine??v.outposts.filter(p=>p.owner===v.player&&p.type==='mine'&&!p.destroyed).length};
 const known=[...active.map(p=>({player:p.player,neptunium:p.neptunium,mines:p.outposts.mine})),...(self.active?[self]:[])];
 const maximum=known.length?Math.max(...known.map(p=>p.neptunium)):null;
 const leaders=maximum===null?[]:known.filter(p=>p.neptunium===maximum).map(p=>p.player).sort((a,b)=>a-b);
 const miningObserved=known.some(p=>p.mines>0||p.neptunium>0);
 const current:MiningPhase|null=goal!==null&&maximum!==null&&maximum>=goal*MINING_LATE_PROGRESS?'late'
   :miningObserved?'mid':complete?'early':null;
 const stage=previousHistory&&(current===null||rank[previousHistory.stage]>rank[current])?previousHistory.stage:current;
 const history:MiningPhaseHistory|null=stage===null||goal===null?previousHistory:
   previousHistory&&previousHistory.stage===stage?previousHistory:{format:'mining-phase/1',roomId:o.roomId,player:v.player,playerCount:v.playerCount,goal,stage,
     observedAtSeconds:observationRuleSeconds(o),observedTick:v.tick,basisRevision:o.revision,
     reason:stage==='late'?'observed-half-goal':stage==='mid'?'observed-mining':'complete-public-roster-without-mining',
     evidence:{players:stage==='late'?known.filter(p=>p.neptunium>=goal*MINING_LATE_PROGRESS).map(p=>p.player):stage==='mid'?known.filter(p=>p.mines>0||p.neptunium>0).map(p=>p.player):[...rows.keys()].sort((a,b)=>a-b),maximumNeptunium:maximum??0,knownMines:known.reduce((n,p)=>n+p.mines,0)}};
 const position=!self.active?'inactive':maximum===null?'unknown':maximum===0?complete?'unranked':'unknown':self.neptunium<maximum?'behind':!complete?'unknown':leaders.length>1?'tied-leading':'leading';
 const ownRate=rows.get(v.player)?.npPerDay;
 const staticEta=(balance:number,rate:unknown)=>goal!==null&&finite(rate)&&rate>0?Math.max(0,goal-balance)*TICKS_PER_DAY/rate:null;
 const rivals=active.map(p=>({player:p.player,worldDays:staticEta(p.neptunium,p.npPerDay)}))
   .filter((p):p is {player:number;worldDays:number}=>p.worldDays!==null).sort((a,b)=>a.worldDays-b.worldDays||a.player-b.player);
 return {stage,currentMilestone:current,history,publicRosterComplete:complete,
  missingPlayers:Array.from({length:v.playerCount},(_,i)=>i).filter(p=>!rows.has(p)),
  goal,lateThreshold:goal===null?null:goal*MINING_LATE_PROGRESS,maximumKnownNeptunium:maximum,
  leaderPlayers:leaders,leaderProgress:goal===null||maximum===null?null:maximum/goal,
  self:{player:v.player,neptunium:self.neptunium,progress:goal===null?null:self.neptunium/goal,mines:self.mines,position,
    staticVictoryWorldDays:staticEta(self.neptunium,ownRate)},
  fastestKnownOpponent:rivals[0]??null,
  interpretation:'阶段为本席已观察到的历史里程碑，只向前推进；当前矿量和currentMilestone另列，失矿不会抹去历史。库存领先与最早冲线可能不同；static时间仅假设当前公开收入不变，不是未来战果或预测保证。资料不全时只能确认已观察到的里程碑，未见矿不等于全局从未开矿。'};
}
export type MiningPhaseContext=NonNullable<ReturnType<typeof miningPhaseContext>>;

/** Routing/scope fields stay in the private journal, not model-facing facts. */
export function miningPhaseFacts(context:MiningPhaseContext){
 const {history,...current}=context;
 return {...current,label:phaseLabel(context.stage),milestone:history?{stage:history.stage,observedTick:history.observedTick,
  basisRevision:history.basisRevision,reason:history.reason,evidence:history.evidence}:null};
}
