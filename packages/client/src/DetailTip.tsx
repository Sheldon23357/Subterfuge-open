import React,{useEffect,useId,useRef,useState} from 'react';
import {tipPosition} from './tip-position.js';

/** A top-layer tooltip keeps table rows fixed and escapes their scroll container. */
export function DetailTip({label,children}:{label:string;children:React.ReactNode}){
 const id=useId(),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
 const [open,setOpen]=useState(false),closing=useRef<ReturnType<typeof setTimeout>|null>(null);
 const cancelClose=()=>{if(closing.current!==null){clearTimeout(closing.current);closing.current=null;}};
 const hide=()=>{cancelClose();if(panel.current?.matches(':popover-open'))panel.current.hidePopover();};
 const show=()=>{
  cancelClose();const element=panel.current,button=trigger.current;if(!element||!button)return;
  if(!element.matches(':popover-open'))element.showPopover();
  const position=tipPosition(button.getBoundingClientRect(),{width:window.innerWidth,height:window.innerHeight},element.getBoundingClientRect().height,true);
  Object.assign(element.style,{left:`${position.left}px`,top:`${position.top}px`,width:`${position.width}px`,maxHeight:`${position.maxHeight}px`});
 };
 const scheduleClose=()=>{
  cancelClose();closing.current=setTimeout(()=>{
   if(document.activeElement!==trigger.current&&!panel.current?.matches(':hover'))hide();
  },120);
 };
 useEffect(()=>()=>cancelClose(),[]);
 useEffect(()=>{
  if(!open)return;
  const dismissForLayout=(event:Event)=>{if(event.type==='scroll'&&event.target instanceof Node&&panel.current?.contains(event.target))return;hide();};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();hide();}};
  window.addEventListener('scroll',dismissForLayout,true);window.addEventListener('resize',dismissForLayout);window.addEventListener('keydown',escape,true);
  return()=>{window.removeEventListener('scroll',dismissForLayout,true);window.removeEventListener('resize',dismissForLayout);window.removeEventListener('keydown',escape,true);};
 },[open]);
 return <>
  <button ref={trigger} type="button" className="detail-tip-trigger" aria-label={label} aria-describedby={open?id:undefined} onMouseEnter={show} onMouseLeave={scheduleClose} onFocus={show} onBlur={scheduleClose} onClick={show}>明细</button>
  <div ref={panel} id={id} className="console-detail-tip" popover="auto" role="tooltip" aria-label={label} onToggle={event=>setOpen(event.newState==='open')} onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
   <b className="detail-tip-heading">{label}</b><div className="detail-tip-body">{children}</div>
  </div>
 </>;
}
