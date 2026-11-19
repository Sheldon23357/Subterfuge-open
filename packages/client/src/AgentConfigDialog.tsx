import React,{useEffect,useRef} from 'react';
import {X} from 'lucide-react';
export function AgentConfigDialog({name,title,description,className,busy,onClose,children}:{name:string;title?:string;description?:string;className?:string;busy:boolean;onClose:()=>void;children:React.ReactNode}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const element=dialog.current,root=document.documentElement,body=document.body;const rootOverflow=root.style.overflow,bodyOverflow=body.style.overflow,opener=document.activeElement;element?.showModal();root.style.overflow='hidden';body.style.overflow='hidden';return()=>{element?.close();root.style.overflow=rootOverflow;body.style.overflow=bodyOverflow;if(opener instanceof HTMLElement&&opener.isConnected)opener.focus();};},[]);
 return <dialog ref={dialog} className={'bot-config-dialog'+(className?' '+className:'')} aria-label={title??`${name} 配置`} aria-busy={busy} onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
  <header className="bot-config-heading"><div><h2>{title??`${name} · 配置`}</h2>{description&&<p className="bot-config-description">{description}</p>}</div><button type="button" aria-label="关闭配置" disabled={busy} onClick={onClose}><X size={18}/></button></header>
  <div className="bot-config-content">{children}</div>
 </dialog>;
}
