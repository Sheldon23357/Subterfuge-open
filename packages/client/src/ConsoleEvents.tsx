import React from 'react';
import {HybridModelCall} from './HybridModelCall.js';
import {DiagnosticTimeSummary,JournalToolTimeSummary} from './DiagnosticTime.js';
import {consoleEventLabel} from './agent-console-state.js';

export interface ConsoleEvent {id:number;kind:string;payload:unknown}
export function ConsoleEvents({entries,error,busy,older,hasEarlier,onLatest,onEarlier}:{entries:ConsoleEvent[];error:string;busy:boolean;older:boolean;hasEarlier:boolean;onLatest:()=>void;onEarlier:()=>void}){
 return <section className="console-event-panel" aria-label="执行记录" aria-busy={busy}>
  <div className="section-heading"><h3>执行记录 <span>{entries.length} 条</span></h3><div className="toolbar-actions"><button type="button" disabled={!older||busy} onClick={onLatest}>最新</button><button type="button" disabled={!hasEarlier||busy} onClick={onEarlier}>更早</button></div></div>
  {error&&<p className="error" role="alert">{error}</p>}
  {!entries.length&&!error&&<p className="diagnostic-caption">{busy?'读取执行记录中…':'暂无执行记录'}</p>}
  <ol className="console-event-list">{entries.map(e=>{
   const p=e.payload&&typeof e.payload==='object'&&!Array.isArray(e.payload)?e.payload as Record<string,unknown>:{};
   const summary=[p.summary,p.reason,p.message,p.error].find((v):v is string=>typeof v==='string'&&v.length>0);
   return <li key={e.id}><details><summary><span className="event-number">#{e.id}</span><b>{consoleEventLabel(e.kind)}</b>{typeof p.tool==='string'&&<code>{p.tool}</code>}{typeof p.sequence==='number'&&<span>{/^mode-hybrid-(task-|model-call|background-settled|usage)/.test(e.kind)?`调用 #${p.sequence}`:`第 ${p.sequence} 轮`}</span>}</summary>{e.kind==='mode-hybrid-model-call'&&<HybridModelCall value={p}/>} {summary&&<p className="event-prose">{summary}</p>}<DiagnosticTimeSummary domain="event" value={e.payload}/><JournalToolTimeSummary kind={e.kind} value={e.payload}/><details className="raw-record"><summary>原始记录</summary><pre tabIndex={0}>{JSON.stringify(e.payload,null,2)}</pre></details></details></li>;
  })}</ol>
 </section>;
}
