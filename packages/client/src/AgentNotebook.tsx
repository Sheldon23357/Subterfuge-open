import React,{useEffect,useRef,useState} from 'react';
import {BookOpen,Copy,Search,RefreshCw} from 'lucide-react';
import type {ConsoleRequest} from './AgentConnectionWizard.js';
import type {HybridSummaryData} from './HybridSummary.js';
import type {NotebookOverviewData} from './NotebookOverview.js';
import {NoteReadable,noteDetails,noteEntryTitle,type NoteEntry} from './NoteReadable.js';
import {diagnosticTimeSummary} from './DiagnosticTime.js';
import {notebookReadableText} from './notebook-display.js';
import {playerNames} from './theme.js';
import {hybridInstructionRows} from './hybrid-instructions.js';
import {NotebookIntentCards,NotebookAgreementCards,NotebookSettlementCards,notebookCurrentAgreements} from './NotebookOrders.js';
import {NotebookActionMemory,NotebookCommunicationMemory,NotebookDiscussionMemory,NotebookProgramMemory,notebookOpenOperations,type NotebookContextMemory} from './NotebookMemory.js';

export interface NotebookPage {
 generation:string;entries:NoteEntry[];nextCursor:number|null;
 overview?:NotebookOverviewData;hybrid?:HybridSummaryData;outpostNames?:Record<string,string>;contextMemory?:NotebookContextMemory;
}
type Source='notebook'|'reminders';
type Section='strategy'|'intents'|'actions'|'agreements'|'settlements'|'diplomacy'|'communication'|'discussion'|'notes'|'reminders'|'archive'|'storage';
export interface NotebookRecord {key:string;source:Source;entry:NoteEntry}
const sections:[Section,string][]=[['strategy','战略与指令'],['intents','作战意图'],['actions','行动与结果'],['diplomacy','外交判断'],['communication','外交往来'],['agreements','外交协议'],['settlements','协议结算与关系'],['discussion','指挥官讨论'],['notes','补充笔记'],['reminders','复查事项'],['archive','归档记录'],['storage','程序记忆与存储']];
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const priorityNames:Record<string,string>={high:'高优先级',medium:'中优先级',low:'低优先级'};
const agreementStatuses:Record<string,string>={none:'未成约',proposed:'提议中',negotiating:'协商中',confirmed:'已确认',fulfilled:'已履行',expired:'已到期',terminated:'已终止',violated:'已违约'};

export function mergeNotebookPages(current:NotebookPage,next:NotebookPage):NotebookPage {
 if(current.generation!==next.generation)throw Error('记录已更新，请刷新后重新载入。');
 const seen=new Set(current.entries.map(e=>e.id));
 return {...current,entries:[...current.entries,...next.entries.filter(e=>!seen.has(e.id))],nextCursor:next.nextCursor};
}
export function isProgramNote(entry:NoteEntry):boolean {
 const p=object(entry.payload);
 if(p.id!=='bot-plan'||typeof p.text!=='string')return false;
 try{return JSON.parse(p.text)?.format==='bot-plan/1';}catch{return false;}
}
export function notebookRecords(notes:NoteEntry[],reminders:NoteEntry[],reviewOn:string[]=[],version?:number):NotebookRecord[] {
 // Review conditions are a display projection of the directive, never persisted reminder events.
 return [...notes.map(entry=>({key:`notebook:${entry.id}`,source:'notebook' as const,entry})),...reviewOn.flatMap((text,index)=>text.trim()?[{key:`review:${index}`,source:'reminders' as const,entry:{id:`review:${index}`,kind:'strategy-review-condition',payload:{title:`战略复查条件 ${index+1}`,text,version}}}]:[]),...reminders.map(entry=>({key:`reminders:${entry.id}`,source:'reminders' as const,entry}))];
}
export interface NotebookDiplomacyRecord {conversation:string;summary:string;internalIntent:string;players?:number[];tick?:number;status?:string;source:'conversation'|'agreement'}
export function notebookDiplomacyRecords(state:HybridSummaryData['state']|undefined):NotebookDiplomacyRecord[]{
 const records=new Map<string,NotebookDiplomacyRecord>();
 for(const row of state?.directive?.agreements??[])records.set(row.conversation,{...row,source:'agreement'});
 for(const [conversation,row] of Object.entries(state?.conversations??{})){
  // Conversation judgments carry no authoritative protocol status or timestamp.
  records.set(conversation,{conversation,summary:row.summary,internalIntent:row.internalIntent,source:'conversation'});
 }
 return [...records.values()];
}
export function filterNotebookRecords(records:NotebookRecord[],section:Section,search:string,kind:string,names:Record<string,string>={}):NotebookRecord[] {
 const query=search.trim().toLocaleLowerCase();
 return records.filter(({entry,source})=>{
  if(isProgramNote(entry))return false;
  if(section==='archive'?!entry.archived:entry.archived||source!==(section==='reminders'?'reminders':'notebook'))return false;
  const p=noteDetails(entry),r=object(p.record);
  if(kind&&String(r.type??p.kind??p.category)!==kind)return false;
  return !query||notebookReadableText([noteEntryTitle(entry,source,names),p.text,p.note,p.summary,p.objective,p.holdPlan,p.cancelWhen,p.target,r.summary].filter(v=>typeof v==='string').join('\n'),names).toLocaleLowerCase().includes(query);
 });
}

