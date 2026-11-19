import {HybridUsage,type HybridSummaryData} from './HybridSummary.js';
import {OutpostDefense,type OutpostDefenseData} from './OutpostDefense.js';
import type {BotDecisionSummaryData} from './BotDecisionSummary.js';
import {AgentNotebook} from './AgentNotebook.js';
import {ToolUsageChart} from './ToolUsageChart.js';
export {NoteReadable} from './NoteReadable.js';
import {notebookDisplayText} from './notebook-display.js';
import {aggregatePromptComposition,type DiagnosticStatistics} from './agent-statistics.js';
import {promptCompositionGroups} from './prompt-composition-groups.js';
import {mergeSmallPromptGroups} from './prompt-small-groups.js';
import {type NotebookOverviewData,AttackScreeningNotebook,type AttackScreeningNotebookData} from './NotebookOverview.js';
import {PromptDecisionDetails} from './PromptDecisionDetails.js';
import {PromptContext} from './PromptContext.js';
import React,{useEffect,useId,useRef,useState} from 'react';
import {MessageSquare,NotebookPen,ChartNoAxesCombined,Trash2,Copy} from 'lucide-react';
import {SegmentedControl} from './SegmentedControl.js';
import {TickTimeChart} from './TickTimeChart.js';
import {RecentAiCalls} from './RecentAiCalls.js';
import {ModelCallFailure,AgentCallList,type DiagnosticCall,type DiagnosticRound} from './AgentCallList.js';
import type {ConsoleRequest} from './AgentConnectionWizard.js';
export interface Usage {inputTokens:number|null;outputTokens:number|null;cachedInputTokens:number|null;totalTokens:number|null;provenance:string}
type Call=DiagnosticCall;
interface CallPage {generation:string;entries:Call[];rounds?:DiagnosticRound[];nextCursor:number|null}
interface Entry {id:number|string;kind:string;payload:unknown;unavailable?:boolean;archived?:boolean;archiveReason?:string}
interface EntryPage {outpostDefense?:OutpostDefenseData;hybrid?:HybridSummaryData;generation:string;entries:Entry[];nextCursor:number|null;overview?:NotebookOverviewData;outpostNames?:Record<string,string>;attackScreening?:AttackScreeningNotebookData;botDecision?:BotDecisionSummaryData}
interface Content {available:boolean;text:string|null;nextOffset:number|null;truncated:boolean;reason?:string}
export function tokenSeriesPath(values:(number|null)[],max:number){let path='',open=false;values.forEach((v,i)=>{if(v===null||!Number.isFinite(v)){open=false;return;}const x=30+i*520/Math.max(1,values.length-1),y=148-v/Math.max(1,max)*120;path+=(open?' L ':' M ')+x.toFixed(1)+' '+y.toFixed(1);open=true;});return path;}
const executionSeries=[{kind:'error',label:'报错',color:'#df8d83'},{kind:'rework',label:'返工',color:'#ddb56d'},{kind:'retry',label:'重试',color:'#8caade'},{kind:'rate-limit',label:'限流（HTTP 429）',color:'#ba93dc'}] as const;
export function ExecutionChart({rounds=[],callRounds=[],showRatios=true,rateLimits}:{rateLimits?:DiagnosticStatistics['modelRateLimits'];showRatios?:boolean;rounds:DiagnosticStatistics['executionRounds'];callRounds?:DiagnosticStatistics['rounds']}){
 const [active,setActive]=useState<number|null>(null);
 const grouped=new Map(rounds.map(r=>[r.round,r]));
 for(const key of Object.keys(rateLimits?.byRound??{})){const round=Number(key);if(!grouped.has(round))grouped.set(round,{round,events:[]});}
 const visible=[...grouped.values()].sort((a,b)=>a.round-b.round).slice(-50);
 const selected=visible.find(r=>r.round===active);
 const roundIds=new Set(visible.map(r=>r.round));
 const callCount=callRounds.filter(r=>roundIds.has(r.round)).reduce((n,r)=>n+r.calls.length,0);
 const counts=visible.map(r=>executionSeries.map(s=>s.kind==='rate-limit'?(rateLimits?.byRound?.[r.round]??0):r.events.filter(e=>e.kind===s.kind).length));
 const maximum=Math.max(1,...counts.flat()),left=38,right=710,top=20,bottom=175,cell=(right-left)/Math.max(1,visible.length);
 const width=Math.min(9,cell*.20),tooltipId=useId();
 return <section className="execution-chart" aria-label="最近50轮执行异常统计" onMouseLeave={()=>setActive(null)}>
  <div className="chart-heading"><h3>执行异常</h3><span>最近 {visible.length} 轮 · 悬浮查看原因</span></div>
  <div className="execution-rates">{executionSeries.map((s,i)=>{const count=counts.reduce((n,r)=>n+r[i]!,0);return <div key={s.kind} style={{color:s.color}}><span>{s.label}{showRatios&&s.kind!=='rate-limit'?' / 调用次数':'次数'}</span><strong>{!showRatios||s.kind==='rate-limit'?count:callCount?`${(count/callCount*100).toFixed(1)}%`:'—'}</strong><small>{showRatios&&s.kind!=='rate-limit'?count+' 次 / '+callCount+' 次调用':'最近 '+visible.length+' 轮'}</small></div>;})}</div>
  {visible.length?<svg viewBox="0 0 720 205" role="img" aria-label="最近最多50轮报错、返工、重试和模型限流 HTTP 429 次数分组柱形图">
   <path d={`M${left} ${top}V${bottom}H${right}`} className="chart-axis"/><text x="5" y={top+4}>{maximum}</text><text x="19" y={bottom+3}>0</text>
   {visible.map((r,index)=>{const center=left+cell*(index+.5),values=counts[index]!;const summary=`第 ${r.round} 轮 · ${executionSeries.map((s,i)=>`${s.label} ${values[i]} 次`).join(' · ')}`;return <g key={r.round} className="execution-round" tabIndex={0} aria-label={summary} aria-describedby={active===r.round?tooltipId:undefined} onMouseEnter={()=>setActive(r.round)} onFocus={()=>setActive(r.round)} onBlur={()=>setActive(null)} onClick={()=>setActive(r.round)}>
    <rect x={center-cell/2} y={top} width={cell} height={bottom-top} fill="transparent"/>
    {executionSeries.map((s,i)=>{const height=values[i]!/maximum*(bottom-top);return <rect key={s.kind} x={center+(i-executionSeries.length/2)*width} y={bottom-height} width={width-1} height={height} fill={s.color} pointerEvents="none"/>;})}
    {(visible.length<=14||index===0||index===visible.length-1||index%5===0)&&<text x={center} y={bottom+18} textAnchor="middle">{r.round}</text>}
   </g>;})}
  </svg>:<div className="chart-empty">暂无执行轮次</div>}
  {rateLimits&&<p className="diagnostic-caption">本局累计 HTTP 429：{rateLimits.total.toLocaleString()} 次 · 自动决策 {rateLimits.byLane.automatic.toLocaleString()} · Hybrid 后台 {rateLimits.byLane.background.toLocaleString()} · 指挥官对话 {rateLimits.byLane.commander.toLocaleString()}{(rateLimits.unassigned??0)>0?` · ${rateLimits.unassigned} 次未关联轮次，仅计入累计`:''}</p>}
  {selected&&<div id={tooltipId} role="tooltip" className="execution-tooltip"><strong>第 {selected.round} 轮</strong><p>限流（HTTP 429）：{rateLimits?.byRound?.[selected.round]??0} 次</p>{selected.events.length?<ol>{selected.events.map(e=><li key={`${e.id}-${e.kind}`}><b>{executionSeries.find(s=>s.kind===e.kind)!.label}</b>{e.step!==null&&<small> · 步骤 {e.step}</small>}{e.at&&<small> · {e.at}</small>}<p>{e.reason}</p></li>)}</ol>:<p>本轮未记录报错、返工或重试。</p>}</div>}
 </section>;
}
type UsageCall=Pick<Call,'callRef'|'round'|'usage'>;
export function recentCallRounds<T extends {round:number|null}>(calls:T[],limit:number):T[]{
 const rounds=[...new Set(calls.flatMap(call=>call.round===null?[]:[call.round]))].sort((a,b)=>b-a).slice(0,limit);
 const selected=new Set(rounds);return calls.filter(call=>call.round!==null&&selected.has(call.round));
}
export function TokenChart({calls,unassignedCalls=calls.filter(call=>call.round===null).length}:{calls:UsageCall[];unassignedCalls?:number}){
 const patternId=`token-cache-unknown-${useId().replace(/:/g,'')}`;
 const visible=recentCallRounds(calls,50),grouped=new Map<number,UsageCall[]>();
 for(const call of visible){const items=grouped.get(call.round!)??[];items.push(call);grouped.set(call.round!,items);}
 const valid=(value:number|null):value is number=>value!==null&&Number.isFinite(value)&&value>=0;
 const rounds=[...grouped].sort(([a],[b])=>a-b).map(([round,items])=>{
  let input=0,output=0,uncached=0,cached=0,unknownCacheInput=0,cacheInput=0,inputKnown=0,outputKnown=0,cacheKnown=0;
  for(const {usage} of items){
   if(valid(usage.outputTokens)){output+=usage.outputTokens;outputKnown++;}
   if(!valid(usage.inputTokens))continue;
   input+=usage.inputTokens;inputKnown++;
   if(valid(usage.cachedInputTokens)&&usage.cachedInputTokens<=usage.inputTokens){
    cached+=usage.cachedInputTokens;uncached+=usage.inputTokens-usage.cachedInputTokens;cacheInput+=usage.inputTokens;cacheKnown++;
   }else unknownCacheInput+=usage.inputTokens;
  }
  return {round,items,input,output,uncached,cached,unknownCacheInput,cacheInput,inputKnown,outputKnown,cacheKnown};
 });
 const recentCache=rounds.reduce((total,round)=>({cached:total.cached+round.cached,input:total.input+round.cacheInput,knownCalls:total.knownCalls+round.cacheKnown,inputCalls:total.inputCalls+round.inputKnown}),{cached:0,input:0,knownCalls:0,inputCalls:0});
 const format=(n:number)=>new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(n);
 const recentCacheRatio=recentCache.input>0?`${(recentCache.cached/recentCache.input*100).toFixed(1)}%`:recentCache.knownCalls>0?'不适用':'未知';
 const recentCacheCoverage=`${recentCache.knownCalls}/${recentCache.inputCalls} 次有输入调用`;
 const recentAverage=rounds.reduce((total,round)=>({tokens:total.tokens+(round.inputKnown===round.items.length&&round.outputKnown===round.items.length?round.input+round.output:0),calls:total.calls+(round.inputKnown===round.items.length&&round.outputKnown===round.items.length?round.items.length:0)}),{tokens:0,calls:0});
 const recentAverageLabel=recentAverage.calls?`${format(recentAverage.tokens/recentAverage.calls)} tokens`:'未知';
 const maximum=Math.max(1,...rounds.map(r=>r.input+r.output)),hasUsage=rounds.some(r=>r.inputKnown||r.outputKnown),left=42,right=710,top=22,bottom=196,plotHeight=bottom-top,cellWidth=(right-left)/Math.max(1,rounds.length),barWidth=Math.max(4,Math.min(24,cellWidth*.56));
 return <section className="token-chart" aria-label="按轮汇总的 Token 用量">
  <div className="chart-heading"><h3>Token 用量</h3><div className="token-chart-meta"><span title={unassignedCalls?`${unassignedCalls} 次历史调用未记录轮次，未纳入按轮柱形图。`:undefined}>最近 {rounds.length} 轮 · {visible.length} 次调用</span><span className="recent-cache-hit" title={`按最近最多50轮中缓存用量已知的输入加权计算；统计覆盖 ${recentCacheCoverage}`}>近期缓存命中 <strong>{recentCacheRatio}</strong><small>{recentCacheCoverage}</small></span><span className="recent-token-average" title={`仅统计输入和输出均有记录的调用；覆盖 ${recentAverage.calls}/${visible.length} 次调用`}>平均每次 <strong>{recentAverageLabel}</strong><small>{recentAverage.calls}/{visible.length} 次调用</small></span></div></div>
  {hasUsage?<svg viewBox="0 0 720 250" role="img" aria-label="最近最多50轮未缓存输入、缓存输入、缓存未知输入与输出 Token 堆叠柱形图；悬浮柱体查看缓存占比和数据覆盖">
   <defs><pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#514a5b"/><path d="M-1 1L1 -1M0 6L6 0M5 7L7 5" stroke="#d9cde8" strokeWidth="1.5"/></pattern></defs>
   <path d={`M${left} ${top}V${bottom}H${right}`} className="chart-axis"/><text x="3" y={top+4}>{format(maximum)}</text><text x="23" y={bottom+3}>0</text>
   {rounds.map((r,index)=>{
    const center=left+cellWidth*(index+.5),x=center-barWidth/2,complete=r.inputKnown===r.items.length&&r.outputKnown===r.items.length;
    const cacheComplete=r.cacheKnown===r.items.length;
    const cacheSummary=`${cacheComplete?'':'已记录'}缓存输入 ${r.cacheKnown?r.cached.toLocaleString():'未知'} · 缓存占输入 ${r.cacheInput?(r.cached/r.cacheInput*100).toFixed(1)+'%':r.cacheKnown?'不适用（输入为 0）':'未知'}${cacheComplete?'':'（仅已知样本）'}`;
    const tooltips=[`第 ${r.round} 轮 · ${r.items.length} 次调用`,`${complete?'':'已记录'}输入 ${r.inputKnown?r.input.toLocaleString():'未知'} · 输出 ${r.outputKnown?r.output.toLocaleString():'未知'}`,complete?`合计 ${format(r.input+r.output)} tokens`:`部分用量：输入 ${r.inputKnown}/${r.items.length} 次 · 输出 ${r.outputKnown}/${r.items.length} 次`,cacheSummary,`缓存统计覆盖 ${r.cacheKnown}/${r.items.length} 次调用 · 对应输入分母 ${r.cacheInput.toLocaleString()}`,r.unknownCacheInput?`缓存未知的已记录输入 ${r.unknownCacheInput.toLocaleString()}（斜纹，不视为未缓存）`:'',...r.items.map(c=>`#${c.callRef}  输入 ${c.usage.inputTokens?.toLocaleString()??'未知'} · 输出 ${c.usage.outputTokens?.toLocaleString()??'未知'} · 缓存 ${c.usage.cachedInputTokens?.toLocaleString()??'未知'}`)].filter(Boolean).join('\n');
    let accumulated=0;
    const segments=[{name:'input',value:r.uncached},{name:'cached',value:r.cached},{name:'cache-unknown',value:r.unknownCacheInput},{name:'output',value:r.output}];
    const showLabel=rounds.length<=14||index===0||index===rounds.length-1||index%Math.ceil(rounds.length/12)===0;
    return <g key={r.round} className="token-round-bar"><title>{tooltips}</title><rect className="token-hover-area" x={center-cellWidth/2} y={top} width={cellWidth} height={bottom-top}/>{segments.map(({name,value})=>{const height=value/maximum*plotHeight;accumulated+=height;return height>0?<rect key={name} className={`token-bar-${name}`} x={x} y={bottom-accumulated} width={barWidth} height={height} fill={name==='cache-unknown'?`url(#${patternId})`:undefined}/>:null;})}{showLabel&&<text className="token-round-label" x={center} y={bottom+17} textAnchor="middle">{r.round}</text>}</g>;
   })}
  </svg>:<div className="chart-empty"><ChartNoAxesCombined size={24} strokeWidth={1.3}/><span>暂无用量</span></div>}
  <div className="token-legend"><span className="inputTokens">未缓存输入</span><span className="cachedInputTokens" title="输入中的缓存部分">缓存输入</span><span className="unknownCacheTokens" title="缓存用量未记录">缓存未知输入</span><span className="outputTokens">输出</span></div>
 </section>;
}

