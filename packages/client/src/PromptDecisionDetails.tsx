import React from 'react';
import {aggregatePromptComposition,type PromptCompositionSummary} from './agent-statistics.js';
import type {DiagnosticCall} from './AgentCallList.js';
import {mergeSmallPromptGroups} from './prompt-small-groups.js';

const roundNames={spatialRelations:'据点位置关联',settlements:'实际结算',executionEvidence:'预约与实际操作',changes:'关键变化',reminders:'时间复查提醒',attackAnalysis:'进攻初筛建议'};

const names:Record<string,string>={outposts:'据点与驻军',production:'据点生产状态',fleets:'舰队与航线',economyAndVictory:'经济与胜负',worldMetadata:'世界时间与地图属性',intel:'情报记录',scheduled:'预约指令',chat:'聊天与通信',notifications:'游戏通知',notebook:'笔记正文与索引',memoryConsistency:'记忆一致性检查',campaigns:'战役计划',opening:'开局分析与安全扩张',attackAnalysis:'进攻候选与来源预算',executionEvidence:'执行方案与推演依据',changes:'局面变化',reminders:'提醒',task:'当前任务与范围',identity:'身份与观察元数据',structure:'字段名与结构符号',other:'其他当前情报',unavailable:'未能细分的历史内容'};

Object.assign(names,roundNames);
export function PromptDecisionDetails({calls=[],summary,callCount=calls.length,total}:{calls?:DiagnosticCall[];summary?:PromptCompositionSummary['decisionContext'];callCount?:number;total:number}){
 const detail=summary??aggregatePromptComposition(calls).decisionContext;
 const {total:parent,sections:parts,coveredCalls:covered}=detail;
 if(parent<=0)return null;
 return <details className="prompt-decision-breakdown"><summary>当前情报明细 <span>{covered}/{callCount} 次调用可细分</span></summary>
  <div className="prompt-bars">{mergeSmallPromptGroups(Object.entries(parts).sort((a,b)=>b[1]-a[1]).map(([key,value])=>({key,value,members:[key]})),parent).map(({key,value,members})=>{
   const percent=value/parent*100;
   return <div className="prompt-bar-row" key={key} title={`${key==='other'?members.map(k=>`${names[k]??k}：${parts[k]?.toLocaleString()} 字符`).join('；')+'；':''}占总提示词 ${total?(value/total*100).toFixed(1):'0.0'}%`}><div className="prompt-bar-label"><span>{key==='other'?'其他':names[key]??key}</span><span>{value.toLocaleString()} · {percent.toFixed(1)}%</span></div><div className="prompt-bar-track"><span style={{width:`${percent}%`,backgroundColor:key==='unavailable'?'#777':'#9da9cc'}}/></div></div>;
  })}</div>
 </details>;
}