/** Entity history can return empty scan pages with a cursor. Skip these within a bounded read. */
export async function readNotebookBatch(request:ConsoleRequest,id:string,source:Source,signal:AbortSignal,current?:NotebookPage):Promise<NotebookPage> {
 let result=current;
 for(let scan=0;scan<8&&!signal.aborted;scan++){
  const cursor=result?.nextCursor;
  if(result&&cursor===null)break;
  const next=await request<NotebookPage>(`debug/${source}?seat=${encodeURIComponent(id)}&scope=current&limit=50${result?`&before=${cursor}&generation=${encodeURIComponent(result.generation)}`:''}`,undefined,signal);
  if(result&&next.nextCursor!==null&&typeof cursor==='number'&&next.nextCursor>=cursor)throw Error('记录分页未前进，请刷新重试。');
  result=result?mergeNotebookPages(result,next):next;
  if(next.entries.length>0||result.nextCursor===null)break;
 }
 if(!result)throw Error('未取得笔记记录');
 return result;
}

function useNotebookPage(id:string,source:Source,request:ConsoleRequest,revision:number) {
 const [page,setPage]=useState<NotebookPage|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState('');
 const flight=useRef<AbortController|null>(null);
 const requestRef=useRef(request);requestRef.current=request;
 useEffect(()=>{
  const abort=new AbortController();flight.current=abort;setBusy(true);setError('');
  void readNotebookBatch(requestRef.current,id,source,abort.signal)
   .then(value=>{if(!abort.signal.aborted)setPage(value);})
   .catch(()=>{if(!abort.signal.aborted)setError('读取记录失败，请刷新重试。');})
   .finally(()=>{if(!abort.signal.aborted)setBusy(false);});
  return()=>flight.current?.abort();
 },[id,source,revision]);
 const loadMore=async()=>{
  if(busy||!page||page.nextCursor===null)return;
  const abort=new AbortController();flight.current?.abort();flight.current=abort;setBusy(true);setError('');
  try{
   const next=await readNotebookBatch(requestRef.current,id,source,abort.signal,page);
   if(!abort.signal.aborted)setPage(next);
  }catch(e){if(!abort.signal.aborted)setError(e instanceof Error&&e.message==='记录已更新，请刷新后重新载入。'?e.message:'载入旧记录失败，请重试。');}
  finally{if(!abort.signal.aborted)setBusy(false);}
 };
 return {page,busy,error,loadMore};
}

export function AgentNotebook({id,request,onNavigate}:{id:string;request:ConsoleRequest;onNavigate?:(tab:'live'|'logs')=>void}) {
 const [revision,setRevision]=useState(0);
 const notes=useNotebookPage(id,'notebook',request,revision),reminders=useNotebookPage(id,'reminders',request,revision);
 return <NotebookWorkspace notes={notes.page} reminders={reminders.page} busy={notes.busy||reminders.busy}
  errors={[notes.error,reminders.error].filter(Boolean)} onRefresh={()=>setRevision(v=>v+1)} onLoadNotes={()=>void notes.loadMore()} onLoadReminders={()=>void reminders.loadMore()} {...(onNavigate?{onNavigate}:{})}/>;
}

