import React,{useEffect,useState} from 'react';

interface CheckpointStatus {busy:boolean;job:null|{id:string;name:string;status:string;error?:string;warning?:string};entries:{id:string;name:string;tick:number;createdAt:string}[]}
export function CheckpointPanel(){
 const [status,setStatus]=useState<CheckpointStatus|null>(null),[name,setName]=useState(''),[error,setError]=useState(''),[sending,setSending]=useState(false);
 useEffect(()=>{
  let stopped=false,pending=false;
  const poll=async()=>{if(pending)return;pending=true;try{const r=await fetch('/api/checkpoints');const data=await r.json();if(!r.ok)throw Error(data.error??'读取存档失败');if(!stopped){setStatus(data);setError('');}}catch(e){if(!stopped)setError(e instanceof Error?e.message:'读取存档失败');}finally{pending=false;}};
  void poll();const timer=setInterval(()=>void poll(),1000);return()=>{stopped=true;clearInterval(timer);};
 },[]);
 const save=async()=>{
  setSending(true);setError('');
  try{const r=await fetch('/api/checkpoints',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(name.trim()?{name:name.trim()}:{})});const data=await r.json();if(!r.ok)throw Error(data.error??'保存失败');setStatus(previous=>({...data,entries:previous?.entries??[]}));setName('');}
  catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setSending(false);}
 };
 const labels:Record<string,string>={waiting:'等待 AI 当前决策收尾…',saving:'正在保存游戏与 AI 数据…',completed:'联动存档已保存',failed:'联动存档保存失败'};
 return <div className="checkpoint-panel">
  <div className="checkpoint-controls">
   <input aria-label="阶段性存档名称" placeholder="存档名称（可选）" maxLength={80} value={name} disabled={sending||status?.busy} onChange={e=>setName(e.target.value)}/>
   <button disabled={!status||sending||status.busy} onClick={()=>void save()}>{sending||status?.busy?'保存中…':'保存阶段性存档'}</button>
  </div>
  {status?.job&&<p className="checkpoint-status" role="status">{status.job.name}：{labels[status.job.status]??status.job.status}</p>}
  {(error||status?.job?.error)&&<p role="alert">{error||status?.job?.error}</p>}
  {status?.job?.warning&&<p role="alert">{status.job.warning}</p>}
  {!!status?.entries.length&&<details className="checkpoint-list"><summary>已保存 {status.entries.length} 份</summary>{status.entries.map(entry=><p key={entry.id}>{entry.name} · 第 {entry.tick} 天 · {new Date(entry.createdAt).toLocaleString()}</p>)}</details>}
 </div>;
}
