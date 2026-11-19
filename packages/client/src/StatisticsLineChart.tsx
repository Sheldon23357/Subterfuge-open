import React,{useEffect,useId,useRef,useState} from 'react';

export interface StatisticsSeries {
 id:string;label:string;color:string;axis:'left'|'right';values:(number|null)[];
 format:(value:number)=>string;formatDetail?:(value:number)=>string;minimumMax?:number;fill?:boolean;
}
interface Point {x:number;y:number}
export function niceChartMaximum(value:number){
 if(!Number.isFinite(value)||value<=0)return 1;
 const power=10**Math.floor(Math.log10(value)),fraction=value/power;
 return ([1,2,2.5,3,4,5,8,10].find(step=>step>=fraction)??10)*power;
}
/** Monotone interpolation passes through every sample and never bridges missing values. */
export function statisticsLinePath(points:(Point|null)[]):string {
 const segments:Point[][]=[];let segment:Point[]=[];
 for(const point of points){if(point){segment.push(point);}else if(segment.length){segments.push(segment);segment=[];}}
 if(segment.length)segments.push(segment);
 const number=(value:number)=>Number(value.toFixed(2));
 return segments.map(rows=>{
  let path=`M${number(rows[0]!.x)},${number(rows[0]!.y)}`;
  if(rows.length===1)return path;
  const slopes=rows.slice(1).map((p,i)=>(p.y-rows[i]!.y)/(p.x-rows[i]!.x));
  const tangents=rows.map((_,i)=>i===0?slopes[0]!:i===rows.length-1?slopes.at(-1)!:slopes[i-1]!*slopes[i]!<=0?0:2/(1/slopes[i-1]!+1/slopes[i]!));
  for(let i=0;i<slopes.length;i++){
   const slope=slopes[i]!;
   if(slope===0){tangents[i]=0;tangents[i+1]=0;continue;}
   const a=tangents[i]!/slope,b=tangents[i+1]!/slope,length=a*a+b*b;
   if(length>9){const scale=3/Math.sqrt(length);tangents[i]=scale*a*slope;tangents[i+1]=scale*b*slope;}
  }
  for(let i=1;i<rows.length;i++){
   const a=rows[i-1]!,b=rows[i]!,dx=(b.x-a.x)/3;
   path+=` C${number(a.x+dx)},${number(a.y+tangents[i-1]!*dx)} ${number(b.x-dx)},${number(b.y-tangents[i]!*dx)} ${number(b.x)},${number(b.y)}`;
  }
  return path;
 }).join(' ');
}

