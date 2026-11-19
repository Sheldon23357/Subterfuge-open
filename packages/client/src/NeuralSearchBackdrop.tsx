import React,{useId,useRef,useState,useEffect} from 'react';

/** One background spans the heading, program pipeline, graph and all search footers. */
export function NeuralSearchSurface({active,children}:{active:boolean;children:React.ReactNode}){
 const ref=useRef<HTMLElement|null>(null),[size,setSize]=useState({width:800,height:500});
 useEffect(()=>{if(!ref.current)return;const observer=new ResizeObserver(([entry])=>{if(entry&&entry.contentRect.width>0&&entry.contentRect.height>0){const width=Math.round(entry.contentRect.width),height=Math.round(entry.contentRect.height);setSize(old=>old.width===width&&old.height===height?old:{width,height});}});observer.observe(ref.current);return()=>observer.disconnect();},[]);
 return <section ref={ref} data-active={active} className="live-module live-search"><svg className="live-search-backdrop" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true"><NeuralSearchBackdrop width={size.width} height={size.height}/></svg>{children}</section>;
}

/** Decorative depth only; no background element represents a candidate or an evaluation. */
export function NeuralSearchBackdrop({width:w,height:h}:{width:number;height:number}){
 const id=useId().replace(/:/g,'');
 return <g className="live-neural-backdrop" aria-hidden="true" pointerEvents="none">
  <defs>
   <linearGradient id={id+'-deep'} x2=".8" y2="1"><stop stopColor="#060d1a"/><stop offset=".5" stopColor="#0b202c"/><stop offset="1" stopColor="#0a1020"/></linearGradient>
   {['#14d9bd','#7865f8','#157ed9'].map((color,i)=><radialGradient id={id+'-aura'+i} key={color}><stop stopColor={color} stopOpacity=".23"/><stop offset=".45" stopColor={color} stopOpacity=".09"/><stop offset="1" stopColor={color} stopOpacity="0"/></radialGradient>)}
   <linearGradient id={id+'-floor'} x2="0" y2="1"><stop stopColor="white" stopOpacity="0"/><stop offset=".7" stopColor="white" stopOpacity=".6"/><stop offset="1" stopColor="white" stopOpacity="0"/></linearGradient>
   <mask id={id+'-fade'}><rect width={w} height={h} fill={'url(#'+id+'-floor)'}/></mask>
   <pattern id={id+'-dust'} width="83" height="71" patternUnits="userSpaceOnUse"><circle cx="9" cy="17" r=".65" fill="#a9e5ff" opacity=".3"/><circle cx="56" cy="49" r=".45" fill="#96a4f9" opacity=".25"/></pattern>
  </defs>
  <rect width={w} height={h} fill={'url(#'+id+'-deep)'}/>
  <g className="live-nebula-drift" style={{transformOrigin:`${w*.5}px ${h*.5}px`}}>
   <ellipse cx={w*.24} cy={h*.40} rx={w*.38} ry={h*.55} fill={'url(#'+id+'-aura0)'}/>
   <ellipse cx={w*.77} cy={h*.36} rx={w*.35} ry={h*.55} fill={'url(#'+id+'-aura1)'}/>
   <ellipse cx={w*.52} cy={h*.94} rx={w*.40} ry={h*.44} fill={'url(#'+id+'-aura2)'}/>
  </g>
  <rect width={w} height={h} fill={'url(#'+id+'-dust)'}/>
  <g mask={'url(#'+id+'-fade)'} stroke="#4b91b3" strokeWidth=".5" opacity=".14">
   {Array.from({length:17},(_,i)=><path key={'v'+i} d={`M${w*.5+(i-8)*w*.015} ${h*.39}L${w*.5+(i-8)*w*.13} ${h}`}/>)}
   {[.53,.58,.65,.75,.89].map(y=><path key={y} d={`M0 ${h*y}Q${w*.5} ${h*(y-.06)} ${w} ${h*y}`} fill="none"/>)}
  </g>
  <g fill="none" strokeWidth=".8" opacity=".12">
   <path d={`M${-w*.1} ${h*.66}C${w*.22} ${-h*.12} ${w*.56} ${h*1.18} ${w*1.1} ${h*.19}`} stroke="#3ae3cf"/>
   <path d={`M${-w*.1} ${h*.7}C${w*.22} ${-h*.08} ${w*.56} ${h*1.22} ${w*1.1} ${h*.23}`} stroke="#519ad0" opacity=".5"/>
   <path d={`M${w*.05} ${h*1.1}C${w*.40} ${h*.5} ${w*.53} ${-h*.1} ${w*1.1} ${h*.8}`} stroke="#8d79e9"/>
  </g>
  {Array.from({length:19},(_,i)=>{const x=((i*.618034+.13)%1)*w,y=((i*.381966+.21)%1)*h;return <g key={i} className="live-neural-star" style={{animationDelay:`${-i*.41}s`}}><path d={`M${x-2} ${y}H${x+2}M${x} ${y-2}V${y+2}`} stroke="#abdaff" strokeWidth=".5" opacity=".38"/></g>;})}
  <path d={`M14 26V14H40M${w-40} 14H${w-14}V26M14 ${h-26}V${h-14}H40M${w-40} ${h-14}H${w-14}V${h-26}`} stroke="#71c7e4" strokeOpacity=".25" fill="none"/>
 </g>;
}
