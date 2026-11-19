import React,{useMemo,useState} from 'react';
import {isPromptRecord,isPromptTable,promptContextFields,promptContextModules,promptFieldLabel,promptValueHasContent,promptValueMatches,promptValueText} from './prompt-context.js';
function valueSummary(value:unknown){
 if(isPromptTable(value))return `${value.rows.length.toLocaleString()} 行`;
 if(Array.isArray(value))return `${value.length.toLocaleString()} 项`;
 if(isPromptRecord(value))return `${Object.values(value).filter(promptValueHasContent).length} 个字段`;
 if(typeof value==='string')return `${value.length.toLocaleString()} 字符`;
 return promptValueText(value);
}
function Disclosure({label,value,characters,initialOpen=false,children}:{label:string;value:unknown;characters?:number;initialOpen?:boolean;children:React.ReactNode}){
 const [open,setOpen]=useState(initialOpen);
 return <details className="context-disclosure" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
  <summary><b>{label}</b><span>{characters===undefined?valueSummary(value):`${characters.toLocaleString()} 字符`}</span></summary>
  {open&&<div className="context-disclosure-body">{children}</div>}
 </details>;
}
function ContextValue({value,query='',path=''}:{value:unknown;query?:string;path?:string}){
 if(isPromptRecord(value)){
  if(isPromptTable(value)){
   const columns=value.columns as string[],rows=value.rows as unknown[][];
   const visible=rows.filter(row=>promptValueMatches(row,query)||columns.some(c=>promptValueMatches('',query,c)));
   const metadata=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='columns'&&key!=='rows'));
   return <>{rows.length>0&&<div className="context-table" tabIndex={0} role="region" aria-label="上下文数据表"><table><thead><tr>{columns.map((column,i)=><th key={i} title={column}>{promptFieldLabel(column)}</th>)}</tr></thead><tbody>{visible.map((row,i)=><tr key={i}>{Array.from({length:Math.max(columns.length,row.length)},(_,j)=><td key={j}>{j<row.length?<ContextValue value={row[j]} path={`${path}.${i}.${j}`}/>:<span className="context-literal">未提供</span>}</td>)}</tr>)}</tbody></table></div>}{promptValueHasContent(metadata)&&<ContextValue value={metadata} query={query} path={path}/>}</>;
  }
  const entries=promptContextFields(value).filter(({keys,value:v})=>promptValueMatches(v,query,keys.join('.'))||keys.some(key=>promptValueMatches('',query,key)));
  return <div className="context-fields">{!Object.keys(value).length?<code>{'{}'}</code>:entries.map(({keys,value:v})=>{
   const key=keys.join('.'),label=keys.map(promptFieldLabel).join(' / '),childQuery=keys.some(k=>promptValueMatches('',query,k))?'':query;
   if(isPromptTable(v))return <section key={key} className="context-section"><header><b>{label}</b><span>{valueSummary(v)}</span></header><ContextValue value={v} query={childQuery} path={`${path}.${key}`}/></section>;
   const compound=Array.isArray(v)||isPromptRecord(v)||typeof v==='string'&&v.length>240;
   return compound?<Disclosure key={`${key}:${query}`} label={label} value={v} initialOpen={Boolean(query)}><ContextValue value={v} query={childQuery} path={`${path}.${key}`}/></Disclosure>:<dl className="context-field" key={key}><dt title={key}>{label}</dt><dd><ContextValue value={v} path={`${path}.${key}`}/></dd></dl>;
  })}</div>;
 }
 if(Array.isArray(value)){
  if(!value.length)return <code>[]</code>;
  return <ol className="context-array">{value.map((v,i)=>({v,i})).filter(({v})=>promptValueMatches(v,query)).map(({v,i})=><li key={i} value={i+1}><ContextValue value={v} query={query} path={`${path}.${i}`}/></li>)}</ol>;
 }
 if(typeof value==='string')return <div className="context-prose">{value||<code>""</code>}</div>;
 return <code className="context-literal">{promptValueText(value)}</code>;
}
export function PromptContext({text,search=''}:{text:string;search?:string}){
 const [mode,setMode]=useState<'modules'|'raw'>('modules');
 const modules=useMemo(()=>promptContextModules(text),[text]),query=search.trim();
 const populated=modules.filter(m=>promptValueHasContent(m.value));
 const visible=populated.filter(m=>promptValueMatches(m.value,query,m.label));
 const measured=modules.reduce((sum,m)=>sum+m.characters,0),body=modules.reduce((sum,m)=>sum+m.bodyCharacters,0);
 return <section className="prompt-context" aria-label="调用上下文组成">
  <div className="context-view-toolbar"><div role="group" aria-label="上下文展示方式"><button type="button" aria-pressed={mode==='modules'} onClick={()=>setMode('modules')}>模块</button><button type="button" aria-pressed={mode==='raw'} onClick={()=>setMode('raw')}>原文</button></div><span>{query?`${visible.length} / `:''}{populated.length} 个模块 · {text.length.toLocaleString()} 字符</span></div>
  <p className="context-measurement" title="按原文 UTF-16 长度计数，包含分段标记和换行；格式化缩进不计入原文长度。">正文 {body.toLocaleString()} + 标记与分隔 {Number(text.length-body).toLocaleString()} = 原文 {measured.toLocaleString()} 字符</p>
  {mode==='raw'?<pre tabIndex={0}>{search?text.split('\n').filter(line=>line.toLocaleLowerCase().includes(search.toLocaleLowerCase())).join('\n')||'无匹配内容':text}</pre>:<div className="context-modules">{visible.map(m=><div key={`${m.key}:${query}`} data-source-start={m.start} data-source-end={m.end}><Disclosure label={m.label} value={m.value} characters={m.characters} initialOpen={Boolean(query)}><ContextValue value={m.value} query={promptValueMatches('',query,m.label)?'':query} path={m.key}/><details className="context-module-source"><summary>本段原文（含标记）</summary><pre tabIndex={0}>{m.source}</pre></details></Disclosure></div>)}{!visible.length&&<p className="muted">无匹配内容</p>}</div>}
 </section>;
}
