import React,{useEffect,useState} from 'react';
import {tickTimeIntervals,type TickTimeAnchor,type TickTimeInterval} from '../../contracts/src/index.js';
import type {ConsoleRequest} from './AgentConnectionWizard.js';
import {StatisticsLineChart} from './StatisticsLineChart.js';

const statusLabels:Record<TickTimeInterval['status'],string>={complete:'完整记录','partial-start':'起点记录不完整',batch:'批量推进，未拆分单 tick','clock-adjusted':'系统时钟调整'};
const seconds=(ms:number)=>(ms/1000).toLocaleString(undefined,{maximumFractionDigits:2})+' s';
export function TickTimeLine({records}:{records:TickTimeAnchor[]}){
 const [end,setEnd]=useState<number|null>(null);
 const intervals=tickTimeIntervals(records),stop=Math.min(end??intervals.length,intervals.length),visible=intervals.slice(Math.max(0,stop-50),stop);
 const duration=(r:TickTimeInterval)=>Math.max(0,r.monotonicElapsedMs??r.wallElapsedMs);
 return <>
  <div className="chart-heading"><h3>每 tick 运行时间</h3><div className="toolbar-actions"><button disabled={stop<=50} onClick={()=>setEnd(Math.max(50,stop-50))}>更早</button><button disabled={stop>=intervals.length} onClick={()=>setEnd(Math.min(intervals.length,stop+50))}>更新</button><button disabled={end===null} onClick={()=>setEnd(null)}>最新</button></div></div>
  {!visible.length?<div className="chart-empty">尚无已结束的 tick 耗时记录</div>:<StatisticsLineChart
   label="每 tick 实际耗时折线图" labels={visible.map(r=>String(r.tick))} pointLabels={visible.map(r=>`Tick ${r.tick} → ${r.nextTick}`)}
   details={visible.map(r=>statusLabels[r.status])} flagged={visible.map(r=>r.status!=='complete')}
   series={[{id:'tick-duration',label:'耗时 · 秒',axis:'left',color:'#8bcfc7',minimumMax:1000,fill:true,values:visible.map(duration),format:seconds}]}/>}
 </>;
}
export function TickTimeChart({id,request,revision}:{id:string;request:ConsoleRequest;revision:number}){
 const [records,setRecords]=useState<TickTimeAnchor[]>([]),[state,setState]=useState('读取 tick 耗时中…');
 useEffect(()=>{
  const abort=new AbortController();setRecords([]);setState('读取 tick 耗时中…');
  void(async()=>{
   let after=0,roomId:string|undefined;const all:TickTimeAnchor[]=[];
   do{
    const page=await request<{available:boolean;roomId?:string;records:TickTimeAnchor[];nextCursor:number;hasMore:boolean}>(`tick-times?seat=${encodeURIComponent(id)}&after=${after}`,undefined,abort.signal);
    if(abort.signal.aborted)return;
    if(!page.available){setState('服务器未提供 tick 计时接口。');return;}
    if(roomId!==undefined&&roomId!==page.roomId)throw Error('Room changed');roomId=page.roomId;
    all.push(...page.records);
    if(!page.hasMore)break;
    if(page.nextCursor<=after)throw Error('Invalid cursor');after=page.nextCursor;
   }while(!abort.signal.aborted);
   if(!abort.signal.aborted){setRecords(all);setState('');}
  })().catch(()=>{if(!abort.signal.aborted)setState('tick 耗时暂不可用，请刷新重试。');});
  return()=>abort.abort();
 },[id,revision]);
 return <section className="tick-time-chart" aria-label="服务器 tick 耗时">{state?<><h3>每 tick 运行时间</h3><p role="status" className="diagnostic-caption">{state}</p></>:<TickTimeLine records={records}/>}</section>;
}
