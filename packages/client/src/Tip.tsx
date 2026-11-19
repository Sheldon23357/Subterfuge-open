import React,{useEffect,useId,useRef,useState} from 'react';
import {tipPosition} from './tip-position.js';
import './tip.css';

/** One compact help entry per panel. Native popover provides light dismissal/top layer. */
export function Tip({label,children}:{label:string;children:string}){
  const id=useId(),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false);
  function close(){panel.current?.hidePopover();trigger.current?.focus();}
  useEffect(()=>{
    if(!open)return;
    const element=panel.current;
    const dismissForLayout=(event:Event)=>{
      // Scrolling the help itself must remain possible for long explanations.
      if(event.type==='scroll'&&event.target instanceof Node&&element?.contains(event.target))return;
      if(!element?.matches(':popover-open'))return;
      const ownedFocus=element.contains(document.activeElement);
      element.hidePopover();
      if(ownedFocus)trigger.current?.focus({preventScroll:true});
    };
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||!element?.matches(':popover-open'))return;
      // Capture also protects the business panel after Tab leaves this non-modal help.
      event.preventDefault();event.stopImmediatePropagation();close();
    };
    window.addEventListener('scroll',dismissForLayout,true);
    window.addEventListener('resize',dismissForLayout);
    window.addEventListener('keydown',escape,true);
    return()=>{
      window.removeEventListener('scroll',dismissForLayout,true);
      window.removeEventListener('resize',dismissForLayout);
      window.removeEventListener('keydown',escape,true);
    };
  },[open]);
  function position(){
    const element=panel.current,button=trigger.current;
    if(!element||!button)return;
    const position=tipPosition(button.getBoundingClientRect(),{width:window.innerWidth,height:window.innerHeight},element.getBoundingClientRect().height);
    Object.assign(element.style,{left:`${position.left}px`,top:`${position.top}px`,width:`${position.width}px`,maxHeight:`${position.maxHeight}px`});
    element.focus();
  }
  return <>
    <button ref={trigger} type="button" className="panel-tip-trigger" aria-label={`${label}说明`} aria-expanded={open} aria-controls={id} title={children} popoverTarget={id}>?</button>
    <div ref={panel} id={id} className="panel-tip" popover="auto" role="dialog" aria-label={`${label}说明`} tabIndex={-1} onToggle={event=>{const expanded=event.newState==='open';setOpen(expanded);if(expanded)position();}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}}>
      <div className="panel-tip-heading"><b>{label}</b><button type="button" aria-label={`关闭${label}说明`} onClick={close}>×</button></div>
      <p>{children}</p>
    </div>
  </>;
}