export function NotebookWorkspace({notes,reminders,busy,errors=[],onRefresh,onLoadNotes,onLoadReminders,onNavigate}:{
 notes:NotebookPage|null;reminders:NotebookPage|null;busy:boolean;errors?:string[];
 onRefresh:()=>void;onLoadNotes:()=>void;onLoadReminders:()=>void;onNavigate?:(tab:'live'|'logs')=>void;
}) {
 const [section,setSection]=useState<Section>('strategy'),[search,setSearch]=useState(''),[kind,setKind]=useState(''),[copyStatus,setCopyStatus]=useState('');
 const names=notes?.outpostNames??{},display=(text:string)=>notebookReadableText(text,names),overview=notes?.overview;
 const directive=notes?.hybrid?.state?.directive,agreements=notebookDiplomacyRecords(notes?.hybrid?.state);
 const records=notebookRecords(notes?.entries??[],reminders?.entries??[],directive?.reviewOn??[],directive?.version);
 const visible=filterNotebookRecords(records,section,search,kind,names);
 const hasRecords=['notes','reminders','archive'].includes(section);
 const program=records.filter(r=>isProgramNote(r.entry));
 const plans=program.flatMap(r=>{const p=object(r.entry.payload);try{return typeof p.text==='string'?[JSON.parse(p.text)]:[];}catch{return [];}});
 const diplomacy=agreements.map((entry,index)=>({entry,key:`${entry.conversation}:${entry.tick??index}`,title:entry.players?.length?entry.players.map(p=>playerNames[p]??`玩家 ${p+1}`).join('、'):entry.conversation==='public'?'公开会话':/^\d+$/.test(entry.conversation)?playerNames[Number(entry.conversation)]??`玩家 ${Number(entry.conversation)+1}`:entry.conversation})).filter(r=>!search.trim()||display([r.title,r.entry.summary,r.entry.internalIntent].join('\n')).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
 const counts:Partial<Record<Section,number|undefined>>={intents:notes?.hybrid?hybridInstructionRows(notes.hybrid).length:undefined,agreements:notebookCurrentAgreements(notes?.hybrid?.diplomacy)?.length,diplomacy:notes?agreements.length:undefined,notes:notes?filterNotebookRecords(records,'notes','','').length:undefined,reminders:notes&&reminders?filterNotebookRecords(records,'reminders','','').length:undefined,archive:notes&&reminders?records.filter(r=>r.entry.archived&&!isProgramNote(r.entry)).length:undefined,storage:notes?program.length:undefined};
 const canLoadNotes=notes?.nextCursor!=null,canLoadReminders=reminders?.nextCursor!=null;
 counts.actions=notes?.hybrid?notebookOpenOperations(notes.hybrid).length:undefined;
 counts.communication=notes?.hybrid?.state?(notes.hybrid.state.chat?.length??0)+notes.hybrid.state.messages.length+(notes.hybrid.state.contractCommands?.length??0):undefined;
 counts.settlements=notes?.hybrid?.diplomacy?notes.hybrid.diplomacy.agreements.filter(a=>!['active','proposed'].includes(a.status)).length:undefined;
 counts.discussion=notes?.contextMemory?.commander?.messages.length;
 const moreNotes=section==='notes'||section==='archive'||section==='storage',moreReminders=section==='reminders'||section==='archive';
 const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);setCopyStatus('已复制');}catch{setCopyStatus('复制失败，请检查剪贴板权限');}};
 const selectSection=(value:Section)=>{setSection(value);setSearch('');setKind('');setCopyStatus('');};
 const heading=sections.find(([key])=>key===section)![1];
 return <section className="agent-notebook" aria-label="笔记">
  <header className="notebook-toolbar"><div><h3>跨轮记忆</h3><span>{overview?.capacity?`笔记存储 ${overview.capacity.entries} / ${overview.capacity.entryLimit} 条（含程序记录）`:'跨轮认知记录'}</span></div><div className="notebook-toolbar-actions">{onNavigate&&<><button type="button" onClick={()=>onNavigate('live')}>实时运转</button><button type="button" onClick={()=>onNavigate('logs')}>调用日志</button></>}<button type="button" disabled={busy} onClick={onRefresh}><RefreshCw size={13} className={busy?'spinning':''}/>{busy?'读取中':'刷新'}</button></div></header>
  {[...new Set(errors)].map(error=><p className="error" role="alert" key={error}>{error}</p>)}
  <div className="notebook-workspace">
   <aside className="notebook-index"><nav className="notebook-sections" aria-label="笔记分类">{sections.map(([key,title])=><button type="button" key={key} aria-pressed={section===key} onClick={()=>selectSection(key)}><span>{title}</span>{counts[key]!==undefined&&<small title="已载入的记录数">{counts[key]}</small>}</button>)}</nav></aside>
   <div className="notebook-reader" key={section} aria-label={heading} aria-busy={busy}>
    {section!=='strategy'&&<div className="notebook-content-toolbar">
     <h3>{heading}{!['actions','settlements','storage'].includes(section)&&<small>{hasRecords?visible.length:section==='diplomacy'?diplomacy.length:counts[section]}</small>}</h3>
     {(hasRecords||section==='diplomacy')&&<div className="notebook-search"><Search size={14}/><input aria-label="搜索笔记标题或正文" placeholder="搜索标题或正文" value={search} onChange={e=>{setSearch(e.target.value);setCopyStatus('');}}/></div>}
     {!hasRecords&&section!=='diplomacy'&&notes?.hybrid?.guidance&&<span className="notebook-source">观察于第 {notes.hybrid.guidance.observedTick} tick</span>}
     {section==='notes'&&<select aria-label="笔记类型" value={kind} onChange={e=>setKind(e.target.value)}>{[['','全部类型'],['fact','事实'],['plan','计划'],['agreement','协议'],['note','备注']].map(([value,label])=><option value={value} key={value}>{label}</option>)}</select>}
    </div>}
    {section==='reminders'&&visible.some(r=>r.entry.kind==='strategy-review-condition')&&<p className="notebook-source">战略复查条件由模型保存，未设置定时触发，不表示相关事件已经发生。</p>}
    <div className="notebook-cards">
    {!notes&&busy?<NotebookEmpty text="读取跨轮记忆中…"/>:<>
    {section==='intents'&&<NotebookIntentCards value={notes?.hybrid} names={names}/>}
    {section==='agreements'&&<NotebookAgreementCards value={notes?.hybrid?.diplomacy} names={names}/>}
    {section==='actions'&&<NotebookActionMemory value={notes?.hybrid} context={notes?.contextMemory} names={names}/>}
    {section==='communication'&&<NotebookCommunicationMemory value={notes?.hybrid} names={names}/>}
    {section==='settlements'&&<NotebookSettlementCards value={notes?.hybrid?.diplomacy} names={names}/>}
    {section==='discussion'&&<NotebookDiscussionMemory context={notes?.contextMemory} names={names}/>}
    {section==='strategy'&&<>
     <section className="notebook-prose-section"><header><h3>战略判断</h3>{directive&&<span>发布版本 {directive.version}</span>}</header><p className="notebook-prose">{display(directive?.summary||overview?.memory.strategy||'')||(busy?'读取战略记录中…':'尚未保存模型战略判断')}</p></section>
     {overview?.memory.strategy&&overview.memory.strategy!==directive?.summary&&directive?.summary&&<section className="notebook-prose-section"><h3>补充战略记录</h3><p className="notebook-prose">{display(overview.memory.strategy)}</p></section>}
     <section className="notebook-prose-section"><header><h3>指挥官已确认指令</h3>{overview?.commanderDirectives&&<span>版本 {overview.commanderDirectives.version}</span>}</header><p className="notebook-prose">{display(overview?.commanderDirectives?.text??'')||(busy?'读取指令中…':'暂无已确认指令')}</p></section>
    </>}
    {section==='diplomacy'&&(diplomacy.length?diplomacy.map(({key,title,entry})=><article className="notebook-card" key={key} aria-label={title}>
     <header className="notebook-reader-heading"><h3>{title}</h3><button type="button" onClick={()=>void copy(display([entry.summary,entry.internalIntent].filter(Boolean).join('\n\n')))}><Copy size={13}/>复制正文</button></header>
     <section className="notebook-diplomacy-section"><h4>会话判断</h4><p className="notebook-prose">{display(entry.summary)||'未记录'}</p></section>
     <section className="notebook-diplomacy-section"><h4>内部意图</h4><p className="notebook-prose">{display(entry.internalIntent)||'未记录'}</p></section>
     <p className="notebook-source">{entry.source==='conversation'?'来源：已保存的外交会话判断':`保存时状态：${agreementStatuses[entry.status??'']??entry.status}`}{entry.tick!==undefined?` · 第 ${entry.tick} 天`:''}</p>
    </article>):<NotebookEmpty text={busy?'读取外交判断中…':search?'没有匹配的外交判断':'尚无保存的外交判断'}/>)}
    {hasRecords&&(visible.length?visible.map(r=>{const p=noteDetails(r.entry),title=noteEntryTitle(r.entry,r.source,names);return <article className="notebook-card" key={r.key} aria-label={title}>
     <header className="notebook-reader-heading"><h3>{title}</h3><button type="button" disabled={r.entry.unavailable} onClick={()=>void copy(display(String(p.text??p.note??p.summary??object(p.record).summary??'')))}><Copy size={13}/>复制正文</button></header>
     <p className="notebook-source">{r.entry.kind==='strategy-review-condition'?`来源：后台战略 · 发布版本 ${p.version??'未记录'}`:diagnosticTimeSummary(r.source,p).join(' · ')||'时间未记录'}{typeof p.priority==='string'?` · ${priorityNames[p.priority]??p.priority}`:''}{r.entry.archived?' · 归档内容':''}</p>
     {r.entry.kind==='strategy-review-condition'?<p className="notebook-prose">{display(String(p.text??''))}</p>:<NoteReadable entry={r.entry} source={r.source} names={names} heading={title}/>}
    </article>;}):<NotebookEmpty text={busy?'读取记录中…':search||kind?'没有匹配记录':section==='archive'?'暂无已载入的归档记录':section==='reminders'?'暂无已载入的复查事项':'暂无补充笔记；战略、外交判断与作战意图可在对应分类查看'}/>)}
    {section==='storage'&&<>
     <section className="notebook-prose-section"><h3>笔记容量</h3>{overview?.capacity?<dl className="notebook-storage-facts"><div><dt>存储条目（含程序）</dt><dd>{overview.capacity.entries} / {overview.capacity.entryLimit} 条</dd></div><div><dt>笔记正文</dt><dd>{overview.capacity.characters.toLocaleString()} / {overview.capacity.characterLimit.toLocaleString()} 字符</dd></div><div><dt>战略记录</dt><dd>{overview.capacity.strategyCharacters} / {overview.capacity.strategyLimit} 字符</dd></div></dl>:<p className="notebook-prose">容量未核实</p>}</section>
     <section className="notebook-prose-section"><h3>同轮工作资料</h3>{overview?.roundMaterials?.status==='active'?<><p className="notebook-prose">{overview.roundMaterials.protected} 项受保护回执 · {overview.roundMaterials.characters?.toLocaleString()} 字符</p><ul className="notebook-materials">{overview.roundMaterials.entries?.map(r=><li key={r.id}><b>{r.tool}</b><span>{r.characters.toLocaleString()} 字符</span><small>{r.id}</small></li>)}</ul></>:<p className="notebook-prose">{overview?.roundMaterials?.status==='none'?'当前没有待续接的整轮资料':'当前整轮资料未核实'}</p>}</section>
     <NotebookProgramMemory context={notes?.contextMemory} value={notes?.hybrid} plans={plans} names={names}/>
    </>}
    </>}
    </div>
    {(moreNotes&&canLoadNotes||moreReminders&&canLoadReminders)&&<footer className="notebook-content-footer"><span>还有旧记录未载入</span>{moreNotes&&canLoadNotes&&<button type="button" disabled={busy} onClick={onLoadNotes}>{section==='storage'?'载入更多程序记录':'载入更多笔记'}</button>}{moreReminders&&canLoadReminders&&<button type="button" disabled={busy} onClick={onLoadReminders}>载入更多定时提醒</button>}</footer>}
    {copyStatus&&<p className="notebook-copy-status" role="status">{copyStatus}</p>}
   </div>
  </div>
 </section>;
}
function NotebookEmpty({text}:{text:string}){return <div className="notebook-empty"><BookOpen size={25} strokeWidth={1.5}/><p>{text}</p></div>;}
