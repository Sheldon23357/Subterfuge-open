import React,{useEffect,useRef,useState} from 'react';
import {ChevronDown,ChevronUp,Send,X,MessageCircle,MapPin,ChevronsUp,ChevronsDown,LoaderCircle} from 'lucide-react';
import type {CommanderMessage,CommanderReference,CommanderThread} from '../../contracts/src/index.js';
import {ChatMessageText} from './ChatMessageText.js';
import {addCommanderReference,canConfirmCommanderProposal,commanderFriendlyError,commanderReferenceKey,commanderRequestId,commanderSnapshotIsCurrent,commanderDirectiveChanges,commanderKeyboardViewport,commanderDockAnchor,commanderChronologicalMessages,validateCommanderThread,type CommanderAction,type CommanderTransport} from './commander-chat-model.js';

export interface CommanderReferenceTarget {label:string;locatable:boolean}
export interface CommanderChatProps {
  roomId:string;player:number;request:CommanderTransport;
  referenceRequest?:{reference:CommanderReference;nonce:number}|null;
  resolveReference:(reference:CommanderReference)=>CommanderReferenceTarget;
  locate:(reference:CommanderReference)=>void;
}
export function CommanderMessageBubble({message,version,directives,confirming,confirm,resolveReference,locate}:{
 message:CommanderMessage;version:number;directives:string;confirming:string|null;confirm:(id:string,version:number)=>void;
 resolveReference:CommanderChatProps['resolveReference'];locate:CommanderChatProps['locate'];
}){
 const [expanded,setExpanded]=useState(false),proposal=message.proposal;
 const changes=proposal&&canConfirmCommanderProposal(proposal,version)?commanderDirectiveChanges(directives,proposal.text):null;
 const layoutOnlyChange=!!(changes&&!changes.removed.length&&!changes.added.length&&proposal?.text!==directives);
 const long=message.text.length>240,text=long&&!expanded?message.text.slice(0,240)+'…':message.text;
 return <article className={`commander-message commander-message-${message.role}`} aria-label={message.role==='player'?'我的消息':message.role==='assistant'?'AI 回复':'进展反馈'}>
  <span className="commander-avatar" aria-hidden="true">{message.role==='assistant'?<img src="/assets/commander/naval-commander.png" alt="" draggable={false}/>:message.role==='player'?'我':'AI'}</span>
  <div className="commander-bubble">
   <div className="commander-message-author">{message.role==='player'?'司令':message.role==='assistant'?'指挥官':'进展反馈'}<small>第 {Math.round(message.tick*10)/10} 天</small></div>
   <p><ChatMessageText text={text} ai={message.role!=='player'}/></p>
   {long&&<button type="button" className="commander-text-button" onClick={()=>setExpanded(!expanded)}>{expanded?'收起':'展开回复'}</button>}
   {message.references.length>0&&<div className="commander-references">{message.references.map(reference=>{const target=resolveReference(reference);return <button type="button" key={commanderReferenceKey(reference)} disabled={!target.locatable} title={target.locatable?'在当前地图定位':'当前无法定位，不显示未知情报'} onClick={()=>locate(reference)}><MapPin size={12}/>{reference.label??target.label}{!target.locatable&&<small> · 暂不可见</small>}</button>;})}</div>}
   {message.status==='queued'&&<small className="commander-queued">已发送，等待参谋回复</small>}
   {message.status==='failed'&&message.replyTo&&<small className="commander-queued">这次讨论未完成，可稍后重试。</small>}
   {proposal&&<section className="commander-proposal" aria-label="待确认的指挥官指令">
    <strong>{proposal.status==='confirmed'?'已融入指挥官指令':proposal.status==='superseded'?'这份方案已过期':'我想这样调整'}</strong>
    {proposal.summary.trim()!==message.text.trim()&&<p><ChatMessageText text={proposal.summary} ai/></p>}
    {changes&&<div className="commander-directive-changes">{changes.removed.length>0&&<div className="commander-removed"><b>将移除或替换的原指示</b><ul>{changes.removed.map((line,index)=><li key={index}><ChatMessageText text={line} ai/></li>)}</ul></div>}{changes.added.length>0&&<div className="commander-added"><b>将加入的指示</b><ul>{changes.added.map((line,index)=><li key={index}><ChatMessageText text={line} ai/></li>)}</ul></div>}{!changes.removed.length&&!changes.added.length&&<small>{layoutOnlyChange?'检测到排列或格式变化，请核对下方完整指示。':'指挥官指令内容保持不变。'}</small>}</div>}
    <details open={layoutOnlyChange}><summary>确认后的完整指示</summary><p className="commander-directive-preview"><ChatMessageText text={proposal.text||'清除现有指挥官指令'} ai/></p></details>
    {canConfirmCommanderProposal(proposal,version)&&<small>确认只更新指挥官指令，不代表已出兵或执行。</small>}
    {canConfirmCommanderProposal(proposal,version)?<button type="button" className="commander-confirm" disabled={confirming!==null} onClick={()=>confirm(proposal.id,proposal.baseVersion)}>{confirming===proposal.id?'正在确认…':'确认并融入指挥官指令'}</button>:<small>{proposal.status==='confirmed'?'已确认。':'方案已更新，请继续讨论后确认新方案。'}</small>}
   </section>}
  </div>
 </article>;
}

