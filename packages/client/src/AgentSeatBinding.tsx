import React,{useEffect,useRef,useState} from 'react';
import {AgentProviderPanel,type ProviderEditorHandle} from './AgentProviderPanel.js';
import type {ConsoleRequest} from './AgentConnectionWizard.js';
import type {ConsoleConfigSeat} from '../../contracts/src/index.js';
export interface SeatBindingTarget {hall:string;code:string;roomId:string;seat:number;nonce:string}
export function seatBindingTarget(hash:string):SeatBindingTarget|null{
 const p=new URLSearchParams(hash.replace(/^#/,''));if(p.get('bind')!=='seat')return null;
 try{
  const hall=new URL(p.get('hall')??''),seat=Number(p.get('seat'));
  if(!['http:','https:'].includes(hall.protocol)||hall.origin!==p.get('hall')||!p.has('seat')||!Number.isInteger(seat)||seat<0||seat>9||! /^[A-Z0-9]{6}$/.test(p.get('code')??'')||! /^[a-f0-9]{48}$/.test(p.get('nonce')??'')||!p.get('roomId'))return null;
  return {hall:hall.origin,code:p.get('code')!,roomId:p.get('roomId')!,seat,nonce:p.get('nonce')!};
 }catch{return null;}
}
export function AgentSeatBinding({target,config,request,onClose,onBound}:{target:SeatBindingTarget;config:ConsoleConfigSeat[];request:ConsoleRequest;onClose:()=>void;onBound:(id:string)=>Promise<void>}){
 const slots=config.filter(s=>s.bound===false),[id,setId]=useState(slots[0]?.id??''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const dialog=useRef<HTMLDialogElement>(null),provider=useRef<ProviderEditorHandle>(null);
 const slot=slots.find(s=>s.id===id);
 useEffect(()=>{localStorage.setItem('subterfuge-ai-hall-url',target.hall);dialog.current?.showModal();history.replaceState(null,'',location.pathname);return()=>dialog.current?.close();},[]);
 useEffect(()=>{if(!slots.some(s=>s.id===id))setId(slots[0]?.id??'');},[config,id]);
 async function bind(){
  if(!slot||busy)return;setBusy(true);setError('');
  let timer:ReturnType<typeof setTimeout>|undefined;
  const opener=window.opener;
  if(!opener||opener.closed){setError('房间窗口已关闭，请回到房间重新点击绑定 bot。');setBusy(false);return;}
  let receive:(e:MessageEvent)=>void=()=>{},stage='保存模型设置';
  try{
   const settings=provider.current?.configuration();
   const configured=settings?await request<{settings:ConsoleConfigSeat['settings']}>('configuration',{id:slot.id,provider:settings,settings:slot.settings,requireUnbound:true}):{settings:slot.settings};
   stage='领取房间席位';
   const token=await new Promise<string>((resolve,reject)=>{
    receive=e=>{
     if(e.source!==opener||e.origin!==target.hall||e.data?.nonce!==target.nonce)return;
     if(e.data.type==='subterfuge-seat-error')reject(Error(e.data.error??'无法领取席位。'));
     if(e.data.type==='subterfuge-seat-credential'&&typeof e.data.playerToken==='string'&&/^[a-f0-9]{64}$/.test(e.data.playerToken))resolve(e.data.playerToken);
    };
    window.addEventListener('message',receive);
    timer=setTimeout(()=>reject(Error('房间响应超时，请保持房间窗口打开后重试。')),15000);
    opener.postMessage({type:'subterfuge-seat-credential-request',nonce:target.nonce},target.hall);
   });
   stage='核验席位身份';
   const probe=await request<{probeId:string;identity:{roomId:string;lobbySeat:number}}>('connections/probe',{serverUrl:target.hall,playerToken:token});
   if(probe.identity.roomId!==target.roomId||probe.identity.lobbySeat!==target.seat)throw Error('服务器确认的席位与所选席位不符，绑定已停止。');
   stage='绑定 bot 槽位';
   const added=await request<{id:string}>('instances',{probeId:probe.probeId,id:slot.id,settings:configured.settings,roomCode:target.code,botName:slot.id.replace('ai-','AI ')});
   opener.postMessage({type:'subterfuge-seat-bound',nonce:target.nonce},target.hall);
   provider.current?.clearSensitive();await onBound(added.id);
  }catch(e){setError(`${stage}失败：${e instanceof Error?e.message:'请重试。'}`);}
  finally{clearTimeout(timer);window.removeEventListener('message',receive);setBusy(false);}
 }
 return <dialog ref={dialog} className="console-connect seat-link seat-link-dialog seat-binding-dialog" aria-label="绑定房间席位" aria-busy={busy} onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
  <header className="seat-link-heading"><div><h2>绑定席位 {target.seat+1}</h2><p>选择 bot 槽位，确认后保持暂停。</p></div><button disabled={busy} onClick={onClose}>关闭</button></header>
  <label>bot 槽位<select disabled={busy} value={id} onChange={e=>setId(e.target.value)}>{slots.map(s=><option key={s.id} value={s.id}>{s.id.replace('ai-','AI ')}</option>)}</select></label>
  {!slots.length&&<p role="status">没有空闲 bot 槽位，请先断开一个已有绑定。</p>}
  {slot&&<details><summary>模型设置（可选）</summary><AgentProviderPanel key={id} ref={provider} id={id} value={slot.providerConfig} request={request} disabled={busy}/></details>}
  {error&&<p className="console-error" role="alert">{error}</p>}
  <footer className="seat-link-footer"><button disabled={!slot||busy} className="seat-link-primary" onClick={()=>void bind()}>{busy?'正在绑定…':'确认绑定'}</button></footer>
 </dialog>;
}
