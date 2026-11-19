import React from 'react';
import {diagnosticTimeSummary} from './DiagnosticTime.js';
import {notebookReadableText} from './notebook-display.js';

export interface NoteEntry {id:number|string;kind:string;payload:unknown;unavailable?:boolean;archived?:boolean;archiveReason?:string}
type Source='notebook'|'reminders'|'campaigns';
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const strings=(v:unknown):string[]=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'):[];
export const noteValues:Record<string,string>={unknown:'未知',neutral:'中立',negotiating:'谈判中',cooperating:'合作中',ceasefire:'停火',hostile:'敌对',proposed:'已提议',candidate:'候选',blocked:'受阻',fulfilled:'已履行',expired:'已过期',rejected:'已拒绝',revoked:'已撤销',breached:'已违约',abandoned:'已放弃',superseded:'已替代',relation:'关系',fact:'事实',plan:'计划',agreement:'协议',note:'备注',observed:'亲见',reported:'他人报告',predicted:'条件预测',inferred:'推断',decision:'决定',active:'进行中',assembling:'集结中',waiting:'等待出发',underway:'执行中',holding:'占领中',review:'待复查',completed:'已完成',cancelled:'已取消',military:'军事',strategy:'战略',diplomacy:'外交',reminder:'提醒','notebook-set':'笔记已更新','notebook-removed':'笔记已移除','reminder-set':'提醒已设置','reminder-cancelled':'提醒已取消','reminder-fired':'提醒已触发','campaign-state':'战役状态'};
const label=(v:unknown)=>typeof v==='string'?(noteValues[v]??v):'';
export function noteDetails(entry:NoteEntry):Record<string,unknown>{
 const payload=object(entry.payload),p=Object.keys(object(payload.details)).length?object(payload.details):payload;
 if(p.id==='bot-plan'&&typeof p.text==='string')try{
  const saved=JSON.parse(p.text);
  if(saved?.format==='bot-plan/1'&&Array.isArray(saved.targets))return {...p,title:'行动计划',
   text:`第${saved.atTick}天保存；${saved.targets.length?`相关目标：${saved.targets.filter((id:unknown)=>typeof id==='string').join('、')}`:'维持已有行动'}。`,entities:saved.targets};
 }catch{/* Keep malformed notes readable as their original text. */}
 return p;
}
export function noteEntryTitle(entry:NoteEntry,source:Source,names:Record<string,string>={}):string{
 const p=noteDetails(entry),r=object(p.record),title=[p.title,p.name,r.summary,p.summary,p.objective].find(v=>typeof v==='string'&&v.trim());
 if(source==='campaigns'&&typeof p.target==='string')return notebookReadableText(`${names[p.target]??p.target} · ${typeof p.objective==='string'?p.objective:'战役计划'}`,names);
 if(typeof title==='string')return notebookReadableText(title,names);
 if(Array.isArray(p.plans))return `战役概览 · ${p.plans.length} 项`;
 return source==='campaigns'?'战役计划':source==='reminders'?`${label(p.category)||''}提醒`:label(r.type??p.kind)?`${label(r.type??p.kind)}记录`:'笔记';
}
/** Player-facing projection only; the original payload is retained in the disclosure. */
export function NoteReadable({entry,source,names={},raw=true,heading}:{entry:NoteEntry;source:Source;names?:Record<string,string>;raw?:boolean;heading?:string}){
 const p=noteDetails(entry),r=object(p.record),display=(v:unknown)=>notebookReadableText(String(v),names);
 const text=[p.text,p.note,p.summary].find(v=>typeof v==='string'&&v.trim());
 const summary=typeof r.summary==='string'?r.summary:null;
 const status=entry.kind==='notebook-removed'?'已移除':entry.kind==='reminder-cancelled'?'已取消':entry.kind==='reminder-fired'?'已触发':entry.kind==='reminder-set'?'待处理':label(r.status??p.stage??p.status);
 const kind=label(r.type??p.kind??p.category);
 const players=Array.isArray(r.players??p.players)?(r.players??p.players) as unknown[]:[];
 const entities=strings(r.entities??p.entities),links=strings(r.links??p.links),evidence=strings(r.evidence??p.evidence);
 const accounted=strings(p.accountedFleets),committed=strings(p.committedOrders),comparison=object(p.comparison);
 const issues=strings(p.issues),allocations=Array.isArray(p.allocations)?p.allocations.map(object):[],defense=Array.isArray(p.defenseOverrides)?p.defenseOverrides.map(object):[];
 const movement=object(p.movement),scores=object(r.scores??p.scores),hasReferences=links.length+evidence.length+accounted.length+committed.length>0||Object.keys(comparison).length>0;
 const rows:[string,unknown][]=[['目标',p.target],['目标意图',p.objective],['占领后安排',p.holdPlan],['取消或调整条件',p.cancelWhen]];
 return <div className="note-readable">
  <div className="note-badges">{kind&&<span className="note-kind">{kind}</span>}{status&&<span className="note-status">{status}</span>}{typeof p.basis==='string'&&<span className="note-basis">{label(p.basis)}</span>}</div>
  {summary&&summary!==text&&display(summary)!==heading&&<p className="note-lead">{display(summary)}</p>}
  {typeof text==='string'&&display(text)!==heading&&<p className="note-body">{display(text)}</p>}
  <dl className="note-main-fields">{rows.filter(([,v])=>typeof v==='string'&&v.trim()&&display(names[String(v)]??v)!==heading&&!heading?.startsWith(display(names[String(v)]??v)+' · ')&&!heading?.endsWith(' · '+display(names[String(v)]??v))).map(([k,v])=><React.Fragment key={k}><dt>{k}</dt><dd>{display(names[String(v)]??v)}</dd></React.Fragment>)}
   {!!players.length&&<><dt>相关玩家</dt><dd>{players.map(p=>typeof p==='number'?`席位 ${p+1}`:display(p)).join('、')}</dd></>}
   {!!entities.length&&<><dt>相关对象</dt><dd>{entities.map(id=>display(names[id]??id)).join('、')}</dd></>}
   {['waiting','moving'].some(k=>typeof movement[k]==='number')&&<><dt>当前调动</dt><dd>{typeof movement.waiting==='number'?`等待出发 ${movement.waiting} 支`:''}{typeof movement.waiting==='number'&&typeof movement.moving==='number'?' · ':''}{typeof movement.moving==='number'?`行进中 ${movement.moving} 支`:''}</dd></>}
  </dl>
  {!!issues.length&&<section className="note-attention"><h4>需要处理</h4><ul>{issues.map((s,i)=><li key={i}>{display(s)}</li>)}</ul></section>}
  {p.comparisonInvalidated===true&&<p className="note-attention">原比较方案已失效，需要重新核对。</p>}
  {!!allocations.length&&<section className="note-section"><h4>剩余兵力预留</h4><div className="diagnostic-table note-allocation-table"><table><thead><tr><th>来源</th><th>预留兵力</th></tr></thead><tbody>{allocations.map((a,i)=><tr key={i}><td>{display(names[String(a.source)]??a.source??'未知来源')}</td><td>{typeof a.drillers==='number'?a.drillers:'未知'}</td></tr>)}</tbody></table></div></section>}
  {!!defense.length&&<section className="note-section"><h4>来源守备安排</h4>{defense.map((a,i)=><p className="note-body" key={i}>{display(names[String(a.source)]??a.source??'未知来源')}：保留 {typeof a.retainDrillers==='number'?a.retainDrillers:'未知'} 兵{typeof a.reason==='string'?`；${display(a.reason)}`:''}</p>)}</section>}
  {!!Object.keys(scores).length&&<section className="note-section"><h4>关系评估</h4><dl className="note-scores">{Object.entries({trust:'信任',hostility:'敌意',threat:'威胁',cooperation:'合作',confidence:'把握度'}).map(([key,name])=><React.Fragment key={key}><dt>{name}</dt><dd>{typeof scores[key]==='number'?String(scores[key]):'未知'}</dd></React.Fragment>)}</dl></section>}
  {hasReferences&&<details className="note-references"><summary>关联与依据{evidence.length?` · ${evidence.length} 条依据`:''}{committed.length?` · ${committed.length} 项执行关联`:''}</summary>
   {!!links.length&&<p className="note-body">关联记录：{links.map(display).join('、')}</p>}
   {!!evidence.length&&<ul>{evidence.map((s,i)=><li key={i}>{display(s)}</li>)}</ul>}
   {(accounted.length>0||committed.length>0)&&<p className="muted">已记账身份 {accounted.length} 项 · 执行关联 {committed.length} 项</p>}
   {!!Object.keys(comparison).length&&<p className="muted">已关联比较方案。</p>}
  </details>}
  {Array.isArray(p.plans)&&p.plans.map((plan,i)=><section className="note-subitems" key={i}><h4>{noteEntryTitle({id:i,kind:'',payload:plan},'campaigns',names)}</h4><NoteReadable entry={{id:i,kind:'',payload:plan}} source="campaigns" names={names} raw={false}/></section>)}
  {entry.unavailable?<p className="muted">该条目的完整内容未记录。</p>:raw&&<details className="note-raw"><summary>原始数据</summary><pre tabIndex={0}>{JSON.stringify(entry.payload,null,2)}</pre></details>}
 </div>;
}