const promptSectionNames:Record<string,string>={policy:'角色与事实边界',taskGuidance:'整轮触发与未完成事项',rulesAndTools:'常驻普通规则与全部工具',strategyAndMemory:'指挥官指令、战略与笔记正文',stateProjection:'情报结构说明',decisionHistory:'未解决的历史操作',decisionContext:'最新局势与变化',toolReceipts:'行动与工具回执',feedback:'本轮工作结果与操作回执',closingGuidance:'输出与收尾',unclassified:'未分类',other:'其他'};
const promptToolNames:Record<string,string>={observe:'查看局面（旧）',notebook:'笔记与战略',reminders:'复查提醒',campaigns:'战役计划（旧）',order:'立即下令',batch:'批量下令',say:'外交消息',forecast:'组合方案推演',compare:'统一方案比较',decisionSupport:'方案搜索',campaignCompare:'战役推演（旧）',queries:'批量只读查询',attackCandidates:'进攻初筛',deploy:'单条出兵预览',recall:'读取记录（旧）',finish:'保存并结束整轮',opening:'开局分析（旧）',economy:'经济分析（旧）',arrivals:'抵达估计（旧）',gather:'集兵分析（旧）',threats:'威胁分析（旧）',chatHistory:'历史消息',changes:'局面变化（旧）'};
const promptColors=['#91b8a0','#8ba9c2','#c4a178','#b491bd','#8fb4b5','#cf927e','#9da9cc','#c2b77e','#849a83'];
const receiptName=(key:string)=>({structure:'字段与结构符号',unavailable:'未能细分的历史回执',unclassified:'未分类内容',other:'其他'}[key]??promptToolNames[key]??key);
function PromptReceiptDetails({sections,tools,total}:{sections:Record<string,number>;tools:Record<string,number>;total:number}){
 const parent=(sections.decisionHistory??0)+(sections.feedback??0);
 const rows=Object.entries(tools).filter(([,n])=>Number.isFinite(n)&&n>0).sort((a,b)=>b[1]-a[1]);
 const classified=rows.reduce((n,[,v])=>n+v,0);
 if(parent>classified)rows.push(['unclassified',parent-classified]);
 const grouped=mergeSmallPromptGroups(rows.map(([key,value])=>({key,value,members:[key]})),parent);
 return <details className="prompt-decision-breakdown prompt-receipt-breakdown"><summary>回执明细</summary>
  <p className="muted">占本模块的字符比例；本轮 {(sections.feedback??0).toLocaleString()}，历史 {(sections.decisionHistory??0).toLocaleString()}。</p>
  <div className="prompt-bars">{grouped.map(({key,value,members})=>{const percent=parent?value/parent*100:0;return <div className="prompt-bar-row" key={key} title={`${key==='other'?members.map(k=>`${receiptName(k)}：${rows.find(([name])=>name===k)?.[1].toLocaleString()} 字符`).join('；')+'；':''}占总提示词 ${total?(value/total*100).toFixed(1):'0.0'}%`}><div className="prompt-bar-label"><span>{receiptName(key)}</span><span>{value.toLocaleString()} · {percent.toFixed(1)}%</span></div><div className="prompt-bar-track"><span style={{width:`${percent}%`,backgroundColor:'#8fb4b5'}}/></div></div>;})}</div>
 </details>;
}
export function PromptCompositionChart({calls=[],composition,sampleCounts}:{calls?:Call[];composition?:DiagnosticStatistics['composition'];sampleCounts?:{all:number;recent:number}}){
 const [range,setRange]=useState<'all'|'recent'>('all');
 const selectedCalls=range==='all'?calls:recentCallRounds(calls,10),sampleCount=sampleCounts?.[range]??selectedCalls.length;
 const selected=composition?.[range]??aggregatePromptComposition(selectedCalls);
 const {calls:available,total,sections,toolReturns:tools,decisionContext}=selected,groups=promptCompositionGroups(sections);
 return <section className="prompt-composition" aria-label="提示词各内容模块字符占比">
  <div className="chart-heading"><h3>提示词内容构成</h3><SegmentedControl label="提示词统计范围" value={range} options={[{value:'all',label:'所有'},{value:'recent',label:'最近10轮'}]} onChange={setRange}/></div>
  <div className="prompt-composition-meta"><span title={sampleCount>available?`${sampleCount-available} 次调用未记录可用字符拆分，未计入占比。`:undefined}>{available}{sampleCount>available?`/${sampleCount}`:''} 次调用 · 合计 {total.toLocaleString()} 字符</span><span title="按提示词字符数统计">实际字符占比</span></div>
  {!available?<div className="chart-empty"><ChartNoAxesCombined size={24} strokeWidth={1.3}/><span>暂无可用拆分</span></div>:<div className="prompt-bars">{groups.map(({key,value,members},index)=>{const percent=total?value/total*100:0;return <React.Fragment key={key}>
   <div className="prompt-bar-row" title={key==='other'?members.map(name=>`${promptSectionNames[name]??name}：${sections[name]!.toLocaleString()} 字符`).join('；'):undefined}><div className="prompt-bar-label"><span>{promptSectionNames[key]??key}</span><span>{value.toLocaleString()} · {percent.toFixed(1)}%</span></div><div className="prompt-bar-track"><span style={{width:`${percent}%`,backgroundColor:promptColors[index%promptColors.length]}}/></div></div>
   {members.includes('decisionContext')&&<PromptDecisionDetails summary={decisionContext} callCount={available} total={total}/>}
   {members.some(name=>name==='decisionHistory'||name==='feedback')&&<PromptReceiptDetails sections={sections} tools={tools} total={total}/>}
  </React.Fragment>;})}</div>}
 </section>;
}
export function DiagnosticNoteList({entries,source,current,busy,renderEntry}:{entries:Entry[];source:'notebook'|'reminders'|'campaigns';current:boolean;busy:boolean;renderEntry:(entry:Entry)=>React.ReactNode}){
 const grouped=current;
 const items=source==='campaigns'&&current?entries.flatMap(entry=>{const p=entry.payload as {plans?:Record<string,unknown>[]} | null;return Array.isArray(p?.plans)?p.plans.map((plan,index)=>({...entry,id:`${entry.id}:${index}`,payload:plan,archived:plan.stage==='completed'||plan.stage==='cancelled',archiveReason:'closed'})):[entry];}):entries;
 const archived=grouped?items.filter(n=>n.archived):[],active=grouped?items.filter(n=>!n.archived):items;
 return <div className="note-list" aria-busy={busy}><div className="note-card-grid">{active.map(renderEntry)}</div>{!active.length&&<div className="empty-state"><NotebookPen size={27} strokeWidth={1.25}/><span>暂无{source==='notebook'?(grouped?'有效笔记':'笔记'):source==='reminders'?'提醒':'战役'}</span></div>}{archived.length>0&&<details className="note-archive"><summary><b>归档</b><small title="当前页已关闭或已过期的记录">{archived.length} 条</small></summary><div className="note-card-grid">{archived.map(renderEntry)}</div></details>}</div>;
}
interface AgentDiagnosticsProps {id:string;tab:'logs'|'notes'|'assessment'|'stats';request:ConsoleRequest;totals?:{calls:number;tokens:number};mode?:string;onNavigate?:(tab:'live'|'logs')=>void}
export function AgentDiagnostics(props:AgentDiagnosticsProps){
 return props.tab==='notes'?<AgentNotebook id={props.id} request={props.request} {...(props.onNavigate?{onNavigate:props.onNavigate}:{})}/>:<AgentDiagnosticPanels {...props}/>;
}
function AgentDiagnosticPanels({id,tab,request,totals,mode='hybrid'}:AgentDiagnosticsProps){
 const [calls,setCalls]=useState<CallPage>({generation:'',entries:[],nextCursor:null}),[cursor,setCursor]=useState<number|undefined>(),[refresh,setRefresh]=useState({revision:0,background:false}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [logSource,setLogSource]=useState<'calls'|'commander-calls'>('calls');
 const revision=refresh.revision,lastQuery=useRef('');
 const [statistics,setStatistics]=useState<DiagnosticStatistics|null>(null);
 const [ref,setRef]=useState<number|null>(null),[contentKind,setContentKind]=useState<'prompt'|'reply'|'request'>('prompt'),[content,setContent]=useState<Content|null>(null),[contentError,setContentError]=useState(''),[copyMessage,setCopyMessage]=useState(''),[search,setSearch]=useState('');
 const promptContentCache=useRef(new Map<string,Content>());
 const [notes,setNotes]=useState<EntryPage>({generation:'',entries:[],nextCursor:null});
 const [notebookError,setNotebookError]=useState('');
 useEffect(()=>{
  if(tab!=='stats')return;
  const abort=new AbortController();
  void request<EntryPage>(`debug/notebook?seat=${encodeURIComponent(id)}&scope=current&limit=1`,undefined,abort.signal).then(page=>{if(!abort.signal.aborted){setNotes(page);setNotebookError('');}}).catch(()=>{if(!abort.signal.aborted)setNotebookError('当前决策暂不可用。');});
  return()=>abort.abort();
 },[id,tab,mode,revision]);
 const [clearing,setClearing]=useState(false),[clearMessage,setClearMessage]=useState('');
 useEffect(()=>{const abort=new AbortController();const queryKey=JSON.stringify([id,tab,logSource,cursor]);if(!refresh.background||lastQuery.current!==queryKey){setBusy(true);setError('');}lastQuery.current=queryKey;const route=tab==='stats'?`debug/stats?seat=${encodeURIComponent(id)}`:tab==='assessment'?`debug/notebook?seat=${encodeURIComponent(id)}&scope=current&limit=30`:`debug/${logSource}?seat=${encodeURIComponent(id)}&limit=30${cursor===undefined?'':'&before='+cursor+'&generation='+encodeURIComponent(calls.generation)}`;void request<CallPage|EntryPage|DiagnosticStatistics>(route,undefined,abort.signal).then(v=>{if(!abort.signal.aborted){setError('');if(tab==='stats')setStatistics(v as DiagnosticStatistics);else if(tab==='assessment')setNotes(v as EntryPage);else {const page=v as CallPage;setCalls(page);setRef(current=>calls.generation===page.generation&&page.entries.some(call=>call.callRef===current)?current:page.entries.reduce<number|null>((latest,call)=>latest===null||call.callRef>latest?call.callRef:latest,null));}}}).catch(()=>{if(!abort.signal.aborted)setError('诊断记录暂不可用。');}).finally(()=>{if(!abort.signal.aborted)setBusy(false);});return()=>abort.abort();},[id,tab,logSource,cursor,revision]);
 useEffect(()=>{if(ref===null){setContent(null);return;}const promptKey=`${id}:${calls.generation}:${ref}`;if(contentKind==='prompt'){const cached=promptContentCache.current.get(promptKey);if(cached){setContent(cached);return;}}const abort=new AbortController();setContent(null);setContentError('');setCopyMessage('');void(async()=>{try{let offset=0,text='',page:Content|null=null;do{page=await request<Content>(`debug/content?seat=${encodeURIComponent(id)}&generation=${encodeURIComponent(calls.generation)}&ref=${ref}&kind=${contentKind}&offset=${offset}&limit=32768`,undefined,abort.signal);if(abort.signal.aborted)return;if(!page.available){setContent(page);return;}text+=page.text??'';if(page.nextOffset===null)break;offset=page.nextOffset;}while(!abort.signal.aborted);if(!abort.signal.aborted&&page){const complete={...page,text,nextOffset:null};if(contentKind==='prompt')promptContentCache.current.set(promptKey,complete);setContent(complete);}}catch{if(!abort.signal.aborted)setContentError('调用内容暂不可用。');}})();return()=>abort.abort();},[id,ref,contentKind,calls.generation,revision]);
 const copyAll=async()=>{if(!content?.available||content.text===null)return;try{await navigator.clipboard.writeText(content.text);setCopyMessage('已复制全部内容');}catch{setCopyMessage('复制失败，请检查浏览器剪贴板权限');}};
 const detail=calls.entries.find(c=>c.callRef===ref);
 const clearLogs=async()=>{setClearing(true);setClearMessage('');setError('');try{await request<{cleared:boolean}>('debug/clear',{id});setCalls({generation:'',entries:[],nextCursor:null});setCursor(undefined);setRef(null);setContent(null);setClearMessage('日志已清空，累计调用与 Token 统计已归零。');setRefresh(v=>({revision:v.revision+1,background:false}));}catch{setError('清空日志失败，请重试。');}finally{setClearing(false);}};
 return <section className="agent-diagnostics" aria-label={tab==='logs'?'日志':tab==='notes'?'笔记':tab==='assessment'?'攻防评估':'统计'}>
  {<div className="diagnostic-toolbar">
   {tab==='logs'?<SegmentedControl label="调用类型" value={logSource} options={[{value:'calls',label:'自动决策'},{value:'commander-calls',label:'指挥官'}]} onChange={value=>{setLogSource(value);setCalls({generation:'',entries:[],nextCursor:null});setCursor(undefined);setRef(null);setContent(null);setContentKind('prompt');}}/>:null}
   <div className="toolbar-actions"><button disabled={clearing||busy} onClick={()=>setRefresh(v=>({revision:v.revision+1,background:false}))}>刷新</button>{tab==='logs'&&<button disabled={clearing||busy} onClick={clearLogs}><Trash2 size={12}/>{clearing?'清空中':'清空'}</button>}{tab==='logs'&&<><button disabled={busy||cursor===undefined} onClick={()=>setCursor(undefined)}>最新</button><button disabled={busy||calls.nextCursor===null} onClick={()=>{setCursor(calls.nextCursor??undefined);setRef(null);}}>更早</button></>}</div>
  </div>}
  {error&&<p role="alert" className="error">{error}</p>}{notebookError&&<p role="alert" className="error">{notebookError}</p>}
  {clearMessage&&<p className="console-notice" role="status">{clearMessage}</p>}
  {tab==='assessment'&&<div className="assessment-workspace">
   <section className="assessment-column" aria-label="攻击评估" aria-busy={busy}>
    {notes.attackScreening?<AttackScreeningNotebook value={notes.attackScreening} names={notes.outpostNames??{}}/>:<div className="decision-panel assessment-panel"><h3>据点进攻初筛</h3><p className="diagnostic-caption">{busy?'读取攻击评估中…':'暂无进攻评分判断'}</p></div>}
   </section>
   <section className="assessment-column" aria-label="防守评估" aria-busy={busy}>
    {notes.outpostDefense?<OutpostDefense value={notes.outpostDefense} names={notes.outpostNames??{}}/>:<div className="decision-panel assessment-panel"><h3>己方据点防守压力</h3><p className="diagnostic-caption">{busy?'读取防守评估中…':'暂无防守压力评分'}</p></div>}
   </section>
  </div>}
  {tab==='stats'&&<><div className="statistics-trends"><TickTimeChart id={id} request={request} revision={revision}/><RecentAiCalls id={id} request={request} revision={revision}/></div>{statistics?<div className="statistics-stack">
   {<section aria-label="程序执行概览"><div className="section-heading"><h3>程序执行</h3><span>已记录数据</span></div><dl className="diagnostic-metrics"><div><dt>近期记录轮次</dt><dd>{statistics.executionRounds.length}</dd></div><div><dt>累计工具请求</dt><dd>{statistics.toolUsage?.all.total.toLocaleString()??'未记录'}</dd></div><div><dt>近期异常事件</dt><dd>{statistics.executionRounds.reduce((n,r)=>n+r.events.length,0)}</dd></div></dl></section>}
   {(notebookError?null:notes.hybrid?.state?.usage?<HybridUsage usage={notes.hybrid.state.usage}/>:<p className="diagnostic-caption">尚无后台模型用量记录。</p>)}
   {(statistics.calls>0)&&<section aria-label="自动决策模型概览"><div className="section-heading"><h3>自动决策模型</h3></div><div className="stat-summary"><div><span>累计模型调用</span><strong>{statistics.calls.toLocaleString()}</strong></div><div><span>已记录 Token</span><strong>{totals?totals.tokens.toLocaleString():'未记录'}</strong></div><div><span>平均调用耗时</span><strong>{statistics.duration.measuredCalls?(statistics.duration.totalMs/statistics.duration.measuredCalls/1000).toFixed(1)+' s':'未记录'}</strong></div></div></section>}
   {(statistics.commanderUsage.calls>0)&&<section className="commander-token-summary" aria-label="指挥官对话 Token 用量"><div className="chart-heading"><h3>指挥官对话</h3><span>{statistics.commanderUsage.calls.toLocaleString()} 次模型调用</span></div><dl className="diagnostic-metrics"><div><dt>已记录 Token</dt><dd>{statistics.commanderUsage.tokens.toLocaleString()}</dd></div><div><dt>输入</dt><dd>{statistics.commanderUsage.inputTokens.toLocaleString()}</dd></div><div><dt>输出</dt><dd>{statistics.commanderUsage.outputTokens.toLocaleString()}</dd></div><div><dt>缓存输入</dt><dd>{statistics.commanderUsage.cachedInputTokens.toLocaleString()}</dd></div></dl>{statistics.commanderUsage.unknownTokenCalls>0&&<small>用量未知：{statistics.commanderUsage.unknownTokenCalls} 次调用</small>}</section>}
   <ToolUsageChart usage={statistics.toolUsage} labels={promptToolNames}/>
   {(statistics.calls>0)&&<><TokenChart calls={statistics.rounds.flatMap(round=>round.calls)} unassignedCalls={statistics.unassignedCalls}/><PromptCompositionChart composition={statistics.composition} sampleCounts={{all:statistics.calls,recent:statistics.rounds.slice(-10).reduce((n,round)=>n+round.calls.length,0)}}/></>}
   <ExecutionChart rateLimits={statistics.modelRateLimits} rounds={statistics.executionRounds} callRounds={statistics.rounds} showRatios={statistics.calls>0}/>
  </div>:!error&&<div className="chart-empty"><span>读取统计中…</span></div>}</>}
  {tab==='logs'&&<div className="call-workspace">
   <section className="call-sidebar" aria-label="调用列表">
   <AgentCallList calls={calls.entries} rounds={calls.rounds??[]} newestFirst={true} selected={ref} busy={busy} onSelect={c=>{if(c.callRef===ref)return;setRef(c.callRef);setContent(null);setSearch('');}}/>
   {!calls.entries.length&&<div className="empty-state compact-empty"><MessageSquare size={22} strokeWidth={1.5}/><span>{busy?'读取调用记录中…':logSource==='commander-calls'?'暂无指挥官调用记录':'暂无自动决策模型调用记录'}</span></div>}
   </section>
   {detail?<section key={detail.callRef} className="call-content" aria-label="调用详情"><h3>调用 #{detail.callRef}</h3>{detail.lane==='commander'&&<p className="muted">原始请求与返回 · 未脱敏{detail.queueWaitMs!==undefined?` · 排队 ${(detail.queueWaitMs/1000).toFixed(1)} 秒`: ''} </p>}{detail.lane==='strategy'&&<dl className="diagnostic-metrics">
     <div><dt>模型</dt><dd>{detail.model}</dd></div>{detail.completion&&<div><dt>供应商结束确认</dt><dd>{detail.completion.protocol} · {detail.completion.finishReason}</dd></div>}<div><dt>任务</dt><dd>{detail.task}</dd></div>
     <div><dt>排队时间</dt><dd>{detail.startedAt===null?'未记录':new Date(detail.startedAt).toLocaleString()}</dd></div>
     <div><dt>发送时间</dt><dd>{detail.sentAt?new Date(detail.sentAt).toLocaleString():'未记录'}</dd></div>
     <div><dt>结束时间</dt><dd>{detail.finishedAt?new Date(detail.finishedAt).toLocaleString():'未记录'}</dd></div>
     <div><dt>总耗时</dt><dd>{detail.durationMs===null?'未记录':(detail.durationMs/1000).toFixed(2)+' 秒'}</dd></div>
     <div><dt>排队耗时</dt><dd>{detail.queueWaitMs==null?'未记录':(detail.queueWaitMs/1000).toFixed(2)+' 秒'}</dd></div>
     <div><dt>模型耗时</dt><dd>{detail.providerDurationMs==null?'未记录':(detail.providerDurationMs/1000).toFixed(2)+' 秒'}</dd></div>
     <div><dt>输入 Token</dt><dd>{detail.usage.inputTokens?.toLocaleString()??'未报告'}</dd></div>
     <div><dt>输出 Token</dt><dd>{detail.usage.outputTokens?.toLocaleString()??'未报告'}</dd></div>
     <div><dt>缓存输入 Token</dt><dd>{detail.usage.cachedInputTokens?.toLocaleString()??'未报告'}</dd></div>
     <div><dt>合计 Token</dt><dd>{detail.usage.totalTokens?.toLocaleString()??'未完整报告'}</dd></div>
    </dl>}<ModelCallFailure call={detail}/><div className="diagnostic-toolbar"><button aria-pressed={contentKind==='prompt'} onClick={()=>{if(contentKind==='prompt')return;setContent(null);setContentKind('prompt');}}>上下文</button><button aria-pressed={contentKind==='reply'} onClick={()=>{if(contentKind==='reply')return;setContent(null);setContentKind('reply');}}>回复</button>{(detail.lane==='commander'||detail.lane==='strategy')&&<button aria-pressed={contentKind==='request'} onClick={()=>{if(contentKind==='request')return;setContent(null);setContentKind('request');}}>请求参数</button>}<span className="toolbar-spacer"/><button disabled={!content?.available||content.text===null} onClick={()=>void copyAll()}><Copy size={12}/>复制全部</button>{copyMessage&&<span className="toolbar-label" role="status">{copyMessage}</span>}</div><input aria-label="搜索日志" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索完整日志内容"/>{contentError&&<p role="alert" className="error">{contentError}</p>}{!content&&!contentError?<p className="muted">读取全部内容中…</p>:!content?.available?<p className="muted">{content?.reason==='summary-only'?'仅保留调用摘要，未保存上下文、回复及请求正文。':'未记录此项内容'}</p>:<>{contentKind==='prompt'?<PromptContext text={content.text??''} search={search}/>:<pre tabIndex={0}>{search?content.text?.split('\n').filter(line=>line.toLowerCase().includes(search.toLowerCase())).join('\n')||'无匹配内容':content.text}</pre>}{content.truncated&&<span className="muted">日志保存时已截断，当前展示的是保存的全部内容。</span>}</>}
   </section>:<section className="call-content call-detail-empty" aria-label="调用详情"><MessageSquare size={22} strokeWidth={1.5}/><span>{calls.entries.length?'选择调用查看详情':'暂无调用详情'}</span></section>}
  </div>}
 </section>;
}