export function CommanderRepliesHeader({history,toggleHistory,close}:{history:boolean;toggleHistory:()=>void;close:()=>void}){
 return <header><span><MessageCircle size={14}/>{history?'本局讨论记录':'指挥官'}</span><div className="commander-reply-actions">
  <button type="button" className="commander-history-toggle" aria-label={history?'收起历史，回到最新回复':'展开双方历史对话'} aria-expanded={history} title={history?'收起历史，回到最新回复':'展开双方历史对话（旧的在上面）'} onClick={toggleHistory}>{history?<ChevronsDown size={15}/>:<ChevronsUp size={15}/>}<span>{history?'收起':'展开'}</span></button>
  <button type="button" aria-label="收起所有回复" title="收起所有回复" onClick={close}><X size={16}/></button>
 </div></header>;
}

export function CommanderChat({roomId,player,request,referenceRequest,resolveReference,locate}:CommanderChatProps){
 const [thread,setThread]=useState<CommanderThread|null>(null),[draft,setDraft]=useState(''),[references,setReferences]=useState<CommanderReference[]>([]);
 const [history,setHistory]=useState(false),[expanded,setExpanded]=useState(true),[sending,setSending]=useState(false),[pendingDraft,setPendingDraft]=useState<{id:string;text:string}|null>(null),[confirming,setConfirming]=useState<string|null>(null),[error,setError]=useState(''),[unread,setUnread]=useState(0);
 const requestRef=useRef(request);requestRef.current=request;
 const input=useRef<HTMLTextAreaElement>(null),scroller=useRef<HTMLDivElement>(null),atBottom=useRef(true),alive=useRef(true),abort=useRef<AbortController|null>(null),load=useRef<()=>Promise<void>>(async()=>{}),seen=useRef(new Set<string>()),initialized=useRef(false),latestThread=useRef<CommanderThread|null>(null);
 const attempt=useRef<{signature:string;id:string}|null>(null),draftRef=useRef(draft),referencesRef=useRef(references);draftRef.current=draft;referencesRef.current=references;
 const historyRef=useRef(history);historyRef.current=history;
 // Track the real timebar, including the mobile event panel and keyboard viewport.
 // Wide screens share one bottom row; narrow screens keep a non-overlapping stack.
 useEffect(()=>{
  const room=input.current?.closest<HTMLElement>('.command-room'),bar=room?.querySelector<HTMLElement>(':scope > .precision-timebar'),entry=input.current?.closest<HTMLElement>('.commander-chat');
  if(!room||!bar||!entry)return;
  const align=()=>{const anchor=commanderDockAnchor(room.getBoundingClientRect(),bar.getBoundingClientRect(),room.clientWidth>1200);entry.style.setProperty('--commander-left',`${anchor.left}px`);entry.style.setProperty('--commander-bottom',`${anchor.bottom}px`);};
  const resize=new ResizeObserver(align);resize.observe(room);resize.observe(bar);
  const events=room.querySelector(':scope > .live-events');if(events)resize.observe(events);
  window.addEventListener('resize',align);align();
  return()=>{resize.disconnect();window.removeEventListener('resize',align);entry.style.removeProperty('--commander-left');entry.style.removeProperty('--commander-bottom');};
 },[]);
 useEffect(()=>{
  const viewport=window.visualViewport,room=input.current?.closest<HTMLElement>('.command-room');
  if(!viewport||!room)return;
  const sync=()=>{
   const value=commanderKeyboardViewport(window.innerHeight,viewport.height,viewport.offsetTop,document.activeElement===input.current);
   room.classList.toggle('commander-keyboard-open',!!value);
   if(value){room.style.setProperty('--commander-visible-height',`${value.height}px`);room.style.setProperty('--commander-visible-top',`${value.top}px`);}
   else{room.style.removeProperty('--commander-visible-height');room.style.removeProperty('--commander-visible-top');}
  };
  viewport.addEventListener('resize',sync);viewport.addEventListener('scroll',sync);document.addEventListener('focusin',sync);document.addEventListener('focusout',sync);sync();
  return()=>{viewport.removeEventListener('resize',sync);viewport.removeEventListener('scroll',sync);document.removeEventListener('focusin',sync);document.removeEventListener('focusout',sync);room.classList.remove('commander-keyboard-open');room.style.removeProperty('--commander-visible-height');room.style.removeProperty('--commander-visible-top');};
 },[]);
 const accept=(value:CommanderThread)=>{
  validateCommanderThread(value,roomId,player);
  if(!commanderSnapshotIsCurrent(latestThread.current,value))return;
  const fresh=value.messages.filter(m=>!seen.current.has(m.id)&&m.role!=='player');
  if(initialized.current&&fresh.length&&(!historyRef.current||!atBottom.current))setUnread(n=>n+fresh.length);
  value.messages.forEach(m=>seen.current.add(m.id));initialized.current=true;latestThread.current=value;setThread(value);
 };
 const acceptRef=useRef(accept);acceptRef.current=accept;
 useEffect(()=>{
  if(pendingDraft===null||!thread)return;
  const message=thread.messages.find(item=>item.id===pendingDraft.id);
  if(message&&message.status!=='queued'){
   setDraft(value=>value===pendingDraft.text?'':value);
   setPendingDraft(null);
  }
 },[thread,pendingDraft]);
 useEffect(()=>{
  alive.current=true;const controller=new AbortController();abort.current=controller;let busy=false;
  async function refresh(){if(busy||controller.signal.aborted)return;busy=true;try{const value=await requestRef.current('list',undefined,controller.signal);if(!controller.signal.aborted){acceptRef.current(value);setError(previous=>previous===commanderFriendlyError('list')?'':previous);}}catch{if(!controller.signal.aborted)setError(previous=>previous||commanderFriendlyError('list'));}finally{busy=false;}}
  load.current=refresh;void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},2000);
  return()=>{alive.current=false;controller.abort();clearInterval(timer);};
 },[roomId,player]);
 useEffect(()=>{
  if(!referenceRequest)return;
  setReferences(prior=>{
   if(prior.length>=12&&!prior.some(item=>commanderReferenceKey(item)===commanderReferenceKey(referenceRequest.reference))){setError('最多同时引用十二个对象。');return prior;}
   return addCommanderReference(prior,referenceRequest.reference);
  });
  input.current?.focus();
 },[referenceRequest?.nonce]);
 useEffect(()=>{
  if(history&&atBottom.current){const node=scroller.current;if(node)node.scrollTop=node.scrollHeight;setUnread(0);}
 },[thread,history]);
 async function send(event:React.FormEvent){
  event.preventDefault();const text=draft.trim();if(!text||sending||!thread)return;
  const capturedReferences=references,signature=JSON.stringify({text,references:capturedReferences});
  if(attempt.current?.signature!==signature)attempt.current={signature,id:commanderRequestId()};
  setSending(true);setError('');
  try{const value=await requestRef.current('messages',{id:attempt.current.id,text,references:capturedReferences},abort.current?.signal);if(!alive.current)return;accept(value);
   const queuedMessage=commanderChronologicalMessages(value.messages).filter(message=>message.role==='player'&&message.text===text).at(-1);
   if(queuedMessage?.status==='queued')setPendingDraft({id:queuedMessage.id,text});
   else if(draftRef.current===draft)setDraft('');
   if(referencesRef.current===capturedReferences)setReferences([]);attempt.current=null;setExpanded(true);
  }catch{if(alive.current)setError(commanderFriendlyError('messages'));}finally{if(alive.current)setSending(false);}
 }
 async function confirm(proposalId:string,version:number){
  if(confirming)return;setConfirming(proposalId);setError('');
  try{const value=await requestRef.current('confirm',{proposalId,version},abort.current?.signal);if(alive.current)accept(value);}
  catch{if(alive.current){setError(commanderFriendlyError('confirm'));void load.current();}}
  finally{if(alive.current)setConfirming(null);}
 }
 const orderedMessages=commanderChronologicalMessages(thread?.messages??[]);
 const recent=orderedMessages.filter(message=>message.role!=='player').at(-1),queued=thread?.messages.some(message=>message.role==='player'&&message.status==='queued');
 const status=thread?.workerAvailable===false?'消息会保留，等待 AI 连接':queued?'消息已排队，游戏继续进行':!thread?'连接中…':'与己方 AI 私下讨论';
 const toggleHistory=()=>{setHistory(!history);setExpanded(true);atBottom.current=true;setUnread(0);};
 const bubble=(message:CommanderMessage)=><CommanderMessageBubble key={message.id} message={message} version={thread?.directives.version??0} directives={thread?.directives.text??''} confirming={confirming} confirm={(id,version)=>void confirm(id,version)} resolveReference={resolveReference} locate={locate}/>;
 return <section className={`commander-chat ${history?'commander-history-open':''}`} aria-label="与己方 AI 私下讨论">
  {(history||expanded&&recent)&&<div className={`commander-replies ${history?'commander-history':''}`}>
   <CommanderRepliesHeader history={history} toggleHistory={toggleHistory} close={()=>{setHistory(false);setExpanded(false);}}/>
   <div ref={scroller} className="commander-scroll" role="log" aria-live={history?'off':'polite'} onScroll={()=>{const node=scroller.current;if(node){atBottom.current=node.scrollHeight-node.scrollTop-node.clientHeight<70;if(atBottom.current)setUnread(0);}}}>
    {history?(orderedMessages.length?orderedMessages.map(bubble):<p className="commander-empty">还没有讨论记录。选中据点或舰队，就能把它加入对话。</p>):recent&&bubble(recent)}
   </div>
   {history&&unread>0&&<button type="button" className="commander-new-replies" onClick={()=>{atBottom.current=true;if(scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight;setUnread(0);}}>查看 {unread} 条新回复</button>}
  </div>}
  {(references.length>0||error)&&<div className="commander-context">
   {references.length>0&&<div className="commander-draft-references">{references.map(reference=><span key={commanderReferenceKey(reference)}><button type="button" className="commander-draft-locate" disabled={!resolveReference(reference).locatable} title="在地图上定位引用对象" onClick={()=>locate(reference)}><MapPin size={12}/>{reference.label??resolveReference(reference).label}</button><button type="button" aria-label={`移除引用 ${reference.label??reference.id}`} onClick={()=>setReferences(prior=>prior.filter(item=>commanderReferenceKey(item)!==commanderReferenceKey(reference)))}><X size={12}/></button></span>)}</div>}
   {error&&<div className="commander-error" role="alert">{error}<button type="button" onClick={()=>{setError('');void load.current();}}>刷新</button></div>}
  </div>}
  <div className="commander-composer">
   <form onSubmit={send}>
    <button type="button" className={`commander-portrait-button${history?' is-active':''}${unread?' has-unread':''}`} aria-label={history?'关闭讨论历史':'打开本局讨论历史'} aria-expanded={history} title={`本局讨论历史 · ${status}${unread?` · ${unread} 条新回复`:''}`} onClick={toggleHistory}>
     <img src="/assets/commander/naval-commander.png" alt="" className="commander-portrait" draggable={false}/>
     <span className={`commander-status-dot ${!thread?'is-connecting':queued?'is-queued':thread.workerAvailable===false?'is-offline':'is-ready'}`} aria-hidden="true"/>
    </button>
    <textarea className={pendingDraft!==null?'is-waiting-reply':''} ref={input} rows={1} maxLength={2000} readOnly={pendingDraft!==null} aria-label="与己方 AI 讨论局势" title={pendingDraft!==null?'已发送，等待指挥官回复':'与己方 AI 讨论局势；Enter 发送，Shift+Enter 换行'} value={draft} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&window.matchMedia('(pointer: fine)').matches){event.preventDefault();void send(event);}}}/>
    {pendingDraft!==null&&<LoaderCircle className="commander-waiting-spinner" size={16} aria-label="等待指挥官回复"/>}
    {recent&&!history&&<button type="button" className="commander-reply-toggle" aria-label={expanded?'收起回复':'展开回复'} title={expanded?'收起回复':'展开回复'} onClick={()=>setExpanded(!expanded)}>{expanded?<ChevronDown size={15}/>:<ChevronUp size={15}/>}</button>}
    <button type="submit" className="commander-send" disabled={sending||!draft.trim()||!thread} aria-label="发送给己方 AI" title="发送给己方 AI"><Send size={16}/></button>
   </form>
   <span className="commander-sr-status" role="status">{status}</span>
  </div>
 </section>;
}
