import {playerHref} from './player-route.js';
import React,{useEffect,useState} from 'react';
import type {HallLinkTarget} from './hall-link-protocol.js';
import {rememberHallIdentity} from './hall-identity.js';
export function HallSeatReturn({target}:{target:HallLinkTarget}){
 const [error,setError]=useState('');
 useEffect(()=>{
  const opener=window.opener;if(!opener){setError('请从本机 AI 控制台打开玩家页面。');return;}
  let active=true,used=false;
  const abort=new AbortController();
  const receive=async(event:MessageEvent)=>{
   if(used||event.source!==opener||event.origin!==target.origin||event.data?.nonce!==target.nonce||event.data?.type!=='subterfuge-player-entry')return;
   used=true;
   try{
    const {code,roomId,playerToken}=event.data;
    if(!/^[A-Z0-9]{6}$/.test(code)||typeof roomId!=='string'||typeof playerToken!=='string'||!/^[a-f0-9]{64}$/.test(playerToken))throw Error('玩家身份无效。');
    const response=await fetch(`/api/rooms/${code}/identity`,{headers:{Authorization:`Bearer ${playerToken}`},signal:abort.signal,redirect:'error'});
    const identity=await response.json();
    if(!response.ok||identity.roomId!==roomId||!Number.isInteger(identity.seat)||identity.seat<0||identity.seat>9)throw Error('服务器未确认该玩家身份。');
    if(!active)return;
    rememberHallIdentity(sessionStorage,localStorage,{code,roomId,playerToken,seat:identity.seat});
    window.location.replace(playerHref(code,identity.seat));
   }catch(e){if(active)setError(e instanceof Error?e.message:'恢复玩家页面失败。');}
  };
  window.addEventListener('message',receive);
  opener.postMessage({type:'subterfuge-player-entry-ready',nonce:target.nonce},target.origin);
  const timer=setTimeout(()=>{if(!used)setError('连接超时，请从本机控制台重试。');},30000);
  return()=>{active=false;abort.abort();clearTimeout(timer);window.removeEventListener('message',receive);};
 },[target.origin,target.nonce]);
 return <main className="hall-console-link"><h1>返回玩家页面</h1><p role={error?'alert':'status'}>{error||'正在核验本机控制台连接的玩家席位…'}</p><a href="/">返回大厅</a></main>;
}
