import React,{useEffect,useRef,useState} from 'react';
import {savedHallToken} from './hall-link-protocol.js';
import {hallClaim} from './hall-identity.js';
export function BindSeatBot({code,roomId,seat,own}:{code:string;roomId:string;seat:number;own:boolean}){
 const [error,setError]=useState(''),[pending,setPending]=useState(false);
 const cleanup=useRef<()=>void>(()=>{});
 useEffect(()=>()=>cleanup.current(),[]);
 function open(){
  cleanup.current();setError('');setPending(true);
  const origin='http://127.0.0.1:4400';
  const nonce=Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,'0')).join('');
  let popup:Window|null=null,working=false,token:string|null=null;
  const receive=async(e:MessageEvent)=>{
   if(e.source!==popup||e.origin!==origin||e.data?.nonce!==nonce)return;
   if(e.data.type==='subterfuge-seat-bound'){setPending(false);cleanup.current();return;}
   if(e.data.type!=='subterfuge-seat-credential-request'||working)return;
   working=true;
   try{
    if(!token){
     if(own){token=savedHallToken(code,localStorage,sessionStorage);if(!token)throw Error('当前玩家身份不可用，请从大厅重新进入房间。');}
     else{
      const key=hallClaim(sessionStorage,localStorage,`bot-seat-${roomId}-${seat}`,()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join(''));
      const response=await fetch(`/api/rooms/${code}/join`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,seat})});
      const result=await response.json();if(!response.ok)throw Error(result.error??'席位已变化，请刷新房间。');
      if(result.player!==seat||result.roomId!==roomId)throw Error('服务器返回的席位不符。');token=result.playerToken;
      if(!token||!/^[a-f0-9]{64}$/.test(token))throw Error('席位凭据无效。');
     }
    }
    popup?.postMessage({type:'subterfuge-seat-credential',nonce,playerToken:token},origin);
   }catch(err){const message=err instanceof Error?err.message:'无法绑定席位';setError(message);popup?.postMessage({type:'subterfuge-seat-error',nonce,error:message},origin);}
   finally{working=false;}
  };
  const timer=setTimeout(()=>{setPending(false);setError('若控制器未打开，请先启动本地 AI 控制器（端口 4400），再重试。');cleanup.current();},300000);
  cleanup.current=()=>{clearTimeout(timer);window.removeEventListener('message',receive);};
  window.addEventListener('message',receive);
  const params=new URLSearchParams({bind:'seat',hall:location.origin,code,roomId,seat:String(seat),nonce});
  popup=window.open(`${origin}/#${params}`,`subterfuge-bind-${nonce}`);
  if(!popup){cleanup.current();setPending(false);setError('请允许打开本地控制器窗口后重试。');}
 }
 return <span className="seat-bot-binding"><button type="button" onClick={open}>{pending?'重新打开绑定':'绑定 bot'}</button>{error&&<small role="alert">{error}</small>}</span>;
}