export function NoteCard({entry,source,names={}}:{entry:NoteEntry;source:Source;names?:Record<string,string>}){
 const p=noteDetails(entry),record=object(p.record),title=noteEntryTitle(entry,source,names);
 const savedStatus=label(record.status??p.stage??p.status);
 const status=entry.unavailable?'未记录':entry.archived?(entry.archiveReason==='expired'?'已过期':savedStatus||'已归档'):entry.kind==='reminder-fired'?'已触发':entry.kind==='reminder-cancelled'?'已取消':entry.kind==='notebook-removed'?'已移除':savedStatus||(source==='reminders'?'待处理':'已保存');
 const priority=typeof p.priority==='string'?({high:'高',medium:'中',low:'低'}[p.priority]??p.priority):'';
 const kind=(label(record.type??p.kind??p.category)||(source==='campaigns'?'战役':source==='reminders'?'提醒':'笔记'))+(priority?` · ${priority}等级`:'');
 const preview=[p.text,p.holdPlan,p.note,p.summary,record.summary].find(v=>typeof v==='string'&&v.trim()&&notebookReadableText(v,names)!==title);
 const times=diagnosticTimeSummary(source,p).join(' · '),issues=strings(p.issues);
 return <details className="note-card">
  <summary><span className="note-card-top"><span className="note-card-kind">{kind}</span><span className="note-card-status">{status}</span></span><b className="note-card-title">{title}</b>{typeof preview==='string'&&<span className="note-card-preview">{notebookReadableText(preview,names)}</span>}{times&&<span className="note-card-time">{times}</span>}<span className="note-card-footer">{issues.length>0&&<span className="note-card-warning">待处理 {issues.length} 项</span>}<span className="note-card-action">查看详情</span></span></summary>
  <NoteReadable entry={entry} source={source} names={names} heading={title}/>
 </details>;
}
