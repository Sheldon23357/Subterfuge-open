import React,{useEffect,useRef,useState} from 'react';
import type {ConsoleRequest} from './AgentConnectionWizard.js';
import {callDisplayState,type DiagnosticCall} from './AgentCallList.js';
import {StatisticsLineChart} from './StatisticsLineChart.js';

interface CallPage {generation:string;entries:DiagnosticCall[]}
const measured=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const count=(value:number|null)=>value===null?'未知':value.toLocaleString('zh-CN',{maximumFractionDigits:1});
const seconds=(value:number|null)=>value===null?'未知':`${(value/1000).toLocaleString('zh-CN',{maximumFractionDigits:2})} 秒`;
const compact=(value:number)=>new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(value);
function contextCharacters(call:DiagnosticCall){
 const length=measured(call.prompt.characters);
 return length===0&&!call.prompt.available?null:length;
}
export function recentAiCalls(automatic:DiagnosticCall[],commander:DiagnosticCall[]):DiagnosticCall[]{
 return [...new Map([...automatic,...commander].map(call=>[call.callRef,call])).values()].sort((a,b)=>b.callRef-a.callRef).slice(0,50).reverse();
}
export function recentCallSummary(calls:DiagnosticCall[]){
 const summarize=(values:(number|null)[])=>{const known=values.filter((value):value is number=>value!==null);return {known:known.length,average:known.length?known.reduce((sum,n)=>sum+n,0)/known.length:null,max:known.length?Math.max(...known):null};};
 return {context:summarize(calls.map(contextCharacters)),duration:summarize(calls.map(c=>measured(c.durationMs)))};
}
function callKind(call:DiagnosticCall){
 if(call.lane==='commander')return call.mode==='reconcile'?'策略整理':'指挥官讨论';
 if(call.lane==='strategy')return ({strategy:'战略规划',diplomacy:'外交谈判',commander:'指令转译'} as Record<string,string>)[call.mode??'']??'后台调用';
 return '自动决策';
}
export async function loadRecentAiCalls(id:string,request:ConsoleRequest,signal:AbortSignal){
 const pages=await Promise.allSettled(['calls','commander-calls'].map(source=>request<CallPage>(`debug/${source}?seat=${encodeURIComponent(id)}&limit=50`,undefined,signal)));
 const automatic=pages[0],commander=pages[1];
 if(automatic?.status!=='fulfilled'||commander?.status!=='fulfilled')throw Error('最近调用统计暂不可用，请刷新重试。');
 if(automatic.value.generation!==commander.value.generation)throw Error('调用记录已更新，请刷新统计。');
 return recentAiCalls(automatic.value.entries,commander.value.entries);
}
export function RecentAiCalls({id,request,revision}:{id:string;request:ConsoleRequest;revision:number}){
 const [calls,setCalls]=useState<DiagnosticCall[]>([]),[busy,setBusy]=useState(true),[error,setError]=useState('');
 const requestRef=useRef(request);requestRef.current=request;
 useEffect(()=>{
  const abort=new AbortController();setBusy(true);setError('');
  void loadRecentAiCalls(id,requestRef.current,abort.signal).then(value=>{if(!abort.signal.aborted)setCalls(value);})
   .catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'最近调用统计暂不可用。');})
   .finally(()=>{if(!abort.signal.aborted)setBusy(false);});
  return()=>abort.abort();
 },[id,revision]);
 return <RecentAiCallCharts calls={calls} busy={busy} error={error}/>;
}
export function RecentAiCallCharts({calls,busy=false,error=''}:{calls:DiagnosticCall[];busy?:boolean;error?:string}){
 const visible=recentAiCalls(calls,[]);
 return <section className="recent-ai-calls" aria-label="最近50次AI调用统计" aria-busy={busy}>
  <header className="chart-heading"><h3>AI 调用分析</h3><span>最近 {visible.length} 次{busy?' · 读取中':''}</span></header>
  {error&&<p className="error" role="alert">{error}</p>}
  {!visible.length?<div className="chart-empty">{busy?'读取调用统计中…':error?'尚未取得调用统计':'暂无 AI 调用记录'}</div>:<>
   <StatisticsLineChart label="最近50次AI调用上下文长度与总耗时双坐标轴折线图"
    labels={visible.map(call=>`#${call.callRef}`)} pointLabels={visible.map(call=>`#${call.callRef} · ${callKind(call)}`)}
    details={visible.map(call=>callDisplayState(call).label)}
    series={[
     {id:'context',label:'上下文长度 · 字符',axis:'left',color:'#8bcfc7',values:visible.map(contextCharacters),format:compact,formatDetail:value=>count(value)+' 字符'},
     {id:'duration',label:'调用总耗时 · 秒',axis:'right',color:'#a5b9dd',minimumMax:1000,values:visible.map(call=>measured(call.durationMs)),format:seconds},
    ]}/>
   <details className="recent-call-details"><summary>逐次明细 · {visible.length} 次</summary><div className="diagnostic-table"><table><thead><tr><th scope="col">调用</th><th scope="col">类型</th><th scope="col">开始时间</th><th scope="col">上下文字符</th><th scope="col">输入 Token</th><th scope="col">总耗时</th><th scope="col">模型耗时</th><th scope="col">排队耗时</th><th scope="col">状态</th></tr></thead><tbody>{[...visible].reverse().map(call=><tr key={call.callRef}><th scope="row">#{call.callRef}</th><td>{callKind(call)}</td><td>{call.startedAt===null?'未知':new Date(call.startedAt).toLocaleString('zh-CN',{hour12:false})}</td><td>{count(contextCharacters(call))}</td><td>{count(measured(call.usage.inputTokens))}</td><td>{seconds(measured(call.durationMs))}</td><td>{seconds(measured(call.providerDurationMs))}</td><td>{seconds(measured(call.queueWaitMs))}</td><td>{callDisplayState(call).label}</td></tr>)}</tbody></table></div></details>
  </>}
 </section>;
}
