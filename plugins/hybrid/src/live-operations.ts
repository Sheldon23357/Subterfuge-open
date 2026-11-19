import {botSearchBranch} from '@subterfuge/bot-sdk/analysis/tactical-progress';
import type {BotLiveSnapshot,BotSearchProgress} from '@subterfuge/bot-sdk/contracts';
import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {BotDecision} from '@subterfuge/bot-sdk/analysis/tactical-planner';
import type {HybridState,OperationState} from './contracts.js';

function intentDescription(t:NonNullable<HybridState['intents']>[number],o:PlayerObservation|undefined){
 const s=t.spec,name=(id:string)=>o?.outpostNames?.[id]??id;
 let text:string;
 switch(s.kind){
  case 'configure':text=`${name(s.target)}：${[s.minDrillers===null?'':`驻兵至少 ${s.minDrillers}`,s.maxDrillers===null?'':`驻兵至多 ${s.maxDrillers}`].filter(Boolean).join('，')}；${s.maintain?'持续保持':'达到一次即完成'}`;break;
  case 'avoid':text=`禁止进攻 ${name(s.target)}`;break;
  case 'capture':text=`攻占 ${name(s.target)}${s.maxDrillersPerPlan==null?'':`；每方案新增投入上限 ${s.maxDrillersPerPlan} 兵`}；优先级 ${s.priority}`;break;
  case 'transfer':text=`${name(s.source)} → ${name(s.target)}；运输 ${s.drillers===null?'执行时安全可调兵力':s.drillers+' 兵'}`;break;
  case 'return-fleet':text=`令舰队 ${s.fleetId} 返航至出发地，兵力减半向下取整`;break;
  case 'focus':text=`主攻 ${name(s.target)}；集结点 ${name(s.rally)}`;break;
 }
 return `${text}；截止第 ${s.until} 天；${t.authority==='commander'?'指挥官要求':'模型意图'}`;
}

export function liveOperations(observation:PlayerObservation|undefined,latest:<T>(kind:string)=>T|undefined):Pick<BotLiveSnapshot,'diplomacy'|'directive'|'tasks'|'intents'|'decision'|'operations'> {
 const hybrid=latest<HybridState>('state');
 const completed=latest<{sequence:number;step?:number;decision:BotDecision}>('decision');
 const searched=latest<{sequence:number;step?:number;decision:BotDecision}>('search');
 const row=searched&&(!completed||searched.sequence>completed.sequence||searched.sequence===completed.sequence&&(searched.step??0)>(completed.step??0))?searched:completed;
 const decision=row?.decision;
 const text=(v:unknown)=>typeof v==='string'?v.slice(0,500):null;
 const branches:BotSearchProgress['branches']=decision?.assessments.map(a=>botSearchBranch(a.candidate,a.status,a.score?.utility??null))??[];
 return {
  ...(observation?.diplomacy?{diplomacy:observation.diplomacy}:{}),
  directive:hybrid?.directive?{version:hybrid.directive.version,summary:hybrid.directive.summary,objectives:hybrid.directive.objectives,agreements:(observation?.diplomacy?[]:hybrid.directive.agreements).map(a=>({status:a.status,summary:a.summary,forbidAttack:a.forbidAttack}))}:null,
  tasks:hybrid?.tasks??[],intents:(hybrid?.intents??[]).map(t=>({id:t.id,kind:t.spec.kind,target:'target' in t.spec?t.spec.target:null,status:t.status,reason:t.reason,description:intentDescription(t,observation)})),
  decision:decision&&row?{sequence:row.sequence,finalized:row===completed,observedTick:decision.observedTick,current:observation?.revision===decision.basisRevision,selected:decision.selected.id,kind:decision.selected.kind,targets:decision.selected.targets,reasons:decision.selected.reasons,coverage:decision.coverage,parameters:decision.parameters,branches,drafts:decision.selected.drafts.map(d=>({kind:String(d.action.kind),source:text(d.action.source),target:text(d.action.destination??d.action.outpostId??d.action.fleetId),drillers:typeof d.action.drillers==='number'?d.action.drillers:null}))}:null,
  operations:(latest<{operations:OperationState[]}>('operations')?.operations??[]).map(o=>({id:o.id,objective:o.objective,status:o.status,issues:o.issues})),

 };
}
