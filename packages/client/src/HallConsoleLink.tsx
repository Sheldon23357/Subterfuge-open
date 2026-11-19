import {rememberPlayerSeat} from './player-route.js';
import React,{useEffect,useRef,useState} from 'react';
import {hallClaim} from './hall-identity.js';
import {savedHallToken,type HallLinkTarget,type HallLinkRoom} from './hall-link-protocol.js';
export function HallConsoleLink({target}:{target:HallLinkTarget}){
 const [rooms,setRooms]=useState<HallLinkRoom[]>([]),[selection,setSelection]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[credential,setCredential]=useState<{code:string;playerToken:string}|null>(null);
 const form=useRef<HTMLFormElement>(null),locked=useRef(false);
 const params=new URLSearchParams(location.hash.slice(1)),slot=params.get('slot')??'manual';
 const valid=params.get('flow')==='redirect'&&/^[a-zA-Z0-9_-]{1,60}$/.test(slot);
 const tokenFor=(code:string)=>{const token=localStorage.getItem(`subterfuge-ai-identity-${code}-${slot}`);return token&&/^[a-f0-9]{64}$/.test(token)?token:savedHallToken(code,localStorage,sessionStorage);};
 useEffect(()=>{
  if(!valid){setError('请从 AI 控制台重新发起连接。');setLoading(false);return;}
  const controller=new AbortController();
  void (async()=>{
   try{
    const response=await fetch('/api/rooms',{signal:controller.signal});if(!response.ok)throw Error('无法读取大厅房间。');
    const data=await response.json();
    const found:HallLinkRoom[]=await Promise.all(data.rooms.map(async(room:Omit<HallLinkRoom,'own'>)=>{
     const token=tokenFor(room.code);if(!token)return {...room,own:false};
     const identityResponse=await fetch(`/api/rooms/${room.code}/identity`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal});
     if(!identityResponse.ok)return {...room,own:false};
     const identity=await identityResponse.json(),linksResponse=await fetch(`/api/rooms/${room.code}/bots`,{signal:controller.signal});
     if(!linksResponse.ok)throw Error('无法读取席位连接状态。');
     const links=await linksResponse.json(),bot=links.connections.find((b:{seat:number;name:string})=>b.seat===identity.seat);
     return {...room,own:true,ownSeat:identity.seat,...(bot?{ownBot:bot.name}:{})};
    }));
    if(controller.signal.aborted)return;setRooms(found);
    const mine=found.find(r=>r.own&&!r.ownBot),blank=found.find(r=>r.status==='waiting'&&r.players<r.capacity);
    setSelection(mine?`${mine.code}:own`:blank?`${blank.code}:blank`:'');
   }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'无法读取席位，请重试。');}
   finally{if(!controller.signal.aborted)setLoading(false);}
  })();
  return()=>controller.abort();
 },[target.origin,target.nonce]);
 useEffect(()=>{
  if(!credential)return;
  // Preserve the hall Origin on HTTPS-to-loopback POST navigation. Only the
  // origin is disclosed; neither the hash nor player credentials are referrers.
  const policy=document.createElement('meta');policy.name='referrer';policy.content='origin';document.head.append(policy);
  form.current?.submit();return()=>policy.remove();
 },[credential]);
 async function connect(){
  const room=rooms.find(r=>r.code===selection.split(':')[0]),own=selection.endsWith(':own');
  if(!room||locked.current)return;locked.current=true;setBusy(true);setError('');
  try{
   let token=own?tokenFor(room.code):null;
   if(own&&!token)throw Error('本浏览器没有该房间的玩家身份。');
   if(!own){
    if(room.status!=='waiting'||room.players>=room.capacity)throw Error('该房间没有可加入的空位。');
    const key=hallClaim(sessionStorage,localStorage,`bot-${room.code}-${slot}`,()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join(''));
    const response=await fetch(`/api/rooms/${room.code}/join`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const joined=await response.json();if(!response.ok)throw Error(joined.error??'无法加入房间。');token=joined.playerToken;
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw Error('大厅返回的席位凭据无效。');
    localStorage.setItem(`subterfuge-ai-identity-${room.code}-${slot}`,token);
   }
   const response=await fetch(`/api/rooms/${room.code}/identity`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)}),identity=await response.json();
   if(!response.ok||!Number.isInteger(identity.seat)||identity.seat<0||identity.seat>9||typeof identity.roomId!=='string')throw Error('服务器未确认该席位。');
   rememberPlayerSeat(localStorage,{code:room.code,seat:identity.seat,roomId:identity.roomId,playerToken:token!});
   setCredential({code:room.code,playerToken:token!});
  }catch(e){setError(e instanceof Error?e.message:'连接失败，请重试。');locked.current=false;setBusy(false);}
 }
 return <main className="hall-console-link hall-seat-page"><div className="hall-link-brand">SUBTERFUGE <span> / AI 连接</span></div><section className="hall-link-card"><p className="hall-link-step">选择席位 → 自动返回 → 配置并启动</p><h1>为 {slot==='manual'?'AI':slot.replace('ai-','AI ')} 选择游戏席位</h1><p className="hall-link-status">连接后自动返回控制台，AI 保持暂停。</p>
  {loading&&<p role="status">正在查找可连接的席位…</p>}
  {!loading&&!error&&!rooms.length&&<p role="status">大厅暂无房间，请先创建房间。</p>}
  <div className="hall-link-rooms">{rooms.map(room=><fieldset key={room.code} disabled={busy}><legend>{room.name}</legend><p>{room.status==='waiting'?'等待开始':'已开局'} · {room.players}/{room.capacity} 人</p>
   {room.own&&<label className={selection===`${room.code}:own`?'selected':''}><input type="radio" name="hall-seat" checked={selection===`${room.code}:own`} onChange={()=>setSelection(`${room.code}:own`)} disabled={!!room.ownBot}/><span>让 AI 控制我的席位<small>{room.ownBot?`${room.ownBot} 已连接`:'使用已有身份，不新增玩家'}</small></span></label>}
   {room.status==='waiting'&&room.players<room.capacity&&<label className={selection===`${room.code}:blank`?'selected':''}><input type="radio" name="hall-seat" checked={selection===`${room.code}:blank`} onChange={()=>setSelection(`${room.code}:blank`)}/><span>为 AI 加入新席位<small>占用一个空位，你可以继续控制自己的席位</small></span></label>}
   {!room.own&&!(room.status==='waiting'&&room.players<room.capacity)&&<p>暂无可连接的席位</p>}
  </fieldset>)}</div>
  {error&&<p className="hall-link-error" role="alert">{error}</p>}
  <button className="hall-link-return" type="button" disabled={!valid||loading||busy||!selection} onClick={()=>void connect()}>{busy?'正在连接并返回…':'连接此席位 →'}</button>
  <a className="hall-link-cancel" href={target.origin+'/'}>返回控制台</a>
  <form ref={form} method="post" action={target.origin+'/hall-link/return'} hidden><input type="hidden" name="nonce" value={target.nonce}/><input type="hidden" name="code" value={credential?.code??''}/><input type="hidden" name="playerToken" value={credential?.playerToken??''}/></form>
 </section></main>;
}
