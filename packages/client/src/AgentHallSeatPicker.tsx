import React,{useEffect,useRef} from 'react';
import type {ConsoleRequest} from './AgentConnectionWizard.js';
export function defaultHallOrigin(){
 const localHall = 'http://127.0.0.1:4312';
 try{return new URLSearchParams(location.hash.slice(1)).get('hall')||localStorage.getItem('subterfuge-ai-hall-url')||localHall;}catch{return localHall;}
}
export function AgentHallSeatPicker({onCancel}:{request:ConsoleRequest;slotId?:string|undefined;onCancel:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 return <dialog ref={dialog} className="console-connect seat-link seat-link-dialog" aria-label="从房间绑定 bot" onCancel={e=>{e.preventDefault();onCancel();}}><header className="seat-link-heading"><h2>从房间绑定 bot</h2><button onClick={onCancel}>关闭</button></header><p>加入游戏房间，在自己的席位或空位上点击“绑定 bot”，然后在控制器弹窗中选择槽位并确认。</p><a className="seat-link-primary" href={defaultHallOrigin()} target="_blank" rel="noopener noreferrer">打开游戏大厅</a></dialog>;
}