export function StatisticsLineChart({label,labels,pointLabels=labels,details=[],series,flagged=[]}:{label:string;labels:string[];pointLabels?:string[];details?:string[];series:StatisticsSeries[];flagged?:boolean[]}){
 const root=useRef<HTMLDivElement>(null),focused=useRef(false),[width,setWidth]=useState(560),[active,setActive]=useState<number|null>(null),id=useId().replace(/:/g,'');
 useEffect(()=>{const element=root.current;if(!element)return;const observer=new ResizeObserver(()=>setWidth(Math.max(220,element.clientWidth)));observer.observe(element);return()=>observer.disconnect();},[]);
 const height=178,left=46,right=width-(series.some(s=>s.axis==='right')?46:16),top=16,bottom=148,span=right-left;
 const x=(i:number)=>labels.length===1?(left+right)/2:left+i/Math.max(1,labels.length-1)*span;
 const scales=Object.fromEntries((['left','right'] as const).map(axis=>[axis,niceChartMaximum(Math.max(1,...series.filter(s=>s.axis===axis).flatMap(s=>[s.minimumMax??1,...s.values.filter((v):v is number=>v!==null&&Number.isFinite(v)&&v>=0)])))]));
 const y=(value:number,axis:'left'|'right')=>bottom-value/scales[axis]!*(bottom-top);
 const points=(s:StatisticsSeries)=>s.values.map((v,i)=>v!==null&&Number.isFinite(v)&&v>=0?{x:x(i),y:y(v,s.axis)}:null);
 const last=labels.length-1,selected=active!==null&&active<labels.length?active:null;
 const select=(index:number)=>setActive(Math.max(0,Math.min(last,index)));
 return <div className="statistics-line-chart" ref={root}>
  <div className="statistics-line-legend">{series.map(s=><span key={s.id} style={{color:s.color}}><i/>{s.label}</span>)}</div>
  <svg viewBox={`0 0 ${width} ${height}`} height={height} role="group" aria-label={label} tabIndex={0} aria-describedby={selected===null?undefined:id+'-tip'}
   onMouseMove={event=>{const bounds=event.currentTarget.getBoundingClientRect(),position=(event.clientX-bounds.left)*width/bounds.width;select(Math.round((position-left)/span*Math.max(0,last)));}}
   onMouseLeave={()=>{if(!focused.current)setActive(null);}} onFocus={()=>{focused.current=true;select(last);}} onBlur={()=>{focused.current=false;setActive(null);}}
   onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();select((selected??last)+(event.key==='ArrowLeft'?-1:1));}else if(event.key==='Home'||event.key==='End'){event.preventDefault();select(event.key==='Home'?0:last);}else if(event.key==='Escape')setActive(null);}}>
   <desc>{labels.map((_,i)=>`${pointLabels[i]}：${series.map(s=>{const value=s.values[i];return value===null||value===undefined||!Number.isFinite(value)||value<0?'未知':(s.formatDetail??s.format)(value);}).join(' · ')}，${details[i]??''}`).join('\n')}</desc>
   <defs>{series.filter(s=>s.fill).map(s=><linearGradient key={s.id} id={id+'-'+s.id} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity=".08"/><stop offset="100%" stopColor={s.color} stopOpacity="0"/></linearGradient>)}</defs>
   {[0,.5,1].map(r=><g key={r}>
    <line className="statistics-line-grid" x1={left} x2={right} y1={bottom-r*(bottom-top)} y2={bottom-r*(bottom-top)}/>
    {(['left','right'] as const).map(axis=>{const s=series.find(s=>s.axis===axis);return s?<text key={axis} className="statistics-line-axis" style={{fill:s.color}} x={axis==='left'?left-10:right+10} y={bottom-r*(bottom-top)+3} textAnchor={axis==='left'?'end':'start'}>{s.format(scales[axis]!*r)}</text>:null;})}
   </g>)}
   {series.map(s=>{const rows=points(s),path=statisticsLinePath(rows),complete=rows.every(p=>p!==null);return <g key={s.id}>
    {s.fill&&complete&&rows.length>1&&<path d={`${path} L${x(last)},${bottom} L${x(0)},${bottom} Z`} fill={`url(#${id+'-'+s.id})`}/>}
    <path className="statistics-line-stroke" data-series={s.id} d={path} style={{stroke:s.color}}/>
    {rows.map((p,i)=>p&&((rows[i-1]??null)===null&&(rows[i+1]??null)===null||flagged[i])?<circle key={i} cx={p.x} cy={p.y} r="2.4" fill={flagged[i]?'#d4b586':s.color}/>:null)}
   </g>;})}
   {selected!==null&&<g><line className="statistics-line-guide" x1={x(selected)} x2={x(selected)} y1={top} y2={bottom}/>{series.map(s=>{const value=s.values[selected];return value!==null&&value!==undefined&&Number.isFinite(value)&&value>=0?<circle key={s.id} className="statistics-line-active" cx={x(selected)} cy={y(value,s.axis)} r="3.5" style={{stroke:s.color}}/>:null;})}</g>}
   {labels.map((text,i)=>i===0||i===last||labels.length>10&&i===Math.round(last/2)?<text className="statistics-line-label" key={i} x={x(i)} y={172} textAnchor={i===0?'start':i===last?'end':'middle'}>{text}</text>:null)}
  </svg>
  {selected!==null&&<div className={'statistics-line-tooltip'+(selected<last/2?' align-right':'')} id={id+'-tip'} role="tooltip"><b>{pointLabels[selected]}</b>{details[selected]&&<small>{details[selected]}</small>}{series.map(s=>{const v=s.values[selected];return <span key={s.id}><i style={{background:s.color}}/>{s.label}<strong>{v===null||v===undefined||!Number.isFinite(v)||v<0?'未知':(s.formatDetail??s.format)(v)}</strong></span>;})}</div>}
 </div>;
}
