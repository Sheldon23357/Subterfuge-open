import React,{useState} from 'react';
import type {DiagnosticStatistics} from './agent-statistics.js';
type Usage=NonNullable<DiagnosticStatistics['toolUsage']>;
export function ToolUsageBars({bucket,labels={}}:{bucket:Usage['all'];labels?:Record<string,string>}){
 const rows=Object.entries(bucket.counts).filter(([,n])=>Number.isSafeInteger(n)&&n>0).sort(([a,x],[b,y])=>y-x||a.localeCompare(b));
 const max=rows[0]?.[1]??1;
 const label=(tool:string)=>Object.hasOwn(labels,tool)?labels[tool]:undefined;
 return rows.length?<ul className="tool-usage-bars" aria-label="各工具调用次数">{rows.map(([tool,count])=><li key={tool} title={`${tool}：${count.toLocaleString()} 次，占 ${bucket.total?(count/bucket.total*100).toFixed(1):'0.0'}%`}>
  <div className="tool-usage-label"><span>{label(tool)??tool}{label(tool)&&<code>{tool}</code>}</span><strong>{count.toLocaleString()}<small> 次</small></strong></div>
  <div className="tool-usage-track" aria-hidden="true"><span style={{width:`${count/max*100}%`}}/></div>
 </li>)}</ul>:<div className="chart-empty">此范围暂无工具调用</div>;
}
export function ToolUsageChart({usage,labels={}}:{usage:DiagnosticStatistics['toolUsage'];labels?:Record<string,string>}){
 const [range,setRange]=useState<'all'|'recent'>('all');
 const bucket=usage?.[range];
 return <section className="tool-usage-chart" aria-label="工具调用次数统计">
  <div className="chart-heading"><h3>工具调用次数</h3><div className="tool-usage-range" role="group" aria-label="工具统计范围"><button type="button" aria-pressed={range==='all'} onClick={()=>setRange('all')}>全部</button><button type="button" aria-pressed={range==='recent'} onClick={()=>setRange('recent')}>最近50轮</button></div></div>
  {bucket?<><p className="tool-usage-summary">{range==='recent'?`最近 ${usage!.recentRounds.length} 轮`:'全部记录'} · {bucket.total.toLocaleString()} 次请求</p><ToolUsageBars bucket={bucket} labels={labels}/></>:<div className="chart-empty">暂无工具统计数据</div>}
  <p className="tool-usage-caption">batch、queries 各计一次请求。{usage&&usage.unassigned>0?` ${usage.unassigned.toLocaleString()} 次历史请求未关联轮次，仅计入全部。`:''}</p>
 </section>;
}
