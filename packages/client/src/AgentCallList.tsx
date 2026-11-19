import React, {useState} from 'react';
import type {Usage} from './AgentDiagnostics.js';

export interface DiagnosticCall {callPhase?:'transport'|'publication';completion?:{protocol:'chat'|'responses';status:'completed';finishReason:'stop'|'completed';responseId?:string};failure?:{stage?:string;code?:string;httpStatus?:number;reason?:string;timeoutSource?:string;retryDelayMs?:number}|null;lane?:string;mode?:string;model?:string;task?:string;processingStatus?:string;sentAt?:string|null;finishedAt?:string|null;providerDurationMs?:number|null;queueWaitMs?:number;validationError?:string;error?:string|null;callRef:number;round:number|null;step:number|null;attempt:number|null;startedAt:number|null;durationMs:number|null;outcome:string;prompt:{available:boolean;characters:number;truncated:boolean};promptBreakdown?:{unit:'characters';total:number|null;sections:Record<string,number>;toolReturns?:Record<string,number>;decisionContext?:{total:number;sections:Record<string,number>}};usage:Usage;captured:boolean;tool?:string|null;summary?:string|null;observedTick?:number|null;resultTick?:number|null;toolOutcome?:string|null;toolReconciled?:boolean;toolError?:string|null}
export interface DiagnosticRound {round:number;tick:number|null;reasons:string[]}
const toolNames:Record<string,string>={campaignCompare:'方案推演',campaigns:'战役计划',say:'外交消息',recall:'读取记录',observe:'查看局面',order:'提交指令',batch:'批量指令',finish:'结束本轮',queries:'组合查询',opening:'开局分析',attackCandidates:'进攻初筛',decisionSupport:'方案搜索',deploy:'部署预览',forecast:'局面推演',compare:'方案比较',arrivals:'抵达估计',economy:'经济分析',gather:'集结分析',notebook:'笔记',reminders:'提醒',remember:'更新记忆',changes:'局面变化',threats:'威胁分析',chatHistory:'聊天记录'};
export function callDisplayState(call:DiagnosticCall){
 if(call.outcome==='cancelled'||call.outcome==='interrupted-unconfirmed'&&call.processingStatus==='completed')return {label:'已中断',tone:'muted'};
 if(call.validationError)return {label:'回复被拒绝',tone:'error'};
 if(call.outcome==='failed')return {label:'调用失败',tone:'error'};
 if(call.lane==='strategy'){
  const labels:Record<string,string>={queued:'排队中',running:'模型处理中',completed:call.callPhase==='transport'?'已返回':'已发布','awaiting-material':'补查资料','stale-dependency':'依据已失效',superseded:'已过时','partition-reviewed':'分段已审阅','incomplete-conversation':'会话已更新','superseded-pressure':'困境已解除'};
  if(call.processingStatus&&labels[call.processingStatus])return {label:labels[call.processingStatus]!,tone:call.outcome==='running'?'active':'normal'};
 }


 if(call.outcome==='interrupted-unconfirmed')return {label:'已中断',tone:'muted'};
 if(call.lane==='commander'&&call.error&&call.outcome==='completed')return {label:'处理失败',tone:'error'};

 if(call.toolOutcome==='not-executed')return {label:'已确认未执行',tone:'muted'};
 if(call.toolOutcome==='partial')return {label:call.tool==='queries'?'查询部分完成':'批次未完成',tone:'error'};
 if(call.toolOutcome==='unknown')return {label:'操作结果未知',tone:'error'};
 if(call.toolOutcome==='rejected')return {label:call.tool==='batch'?'批次未完成':'工具被拒绝',tone:'error'};
 if(call.toolOutcome==='superseded')return {label:'局面变化',tone:'muted'};
 if(call.toolOutcome==='returned'&&call.toolReconciled===true)return {label:'结果已核实',tone:'normal'};
 return {label:call.outcome==='completed'?'已返回':call.outcome==='running'?'请求中':'未记录',tone:call.outcome==='running'?'active':'normal'};
}
export function groupCallRecords(calls:DiagnosticCall[],newestFirst=false){
 const groups=new Map<number|null,DiagnosticCall[]>();for(const call of calls){const list=groups.get(call.round)??[];list.push(call);groups.set(call.round,list);}
 return [...groups].sort(([a],[b])=>(b??-1)-(a??-1)).map(([round,entries])=>({round,entries:[...entries].sort((a,b)=>newestFirst?b.callRef-a.callRef:a.callRef-b.callRef)}));
}
const number=(n:number)=>new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(n);
const duration=(ms:number)=>ms>=60_000?`${Math.floor(ms/60_000)}分${((ms%60_000)/1000).toFixed(0)}秒`:`${(ms/1000).toFixed(1)}秒`;
const trigger=(reasons:string[])=>reasons.map(r=>r==='首次进入对局'?'首次入局':r==='恢复AI后重新检查'?'启动检查':r).join(' · ');
const errorLabel=(error:string)=>error==='stale-observation'?'情报已过期':error==='Invalid campaign review tick'?'战役复查时间已过期':error.startsWith('Campaign comparison is stale')?'采用的推演已过期':error==='batch-incomplete'?'部分指令未完成':error==='query-batch-incomplete'?'查询中断，已有结果保留':error;
export function AgentCallList({calls,rounds=[],newestFirst=false,selected,busy,onSelect}:{calls:DiagnosticCall[];rounds?:DiagnosticRound[];newestFirst?:boolean;selected:number|null;busy:boolean;onSelect:(call:DiagnosticCall)=>void}){
 const [expanded,setExpanded]=useState<Set<number|null>>(()=>new Set([null]));
 return <div className="call-list call-timeline" aria-busy={busy}>{groupCallRecords(calls,newestFirst).map(group=>{
  const meta=rounds.find(r=>r.round===group.round);
  const isCollapsed=!expanded.has(group.round);
  const measuredDuration=group.entries.reduce((sum,call)=>sum+(call.durationMs??0),0),measuredCalls=group.entries.filter(call=>call.durationMs!==null).length;
  const inputs=group.entries.reduce((sum,call)=>sum+(call.usage.inputTokens??0),0),outputs=group.entries.reduce((sum,call)=>sum+(call.usage.outputTokens??0),0);
  const tokenCalls=group.entries.filter(call=>call.usage.totalTokens!==null||(call.usage.inputTokens!==null&&call.usage.outputTokens!==null)).length;
  const tokens=group.entries.reduce((sum,call)=>sum+(call.usage.totalTokens??(call.usage.inputTokens!==null&&call.usage.outputTokens!==null?call.usage.inputTokens+call.usage.outputTokens:0)),0);
  const inputKnown=group.entries.some(c=>c.usage.inputTokens!==null),outputKnown=group.entries.some(c=>c.usage.outputTokens!==null);
  const totalsTitle=`本轮当前页已记录：输入 ${inputKnown?inputs.toLocaleString():'未知'}、输出 ${outputKnown?outputs.toLocaleString():'未知'}、合计 ${tokenCalls?tokens.toLocaleString():'未知'} tokens；耗时 ${measuredCalls?duration(measuredDuration):'未知'}（${measuredCalls}/${group.entries.length} 次调用有耗时）`;
  return <section className="call-round" key={group.round??'unknown'} aria-label={group.round===null?(group.entries[0]?.lane==='commander'?'指挥官调用':group.entries[0]?.lane==='strategy'?'后台模型调用':'历史调用'):`第 ${group.round} 轮决策`}>
   <button type="button" className="call-round-heading" aria-expanded={!isCollapsed} onClick={()=>setExpanded(previous=>{const next=new Set(previous);if(next.has(group.round))next.delete(group.round);else next.add(group.round);return next;})}><span className="call-round-toggle" aria-hidden="true">{isCollapsed?'▸':'▾'}</span><span className="call-round-heading-content"><span><b>{group.round===null?(group.entries[0]?.lane==='commander'?'指挥官调用':group.entries[0]?.lane==='strategy'?'后台模型调用':'历史调用'):'第 '+group.round+' 轮'}</b><span>{meta?.tick!=null?'第 '+meta.tick+' 天启动':''}</span><small title={totalsTitle}>本页 {group.entries.length} 次 · 耗时 {measuredCalls?duration(measuredDuration):'未知'} · {tokenCalls?`已记录 ${number(tokens)} Token`:'Token 未知'}</small></span>{meta?.reasons.length?<span className="call-round-reason" title={meta.reasons.join('；')}>{trigger(meta.reasons)}</span>:null}</span></button>
   {!isCollapsed&&group.entries.map(call=>{const state=callDisplayState(call),time=call.startedAt===null?'—':new Date(call.startedAt).toLocaleTimeString('zh-CN',{hour12:false});return <button type="button" key={call.callRef} className={'call-row'+(selected===call.callRef?' selected':'')} aria-pressed={selected===call.callRef} onClick={()=>onSelect(call)}>
    <span className="call-step">{call.step===null?'—':String(call.step+1).padStart(2,'0')}</span>
    <span className="call-main"><span className="call-row-title"><b>{call.lane==='commander'?(call.mode==='reconcile'?'策略整理':'指挥官讨论'):call.lane==='strategy'?({strategy:'战略规划',diplomacy:'外交谈判',commander:'指令转译'} as Record<string,string>)[call.mode??'']??'后台模型调用':call.tool?toolNames[call.tool]??call.tool:'模型调用'}</b><span className={'call-state '+state.tone}>{state.label}</span></span>
     <span className="call-explanation" title={call.summary??undefined}>{call.summary??(state.label==='已中断'?'暂停或退出时中断，未取得完整回复':call.outcome==='running'?'正在等待模型返回':'历史记录未保存回复摘要')}</span>
     <span className="call-row-meta"><span>#{call.callRef}</span>{call.observedTick!=null&&<span>情报：第 {call.observedTick} 天</span>}{call.resultTick!=null&&call.resultTick!==call.observedTick&&<span>返回：第 {call.resultTick} 天</span>}<span title={call.startedAt===null?'':new Date(call.startedAt).toLocaleString()}>{time}</span>{call.durationMs!==null&&<span>{(call.durationMs/1000).toFixed(1)}s</span>}{call.usage.inputTokens!==null&&<span title={`输入 ${call.usage.inputTokens.toLocaleString()} tokens；提示词 ${call.prompt.characters.toLocaleString()} 字符`}>输入 {number(call.usage.inputTokens)}</span>}{(call.attempt??0)>0&&<span>重试 {call.attempt}</span>}</span>
     {call.toolError&&<span className="call-tool-error">{errorLabel(call.toolError)}</span>}
    </span>
   </button>;})}
  </section>;
 })}</div>;
}


export function ModelCallFailure({call}:{call:DiagnosticCall}){
 if(!call.validationError&&!call.error&&!call.failure)return null;
 const f=call.failure,stage=f?.stage;
 const stages:Record<string,string>={validation:'回复校验',provider:'模型供应商',queue:'请求排队',unknown:'未记录'};
 return <div className="call-failure" role="status"><p className="error">{call.validationError?'回复校验失败：':'调用失败：'}{call.validationError??call.error??'未记录详细原因'}</p>
  {f&&<p className="muted">阶段：{stages[stage??'unknown']??stage}{f.httpStatus?` · HTTP ${f.httpStatus}`:''}{f.code?` · ${f.code}`:''}{f.reason?` · ${f.reason}`:''}{f.timeoutSource?` · 超时来源：${f.timeoutSource}`:''}{f.retryDelayMs!=null?` · 重试间隔 ${f.retryDelayMs/1000} 秒`:''}</p>}
 </div>;
}
