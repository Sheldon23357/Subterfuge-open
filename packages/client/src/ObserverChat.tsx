import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {ChatMessage} from '../../contracts/src/index.js';
import {colors,playerNames} from './theme.js';
import {tickTime} from './time.js';
import {ChatMessageText} from './ChatMessageText.js';

type Page={roomId:string;messages:ChatMessage[];fromCursor:number;toCursor:number;total:number};
const empty={messages:[] as ChatMessage[],fromCursor:0,total:0,ready:false};
export function ObserverChatMessages({messages}:{messages:ChatMessage[]}) {
  const name=(id:number)=>playerNames[id]??`玩家 ${id+1}`;
  return <>{messages.map(message=><article key={`${message.from}:${message.id}`}>
    <div className="observer-chat-route">
      <b style={{color:colors[message.from]}}>{name(message.from)}</b>
      <span aria-hidden="true">→</span>
      {message.to===null?<span className="observer-chat-public">公开频道</span>:
        <span className="observer-chat-recipients">{(Array.isArray(message.to)?message.to:[message.to]).map(id=><b key={id} style={{color:colors[id]}}>{name(id)}</b>)}</span>}
      <time>{tickTime(message.tick)}</time>
    </div>
    <p><ChatMessageText text={message.text}/></p>
  </article>)}</>;
}
export function ObserverChat({roomId,open}:{roomId:string;open:boolean}) {
  const [transcript,setTranscript]=useState(empty),[error,setError]=useState(''),[retry,setRetry]=useState(0),[loadingEarlier,setLoadingEarlier]=useState(false);
  const list=useRef<HTMLDivElement>(null),request=useRef<AbortController|null>(null);
  const scroll=useRef<{bottom?:boolean;height?:number}|null>(null);
  useLayoutEffect(()=>{
    const element=list.current,adjust=scroll.current;
    if(element&&adjust){if(adjust.bottom)element.scrollTop=element.scrollHeight;else if(adjust.height!==undefined)element.scrollTop+=element.scrollHeight-adjust.height;}
    scroll.current=null;
  },[transcript.messages]);
  async function page(params:string,signal:AbortSignal):Promise<Page> {
    const response=await fetch(`/api/chat/observer?${params}`,{signal});
    const result=await response.json();
    if(!response.ok)throw Error(result.error??'聊天记录读取失败');
    if(result.roomId!==roomId)throw Error('对局已更新，请重新打开聊天');
    return result;
  }
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();request.current=controller;
    setTranscript(empty);setError('');setLoadingEarlier(false);
    let cursor:number|undefined,polling=false;
    async function poll(){
      if(polling||controller.signal.aborted)return;
      polling=true;
      try {
        let more=true;
        while(more&&!controller.signal.aborted){
          const result=await page(cursor===undefined?'limit=100':`after=${cursor}&limit=100`,controller.signal);
          if(controller.signal.aborted)return;
          const initial=cursor===undefined,element=list.current;
          if(initial||element&&element.scrollHeight-element.scrollTop-element.clientHeight<60)scroll.current={bottom:true};
          if(initial||result.messages.length)setTranscript(previous=>({messages:initial?result.messages:[...previous.messages,...result.messages],fromCursor:initial?result.fromCursor:previous.fromCursor,total:result.total,ready:true}));
          cursor=result.toCursor;more=cursor<result.total;
        }
        setError('');
      }catch(e){if(!controller.signal.aborted)setError((e as Error).message);}
      finally{polling=false;}
    }
    void poll();const timer=setInterval(()=>void poll(),2000);
    return()=>{controller.abort();clearInterval(timer);if(request.current===controller)request.current=null;};
  },[roomId,open,retry]);
  async function earlier(){
    const controller=request.current;if(!controller||loadingEarlier||!transcript.fromCursor)return;
    setLoadingEarlier(true);
    try{
      const result=await page(`before=${transcript.fromCursor}&limit=100`,controller.signal);
      if(controller.signal.aborted)return;
      scroll.current={height:list.current?.scrollHeight??0};
      setTranscript(previous=>({...previous,messages:[...result.messages,...previous.messages],fromCursor:result.fromCursor,total:result.total}));
    }catch(e){if(!controller.signal.aborted)setError((e as Error).message);}
    finally{if(!controller.signal.aborted)setLoadingEarlier(false);}
  }
  return <section className="chat-window embedded observer-chat" aria-label="OB 全局聊天记录">
    <div className="observer-chat-heading"><b>全部玩家聊天</b><span>只读 · {transcript.total} 条</span></div>
    <div className="chat-messages" ref={list} role="log" aria-live="off">
      {transcript.fromCursor>0&&<button className="observer-chat-earlier" onClick={()=>void earlier()} disabled={loadingEarlier}>{loadingEarlier?'正在读取…':'加载更早消息'}</button>}
      {!transcript.ready?<p className="chat-empty">正在读取聊天记录…</p>:!transcript.messages.length?<p className="chat-empty">尚无聊天记录</p>:<ObserverChatMessages messages={transcript.messages}/>}
    </div>
    {error&&<div className="chat-error" role="alert">{error}<button onClick={()=>setRetry(n=>n+1)}>重试</button></div>}
  </section>;
}
