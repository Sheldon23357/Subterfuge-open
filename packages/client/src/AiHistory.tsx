import {RawTimeLegend,ToolTimeSummary} from './DiagnosticTime.js';
import {tickTime} from './time.js';
import {AttackRanking,type RankingSnapshot,type Campaign} from './AttackRanking.js';
import React,{useEffect,useState} from 'react';
import {Bot,ListOrdered,Download,NotebookText,RefreshCw,ChevronDown,ChevronLeft,ChevronRight,X} from 'lucide-react';
import {DeferredIntel} from './DeferredIntel.js';
import {colors} from './theme.js';
import {PLAYER_NAMES,AI_PERSONALITIES,type ChatMessage} from '../../contracts/src/index.js';
import './ai-history.css';
import {compactNumber} from './compact-number.js';
import {ChatMessageText} from './ChatMessageText.js';
import {message as notificationMessage} from './PlayerNotifications.js';
const Text=({text}:{text:string})=><ChatMessageText text={text} ai/>;

interface Entry {id:number;kind:string;payload:unknown}
interface History {failure?:{diagnostic?:unknown}|null;screening?:RankingSnapshot|null;campaigns?:{plans:Campaign[]}|null;roomId:string;seat:number;agent:null|{status:string;settings:{model:string;personality:string};calls:number;tokens:number;memory:Record<string,string>;lastThought:number|null;sequence:number;error?:string|null;notebook?:{id:string;kind:string;text:string;expiresAt:number|null;record?:{type:string;players:number[]}}[]};deferred?:{key:string;summary:string;count:number}[];entries:Entry[];nextCursor:number|null}
const tools:Record<string,string>={queries:'联合查询',changes:'局势变化',chatHistory:'外交历史',threats:'威胁与增援',economy:'经济方案',gather:'集兵方案',notebook:'整理记录簿',reminders:'关键提醒',say:'外交发言',order:'执行指令',batch:'批量指令',schedule:'预约指令',cancelSchedule:'撤销预约',observe:'刷新情报',forecast:'方案推演',compare:'方案比较',arrivals:'抵达预测',deploy:'派遣预览',remember:'战略笔记',rules:'规则依据',finish:'本轮结论'};
interface Step {id:string;tool:string;summary:string;arguments:Record<string,unknown>;status:string;result?:unknown;diagnostic?:unknown}
interface Decision {stats?:{tokens:number|null;durationMs:number|null;durationComplete:boolean};diagnostics?:unknown[];sequence?:number;seconds?:number;status:string;error?:string;reasons?:string[];category?:string;weight?:string;contextExpanded?:boolean;incomingMessages?:ChatMessage[];steps:Step[]}
const statusNames:Record<string,string>={'pending-continuation':'待续办',completed:'已完成',thinking:'思考中',interrupted:'已中断',error:'异常'};
const diplomacyIntents:Record<string,string>={peace:'停战／安抚',trade:'交换',pressure:'威胁施压',coalition:'结盟提议',coordinate:'联合协调',information:'情报',reply:'回应'};
function DecisionCard({entry,latest}:{entry:Entry;latest:boolean}) {
  const [expandedSteps,setExpandedSteps]=useState<Record<string,boolean>>({});
  const d=entry.payload as Decision;
  const conclusion=d.steps.find(s=>s.tool==='finish');
  const steps=d.steps.filter(s=>s.tool!=='finish');
  const time=d.seconds===undefined?'':tickTime(d.seconds/600);
  const elapsed=d.stats?.durationMs;
  const totalSeconds=elapsed==null?null:Math.round(elapsed/1000);
  const duration=totalSeconds===null?"未记录":totalSeconds<60?`${totalSeconds}秒`:`${Math.floor(totalSeconds/60)}分${totalSeconds%60}秒`;
  return <details className="ai-history-entry ai-history-round" open={latest}>
    <summary className="ai-round-heading"><ChevronDown size={14} className="ai-round-chevron"/>
    <b className="ai-round-number">第 {d.sequence??'—'} 轮</b>
    <small className="ai-round-time" title="游戏时间">{time||'—'}</small>
    <span className="ai-round-status" title={`${d.category?`${({strategy:'战略',diplomacy:'外交',military:'军事',plan:'计划'} as Record<string,string>)[d.category]??d.category} · ${({light:'轻',medium:'中',heavy:'重'} as Record<string,string>)[d.weight??'']??''}${d.contextExpanded?' → 战略·重':''} · `:''}${statusNames[d.status]??d.status}`}>{d.category&&`${({strategy:'战略',diplomacy:'外交',military:'军事',plan:'计划'} as Record<string,string>)[d.category]??d.category} · ${({light:'轻',medium:'中',heavy:'重'} as Record<string,string>)[d.weight??'']??''}${d.contextExpanded?' → 战略·重':''} · `}{statusNames[d.status]??d.status}</span>
    <small className="ai-round-duration" title={elapsed==null?'未记录思考用时':`${d.stats?.durationComplete?'本轮总用时':'本轮已记录用时'}：${elapsed.toLocaleString()} ms`}>用时 {duration}{elapsed!=null&&!d.stats?.durationComplete?'⁺':''}</small>
    <small className="ai-round-tokens" title={d.stats?.tokens==null?'未记录 token 用量':`${d.stats.tokens.toLocaleString()} tokens`}>{d.stats?.tokens==null?'— tokens':`${compactNumber(d.stats.tokens)} tokens`}</small>
    </summary>
    {d.status==='pending-continuation'&&<p className="hint">本轮达到运行时限，未完成事项会自动续办；已接受的指令保持有效。</p>}
    <p className="hint"><Text text={d.reasons?.length?`因为${d.reasons.map(notificationMessage).join('、')}，开始 AI 分析局势`:'开始 AI 分析局势（该历史轮次未记录触发原因）'}/></p>
    {d.incomingMessages?.map(message=><div className="ai-incoming-message" key={`${message.from}-${message.id}`}>
      <div className="ai-entry-heading"><span style={{color:colors[message.from]}}>{PLAYER_NAMES[message.from]??`玩家 ${message.from+1}`} · {message.to===null?'公开频道':Array.isArray(message.to)?'群聊':'私聊'}</span><small>新消息</small></div>
      <div className="ai-entry-summary" style={{color:colors[message.from]}}><Text text={message.text}/></div>
    </div>)}
    {conclusion&&<p className="ai-round-conclusion"><Text text={conclusion.summary}/></p>}
    {!!(conclusion?.arguments.memory||conclusion?.arguments.memoryEdits)&&<details><summary>本轮记忆更新</summary><pre><Text text={JSON.stringify({memory:conclusion.arguments.memory,memoryEdits:conclusion.arguments.memoryEdits},null,2)}/></pre></details>}
    {d.error&&<p role="alert">{d.error}</p>}
    {!!d.diagnostics?.length&&<details><summary>查看错误与重试诊断</summary><RawTimeLegend domain="wall"/><pre>{JSON.stringify(d.diagnostics,null,2)}</pre></details>}
    {!d.steps.length&&d.status!=='thinking'&&<p className="hint">本轮没有已记录的决策。</p>}
    {steps.map(step=><div className={`ai-decision-step ${step.status}`} key={step.id}>
      <div className="ai-entry-heading"><button type="button" className="ai-step-title" aria-expanded={!!expandedSteps[step.id]} aria-controls={`ai-step-${entry.id}-${step.id}`} onClick={()=>setExpandedSteps(current=>({...current,[step.id]:!current[step.id]}))}>{tools[step.tool]??step.tool}</button><small>{step.status==='partial'?'已停止 · 检查部分结果':step.status==='rejected'?'未执行':step.status==='unconfirmed'?'结果未确认':step.tool==='forecast'?'推演已返回':step.tool==='order'||step.tool==='schedule'?'指令已接受':'已完成'}</small></div>
      <div className="ai-entry-summary"><Text text={step.summary}/></div>
      {step.tool==='say'&&<>{!!step.arguments.intent&&<small>{diplomacyIntents[String(step.arguments.intent)]??String(step.arguments.intent)}</small>}{!!step.arguments.objective&&<p className="hint">目的：<Text text={String(step.arguments.objective)}/></p>}<blockquote><Text text={String(step.arguments.text??'')}/></blockquote></>}
      {step.status==='rejected'&&<p className="ai-rejection">{String((step.result as {error?:string})?.error??'请求被拒绝')}</p>}
      <div className="ai-step-detail" id={`ai-step-${entry.id}-${step.id}`} hidden={!expandedSteps[step.id]}>
        {step.tool==='remember'?Object.entries(step.arguments).map(([key,value])=><section key={key}><b>{{strategy:'战略计划',relations:'关系与依据',agreements:'协议与履约',deceptions:'真实意图'}[key]??key}</b><p className="ai-entry-summary"><Text text={String(value)}/></p></section>):<><ToolTimeSummary tool={step.tool} value={step.result}/><RawTimeLegend/><pre>{JSON.stringify({arguments:step.arguments,result:step.result,diagnostic:step.diagnostic},null,2)}</pre></>}
      </div>
    </div>)}
  </details>;
}
export function AiHistory({seat,close}:{seat:number;close:()=>void}){
  const [data,setData]=useState<History|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[pages,setPages]=useState<(number|undefined)[]>([undefined]),[refresh,setRefresh]=useState(0);
  const [showMemory,setShowMemory]=useState(false),[showRanking,setShowRanking]=useState(false);
  const before=pages.at(-1);
  useEffect(()=>{const controller=new AbortController();setBusy(true);setError('');fetch(`/api/ai/history?seat=${seat}${before===undefined?'':`&before=${before}`}${showRanking||showMemory?'&screening=1':''}`,{signal:controller.signal}).then(async r=>{const value=await r.json();if(!r.ok)throw Error(value.error??'无法读取日志');if(!controller.signal.aborted)setData(value);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();},[seat,before,refresh,showRanking,showMemory]);
  const agent=data?.agent;
  const strategyPlans=(agent?.notebook??[]).filter(n=>n.kind==='plan');
  const activeCampaigns=(data?.campaigns?.plans??[]).filter(p=>!['completed','cancelled'].includes(p.stage));
  const campaignText=(p:Campaign)=>[
    `目标：${p.target}`,
    `状态：${({assembling:'集结中',waiting:'待出发',underway:'航行中',holding:'守备中',review:'待复查'} as Record<string,string>)[p.stage]??p.stage}`,
    p.objective,
    p.holdPlan,
    p.cancelWhen?`调整或停止条件：${p.cancelWhen}`:'',
    `复查时间：${tickTime(p.reviewAtTick)}`,
    ...(p.issues??[]).map(issue=>`需关注：${issue}`),
  ].filter(Boolean).join('\n\n');
  const groupedNotes=new Set(strategyPlans.map(n=>n.id));
  const memorySections=Object.entries(agent?.memory??{}).map(([key,value])=>{
    const notes=(agent?.notebook??[]).filter(n=>key==='relations'?n.record?.type==='relation':key==='agreements'?n.kind==='agreement':false);
    for(const note of notes)groupedNotes.add(note.id);
    const text=[value,...notes.map(n=>n.record?.type==='relation'?`${PLAYER_NAMES[n.record.players[0]??-1]??'其他玩家'}：\n${n.text}`:n.text)].filter(v=>v.trim()).join('\n\n');
    return [key,text] as const;
  });
  const otherNotes=(agent?.notebook??[]).filter(n=>!groupedNotes.has(n.id));
  const memoryLabels:Record<string,string>={strategy:'战略计划',relations:'关系与依据',agreements:'协议与履约',deceptions:'真实意图与对外说法'};
  const strategyExport=`### 战略总纲\n\n${agent?.memory.strategy||'尚未记录'}\n\n### 各战线计划\n\n${strategyPlans.map((n,i)=>`#### 计划 ${i+1}\n\n${n.text}`).join('\n\n')||'暂无独立计划'}\n\n### 当前战役\n\n${activeCampaigns.map((p,i)=>`#### 战役 ${i+1}\n\n${campaignText(p)}`).join('\n\n')||'暂无进行中的战役'}`;
  const memoryExport=`# ${PLAYER_NAMES[seat]} · AI 备查记忆\n\n${memorySections.map(([key,text])=>`## ${memoryLabels[key]??key}\n\n${key==='strategy'?strategyExport:text||'尚未记录'}`).join('\n\n')}${otherNotes.map(n=>`\n\n## ${n.id}\n\n${n.text}`).join('')}`;
  return <aside className="utility-popover ai-history" aria-label="AI历史决策日志">
    <header className="popover-title"><b><Bot size={17}/> {PLAYER_NAMES[seat]} · AI 日志</b><div className="ai-history-actions"><button className="icon" aria-label="查看进攻排名" title="进攻排名" aria-pressed={showRanking} onClick={()=>{setShowRanking(v=>!v);setShowMemory(false);}}><ListOrdered size={16}/></button><button className="icon" disabled={!agent} aria-label="查看AI备查记忆" title="查看当前战略、关系、协议与真实意图" aria-pressed={showMemory} onClick={()=>{setShowMemory(v=>!v);setShowRanking(false);}}><NotebookText size={16}/></button><button className="icon" disabled={busy} onClick={()=>{setPages([undefined]);setRefresh(n=>n+1);}} title="刷新最新记录" aria-label="刷新AI日志"><RefreshCw size={14}/></button><button className="icon" onClick={close} aria-label="关闭AI日志"><X size={18}/></button></div></header>
    <div className="ai-history-status">{agent?<><span>{AI_PERSONALITIES[agent.settings.personality as keyof typeof AI_PERSONALITIES]?.label} · {agent.settings.model||'默认模型'}<span className="ai-history-usage" title={`${agent.tokens.toLocaleString()} tokens`}>{agent.calls} 次调用 · {compactNumber(agent.tokens)} tokens</span></span>{agent.error&&<span role="alert">{agent.error}</span>}</>:<span>{data?'当前席位为手动控制':'正在读取…'}</span>}</div>
    {error&&<p role="alert">{error}</p>}
    {!!data?.failure?.diagnostic&&<details><summary>查看当前错误原因</summary><RawTimeLegend domain="wall"/><pre>{JSON.stringify(data.failure.diagnostic,null,2)}</pre></details>}
    <DeferredIntel entries={data?.deferred??[]}/>
    <div className="ai-history-entries" tabIndex={0} aria-label={showRanking?'进攻排名内容':'AI日志内容'} aria-busy={busy}>
      {showRanking&&!busy&&<AttackRanking screening={data?.screening} campaigns={data?.campaigns}/>}
      {showMemory&&agent&&<div className="ai-memory"><a className="ai-memory-download" title="下载当前备查记忆 Markdown" download={`${PLAYER_NAMES[seat]}-AI记忆.md`} href={`data:text/markdown;charset=utf-8,${encodeURIComponent(memoryExport)}`}><Download size={14}/> 导出记忆</a>{memorySections.map(([key,value])=><section key={key}><h4>{memoryLabels[key]??key}</h4>{key==='strategy'?<div className="ai-strategy-content">
        <h5>战略总纲</h5><div className="ai-entry-summary"><Text text={value||'尚未记录'}/></div>
        <h5>各战线计划 · {strategyPlans.length}</h5>
        {strategyPlans.length?strategyPlans.map((note,i)=><article className="ai-strategy-item" key={note.id}><h6>计划 {i+1}</h6><div className="ai-entry-summary"><Text text={note.text}/></div>{note.expiresAt!==null&&<small>有效至 {tickTime(note.expiresAt/600)}</small>}</article>):<p className="hint">暂无独立计划</p>}
        <h5>当前战役 · {activeCampaigns.length}</h5>
        {activeCampaigns.length?activeCampaigns.map((p,i)=><article className="ai-strategy-item" key={p.id}><h6>战役 {i+1}</h6><div className="ai-entry-summary"><Text text={campaignText(p)}/></div></article>):<p className="hint">{busy?'正在读取战役…':'暂无进行中的战役'}</p>}
      </div>:<div className="ai-entry-summary"><Text text={value||'尚未记录'}/></div>}</section>)}</div>}
      {showMemory&&otherNotes.map(note=><section className="ai-memory" key={note.id}><h4>{note.id} · {{fact:'事实',plan:'计划',agreement:'协议',note:'笔记'}[note.kind]??note.kind}</h4><p className="ai-entry-summary"><Text text={note.text}/></p>{note.expiresAt!==null&&<small>有效至 {tickTime(note.expiresAt/600)}</small>}</section>)}
      {!showMemory&&!showRanking&&data?.entries.map((entry,index)=><DecisionCard key={`${data.roomId}-${data.seat}-${entry.id}`} entry={entry} latest={before===undefined&&index===0}/>)}
      {!showMemory&&!showRanking&&data&&!data.entries.length&&<p className="hint">该席位还没有 AI 决策记录。</p>}
    </div>
    {!showMemory&&!showRanking&&<footer><button disabled={busy||pages.length===1} onClick={()=>setPages(p=>p.slice(0,-1))}><ChevronLeft size={14}/>较新记录</button><span>第 {pages.length} 页</span><button disabled={busy||!data?.nextCursor} onClick={()=>setPages(p=>[...p,data!.nextCursor!])}>较早记录<ChevronRight size={14}/></button></footer>}
  </aside>;
}
