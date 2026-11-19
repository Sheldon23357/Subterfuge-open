import {createPortal} from 'react-dom';
import {NeuralSearchBackdrop} from './NeuralSearchBackdrop.js';
import {searchActionDetails} from './live-search-details.js';
import {placeSearchNodes,searchConnectionPath,searchNetworkScene,searchNetworkSelection,searchNetworkEdges} from './live-search-network.js';
import React,{useId,useEffect,useRef,useState} from 'react';
import type {BotLiveSnapshot,BotSearchProgress} from '../../contracts/src/index.js';
import {PLAYER_NAMES} from '../../contracts/src/index.js';

export const liveColors=['#50ead1','#b493ff','#55bfff','#ffd071','#93a8f4'];
export const liveKinds:Record<string,string>={strategy:'战略',diplomacy:'外交',commander:'指挥',attack:'进攻',defense:'防守',economy:'经济',logistics:'调兵',fleet:'舰队',scout:'侦察',hold:'维持',combined:'组合',capture:'攻占',focus:'主攻',transfer:'增援',avoid:'禁攻',configure:'配置',expand:'扩张',mine:'开矿','return-fleet':'返航',launch:'出兵','toggle-mine':'建矿','set-shields':'护盾'};
const statuses:Record<string,string>={running:'处理中',queued:'排队',pending:'待处理',completed:'已完成',accepted:'已接受',underway:'执行中',proposed:'待签署',active:'履约中',unfulfilled:'未完成',rejected:'已拒绝',withdrawn:'已撤回',superseded:'已反提替代',review:'待复核',failed:'失败',cancelled:'已取消',interrupted:'未完成',component:'组合组成，单项评估未提供',unknown:'未知',invalid:'未通过',protected:'受约束',evaluated:'已评估',blocked:'受阻',expired:'过期',confirmed:'已确认',negotiating:'协商中',fulfilled:'已履行',terminated:'已终止',violated:'已违反'};
export const liveLabel=(s:string)=>statuses[s]??liveKinds[s]??s;
export const liveNumber=(n:number|null|undefined)=>n===undefined||n===null?'—':n.toLocaleString('zh-CN',{maximumFractionDigits:1});
const short=(s:string,n=9)=>s.length>n?s.slice(0,n)+'…':s;
const point=(cx:number,cy:number,r:number,a:number)=>({x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r});

function Packets({path,color,count=3}:{path:string;color:string;count?:number}){
 const uid=useId().replace(/:/g,'');
 return <g style={{color}} pointerEvents="none"><defs><linearGradient id={`${uid}-tail`}><stop stopColor={color} stopOpacity="0"/><stop offset=".75" stopColor={color} stopOpacity=".8"/><stop offset="1" stopColor="#f4ffff"/></linearGradient></defs>{Array.from({length:count},(_,i)=><g key={i} className="live-particle"><rect x="-20" y="-1.4" width="22" height="2.8" rx="1.4" fill={`url(#${uid}-tail)`}/><circle r="2.1" fill="#e4ffff"/><circle r="4.5" fill={color} opacity=".2"/><animateMotion path={path} rotate="auto" dur="2.1s" begin={`${-i*.7}s`} repeatCount="indefinite"/></g>)}</g>;
}
function Beam({path,color,active}:{path:string;color:string;active:boolean}){
 return <g style={{color}}><path d={path} fill="none" stroke={color} strokeWidth={active?9:1} opacity={active?.045:.13}/>{active&&<><path d={path} fill="none" stroke={color} strokeWidth="4" opacity=".14"/><path d={path} fill="none" stroke={color} strokeWidth="1.2" opacity=".85" className="live-flow-line"/><Packets path={path} color={color}/></>}</g>;
}
function Rotor({x,y,r,color,on}:{x:number;y:number;r:number;color:string;on:boolean}){
 return <g style={{color}}><circle cx={x} cy={y} r={r} className="live-track"/>{on&&<><circle cx={x} cy={y} r={r+5} fill="none" stroke={color} className="live-impact" style={{transformOrigin:`${x}px ${y}px`}}/><circle cx={x} cy={y} r={r+2} fill="none" stroke={color} strokeWidth="6" opacity=".05"/></>}<g className={on?'live-orbit live-lit-rotor':'live-idle-rotor'} style={{transformOrigin:`${x}px ${y}px`}}><circle cx={x} cy={y} r={r} fill="none" stroke="currentColor" strokeWidth="1.7" strokeDasharray={`${r*1.8} ${r*.7} 3 ${r*.7}`} opacity={on?1:.38}/><circle cx={x+r} cy={y} r="2.5" fill="currentColor"/></g><circle cx={x} cy={y} r={r-7} fill="none" stroke="currentColor" strokeOpacity=".15" strokeDasharray="1 5"/></g>;
}
export function LivePipeline({active,searchActive,modelActive,executing,phase,hasDirective,hasDecision,enabled=true,tasks=[],backgroundQueued=0,programTool=null,hasReceipts=false,planningSync,lane:selectedLane}:{active:boolean;searchActive:boolean;modelActive:boolean;executing:boolean;phase:string;hasDirective:boolean;hasDecision:boolean;enabled?:boolean;tasks?:BotLiveSnapshot['tasks'];backgroundQueued?:number;programTool?:string|null;hasReceipts?:boolean;planningSync?:boolean;lane?:'ai'|'program'}){
 const inference=enabled&&modelActive&&tasks.some(t=>t.status==='running');
 const queued=enabled&&modelActive&&tasks.some(t=>t.status==='queued');
 const pending=enabled&&backgroundQueued>0;
 const submit=enabled&&active&&executing&&['order','batch'].includes(programTool??'');
 const searching=enabled&&active&&searchActive;
 const observing=enabled&&active&&(phase==='后台观察'||phase==='同步授权事实'&&planningSync===false);
 const reporting=enabled&&active&&phase==='就绪上报';
 const finishing=enabled&&active&&executing&&programTool==='finish';
 const internal=enabled&&active&&executing&&!submit&&!finishing;
 const phaseLabel=({discovery:'候选发现',refinement:'兵力细化',combination:'组合搜索',continuation:'补充搜索',stress:'对手反应测试'} as Record<string,string>)[phase]??phase;
 const aiStatus=!enabled?'已停止':inference?'模型处理中':queued?'模型排队':pending?'待调度':modelActive?'后台处理中':'待命 · 监听局势';
 const programStatus=!enabled?'已停止':submit?'复核与提交':executing&&active?programTool==='say'?'消息提交':programTool==='finish'?'本轮收尾':'内部更新':active?phaseLabel:'待命 · 监听局势';
 const ai=[{name:'任务调度',on:pending,ready:false},{name:'模型排队',on:queued,ready:false},{name:'模型处理',on:inference,ready:false},{name:'指导发布',on:false,ready:hasDirective}];
 const program=[{name:observing?'事实同步':'本轮同步',on:observing||enabled&&active&&(planningSync??phase==='同步授权事实'),ready:false},{name:'搜索推演',on:searching,ready:false},{name:internal?(programTool==='say'?'消息提交':'内部更新'):'复核执行',on:submit||internal,ready:false},{name:reporting?'就绪上报':finishing?'本轮收尾':'回执记录',on:reporting||finishing,ready:hasReceipts}];
 const compact=selectedLane==='ai',first=compact?20:28,gap=compact?66:112,cy=compact?17:22,radius=compact?9:13,last=first+gap*3;
 const lane=(key:string,title:string,nodes:typeof ai,color:string,status:string)=><section className={"live-process-lane"+(selectedLane?" is-embedded":"")} data-lane={key} data-active={nodes.some(n=>n.on)} style={{color}} aria-label={title+'独立流程'}>
  <header>{!selectedLane&&<b>{title}</b>}<span><i/>{status}</span></header>
  <div className="live-lane-diagram" style={{maxWidth:compact?240:300}}>
  <svg viewBox={compact?"0 0 240 33":"0 0 400 43"} className="live-lane-svg" role="img" aria-label={title+'：'+nodes.map(n=>n.name+(n.on?'处理中':n.ready?'已有记录':'')).join('、')}>
   <path d={`M${first} ${cy}H${last}`} fill="none" stroke="currentColor" strokeOpacity=".18"/><path d={`M${last} ${cy+radius+2}V${compact?31:41}H${first}V${cy+radius+2}`} fill="none" stroke="currentColor" strokeOpacity=".1" strokeDasharray="2 5"/>
   {nodes.map((n,i)=>{const x=first+i*gap;return <g key={n.name} data-node={n.name} data-state={n.on?'active':n.ready?'available':'idle'} className={n.on?'is-active':undefined}>
    <title>{`${n.name} · ${n.on?'当前处理中':n.ready?'已有记录':'等待下一次处理'}`}</title>
    <Rotor x={x} y={cy} r={radius} color={color} on={n.on}/><path d={`M${x-5} ${cy}l5-5 5 5-5 5Z`} fill={n.ready?color:color+'20'} stroke={color} strokeOpacity={n.on||n.ready?1:.4}/>
    {i<3&&<Beam path={`M${x+radius+3} ${cy}H${x+gap-radius-3}`} color={color} active={n.on||nodes[i+1]!.on}/>}
   </g>;})}
  </svg>
  <div className="live-lane-labels">{nodes.map((n,i)=><span key={n.name} style={{left:`${(first+i*gap)/(compact?240:400)*100}%`}}>{n.name}</span>)}</div>
  </div>
 </section>;
 if(selectedLane)return selectedLane==='ai'?lane('ai','AI 流程',ai,liveColors[1]!,aiStatus):lane('program','程序流程',program,liveColors[0]!,programStatus);
 return <div className="live-parallel-pipeline" aria-label="AI与程序可独立并行的两条流程" title={`${hasDirective?'已有发布指导':'等待指导'}；${hasDecision?'已有搜索方案':'等待搜索方案'}。AI后台与程序前台分别运行，通过已发布指导及实际事实与回执交换信息。`}>
  {lane('ai','AI 流程',ai,liveColors[1]!,aiStatus)}
  <div className="live-process-exchange" aria-label="已发布指导与事实回执的双向交换"><span>指导 →</span><svg viewBox="0 0 58 24" aria-hidden="true"><path d="M2 6H54l-4-4M54 18H4l4 4" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 3"/></svg><span>← 事实 / 回执</span></div>
  {lane('program','程序流程',program,liveColors[0]!,programStatus)}
 </div>;
}

export function GuidanceGraphic({data,active,calls=null}:{data:BotLiveSnapshot|null;active:boolean;calls?:Record<string,number|null>|null}){
 const uid=useId().replace(/:/g,'');
 const tasks=data?.tasks??[],roles=['strategy','diplomacy','commander'];
 return <svg viewBox="0 -12 240 204" className="live-guidance-svg" role="img" aria-label="AI指导任务轨道"><title>{data?.directive?.summary??'尚无已发布指导'}</title>
  <defs><radialGradient id={uid}><stop stopColor="#b493ff" stopOpacity=".2"/><stop offset="1" stopColor="#b493ff" stopOpacity="0"/></radialGradient></defs><circle cx="120" cy="90" r="84" fill={`url(#${uid})`}/>
  <ellipse cx="120" cy="90" rx="93" ry="51" fill="none" stroke="#b493ff" strokeOpacity=".2" transform="rotate(-25 120 90)"/><ellipse cx="120" cy="90" rx="93" ry="51" fill="none" stroke="#55bfff" strokeOpacity=".16" transform="rotate(25 120 90)"/>
  <Rotor x={120} y={90} r={39} color={liveColors[1]!} on={active}/><path d="M103 80l17-10 17 10v20l-17 10-17-10Z" fill="#b493ff18" stroke="#b493ff"/><text x="120" y="94" textAnchor="middle" className="live-svg-core">{data?.directive?'v'+data.directive.version:'AI'}</text>
  {roles.map((role,i)=>{const a=-Math.PI/2+i*Math.PI*2/3,p=point(120,90,76,a),jobs=tasks.filter(t=>t.kind===role),running=active&&jobs.some(t=>['running','queued'].includes(t.status)),d=`M120 90L${p.x} ${p.y}`;return <g key={role}><title>{`${liveKinds[role]}累计已记录调用：${calls?.[role]??'未取得'}；已返回或已发出后失败的调用计数，在途调用记账后更新，排队未发送不计。任务状态：${jobs.length?jobs.map(t=>`${liveLabel(t.status)} · ${t.characters} 字符${t.error?' · '+t.error:''}`).join('；'):'暂无任务'}`}</title><Beam path={d} color={liveColors[i+1]!} active={running}/><circle cx={p.x} cy={p.y} r="15" fill="#182535" stroke={liveColors[i+1]} strokeOpacity={calls?.[role]!=null?1:.28}/><text x={p.x} y={p.y+4} textAnchor="middle" className="live-svg-value" style={{fontSize:Math.min(11,27/Math.max(1,(calls?.[role]?.toLocaleString('zh-CN').length??1)*.62))}}>{calls?.[role]!=null?calls[role]!.toLocaleString('zh-CN'):'—'}</text><text x={p.x} y={p.y+28} textAnchor="middle" className="live-svg-micro">{liveKinds[role]}</text></g>;})}
  {(data?.directive?.objectives??[]).slice(0,16).map((o,i)=>{const p=point(120,90,48,i*Math.PI/8);return <circle key={o.kind+i} cx={p.x} cy={p.y} r="2" fill={liveColors[i%5]}><title>{`${liveKinds[o.kind]??o.kind} · ${o.targets.map(t=>data?.names[t]??t).join('、')} · 优先级 ${o.priority} · ${o.reason}`}</title></circle>;})}
 </svg>;
}

const protocolTypes:Record<string,{label:string;color:string;glyph:string}>={
 agreement:{label:'外交约定',color:'#c2a0ff',glyph:'M-2-2a3 3 0 1 0 0 4M2-2a3 3 0 1 1 0 4M-3 0H3'},
 truce:{label:'据点停战协议',color:'#5fe2af',glyph:'M0-6L5-3V1Q5 4 0 6Q-5 4-5 1V-3ZM-2 0L0 2L3-2'},
 transfer:{label:'调兵增援',color:'#5bc8ff',glyph:'M-6-2H5L2-5M5 2H-5L-2 5'},
 focus:{label:'集中主攻',color:'#ffd36a',glyph:'M0-6V-3M0 3V6M-6 0H-3M3 0H6M-3-3H3V3H-3Z'},
 avoid:{label:'禁止派兵',color:'#d2b16b',glyph:'M5 0A5 5 0 1 1-5 0A5 5 0 1 1 5 0M-3.5-3.5L3.5 3.5'},
 'return-fleet':{label:'舰队返航',color:'#ffa66c',glyph:'M-5-1H2Q6-1 6 3T2 6M-5-1L-1-5M-5-1L-1 3'},
 capture:{label:'攻占目标',color:'#82b7ef',glyph:'M-4 6V-6M-4-5H5L2-1L5 2H-4'},
 configure:{label:'配置约束',color:'#a4c5ff',glyph:'M-5-5V5M0-5V5M5-5V5M-7-2H-3M-2 2H2M3-1H7'},
};
export function ProtocolGraphic({data,active}:{data:BotLiveSnapshot|null;active:boolean}){
 const tipId=useId(),[tip,setTip]=useState<{id:string;left:number;bottom:number;width:number}|null>(null),hideTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const cancelHide=()=>clearTimeout(hideTimer.current);
 const hide=()=>{cancelHide();hideTimer.current=setTimeout(()=>setTip(null),120);};
 useEffect(()=>()=>clearTimeout(hideTimer.current),[]);
 const show=(id:string,element:SVGSVGElement)=>{cancelHide();const rect=(element.closest('.live-protocol')??element).getBoundingClientRect(),width=Math.min(300,Math.max(120,rect.width-20),window.innerWidth-24);setTip({id,width,left:Math.max(12,Math.min(window.innerWidth-width-12,rect.left+10)),bottom:Math.max(12,window.innerHeight-rect.bottom+10)});};
 const player=(p:number)=>PLAYER_NAMES[p]??`玩家 ${p+1}`;
 const agreements=data?.diplomacy?data.diplomacy.agreements.filter(a=>['proposed','active'].includes(a.status)).map(a=>({id:a.id,type:a.terms.kind==='ceasefire'?'truce':'agreement',state:a.status,text:`${a.players.map(player).join('与')}签订${a.terms.kind==='ceasefire'?`停战：${a.terms.outposts.map(id=>data.names[id]??id).join('、')}`:`夹击协议，共同攻击${player(a.terms.enemy)}；${a.players.map((p,i)=>`${player(p)}占领据点 ${a.progress[i]}/1`).join('，')}`}；截止第 ${a.deadline} 天${a.subsidy?`；${player(a.subsidy.payer)}签署时支付 ${a.subsidy.amount} 矿产`:''}`})):(data?.directive?.agreements??[]).filter(a=>['proposed','negotiating','confirmed'].includes(a.status)).map((a,i)=>({id:`agreement-${i}`,type:a.forbidAttack?'truce':'agreement',state:a.status,text:a.summary}));
 const intents=(data?.intents??[]).filter(i=>['pending','running','blocked'].includes(i.status));
 const items=[...agreements,...intents.map(i=>({id:i.id,type:i.kind,state:i.status,text:`${i.description??(i.target?data?.names[i.target]??i.target:'')} · ${i.reason}`}))];
 const hovered=items.find(item=>item.id===tip?.id),hoverType=hovered?(protocolTypes[hovered.type]??protocolTypes.agreement!):null;
 return <><div className="live-protocol-content" aria-label={`外交协议 ${agreements.length}，语义意图 ${intents.length}`}>
  <div className="live-protocol-grid">
  {Array.from({length:Math.max(10,Math.ceil(items.length/5)*5)},(_,i)=>{
   const item=items[i],type=item?(protocolTypes[item.type]??protocolTypes.agreement!):null,color=type?.color??'#273d50';
   const d='M24 5l17 10v20L24 45 7 35V15Z',processing=!!item&&active&&['pending','running','queued','negotiating'].includes(item.state);
   const indicator=item&&['failed','violated'].includes(item.state)?'#ff6f82':item&&['active','confirmed','completed','fulfilled','accepted'].includes(item.state)?'#68e4b1':item&&['pending','running','queued','proposed','negotiating','blocked'].includes(item.state)?'#ffd36a':'#8296aa';
   return <svg key={item?.id??i} viewBox="0 0 48 50" style={{color}} role="img" tabIndex={item?0:undefined} aria-label={item?`${type!.label} · ${liveLabel(item.state)} · ${item.text}`:'未使用协议槽'} aria-describedby={item&&tip?.id===item.id?tipId:undefined} onPointerEnter={event=>{if(item)show(item.id,event.currentTarget);}} onPointerLeave={hide} onFocus={event=>{if(item)show(item.id,event.currentTarget);}} onBlur={()=>setTip(null)} onKeyDown={event=>{if(event.key==='Escape')setTip(null);}}><path d={d} fill={item?color+'14':'none'} stroke={color} strokeOpacity={item?.7:.45}/>{item&&<>
    <path d={type!.glyph} transform="translate(24 25) scale(1.65)" fill="none" stroke={color} strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" className={processing?'live-protocol-glyph live-core-pulse':'live-protocol-glyph'}/>
    <circle cx="37" cy="38" r="3.1" fill={indicator} stroke="#13202d" strokeWidth="1"/>
    {processing&&<path d={d} fill="none" stroke={color} className="live-flow-line"/>}
   </>}</svg>;
  })}
  </div>
  <div className="live-protocol-counts"><span>协议 {agreements.length}</span><span>意图 {intents.length}</span></div>
 </div>{tip&&hovered&&createPortal(<aside id={tipId} className="live-protocol-tooltip" role="tooltip" style={{left:tip.left,bottom:tip.bottom,width:tip.width}} onPointerEnter={cancelHide} onPointerLeave={hide}><header><b style={{color:hoverType!.color}}>{hoverType!.label}</b><span>{liveLabel(hovered.state)}</span></header><p>{hovered.text}</p></aside>,document.body)}</>;
}

export function SearchNetwork({branches,selected,names,active,stage,embedded=false}:{branches:BotSearchProgress['branches'];selected:string|undefined;names:Record<string,string>;active:boolean;stage:string;embedded?:boolean}){
 const uid=useId().replace(/:/g,''),svg=useRef<SVGSVGElement|null>(null),slots=useRef(new Map<string,{x:number;y:number}>()),revealDelays=useRef(new Map<string,number>());
 const [size,setSize]=useState({width:800,height:360}),[inspected,setInspected]=useState<string>(),[hovered,setHovered]=useState<string>();
 useEffect(()=>{const el=svg.current;if(!el)return;const observer=new ResizeObserver(([entry])=>{if(entry&&entry.contentRect.width>0&&entry.contentRect.height>0){const width=Math.round(entry.contentRect.width),height=Math.round(entry.contentRect.height);setSize(old=>old.width===width&&old.height===height?old:{width,height});}});observer.observe(el);return()=>observer.disconnect();},[]);
 const scene=searchNetworkScene(branches),focused=new Set(searchNetworkSelection(scene,inspected??selected)),finals=new Set(searchNetworkSelection(scene,selected));
 slots.current=placeSearchNodes(scene.nodes,slots.current);
 const {width:w,height:h}=size,cx=w/2,cy=h*.5,edges=searchNetworkEdges(scene,slots.current);
 const inspectedBranch=branches.find(b=>b.id===(inspected??selected))??scene.nodes.find(b=>b.id===(inspected??selected));
 const bundle=scene.bundles.find(b=>b.branch.id===(inspected??selected));
 const inspection=inspectedBranch?`${inspectedBranch.id===selected?'最终方案':'查看候选'} · ${bundle?`组合 · ${bundle.members.length?bundle.members.length+'个组成候选':'组成未记录'}`:liveKinds[inspectedBranch.kind]??inspectedBranch.kind} · ${inspectedBranch.targets.map(t=>names[t]??short(t,10)).join('、')||(inspectedBranch.kind==='hold'?'维持现有行动':'目标未记录')} · ${liveLabel(inspectedBranch.status)} · 条件评分 ${liveNumber(inspectedBranch.utility)}`:'点击圆点查看候选；组合选择会同时高亮其组成候选';
 const colors:Record<string,string>={attack:liveColors[0]!,defense:liveColors[1]!,economy:liveColors[2]!,logistics:liveColors[3]!,fleet:liveColors[4]!,scout:'#a5c2cd',hold:'#8cb7bd'};
 const regions=['attack','defense','economy','logistics','fleet'];
 const hoverBranch=scene.nodes.find(b=>b.id===hovered),hoverPoint=hovered?slots.current.get(hovered):undefined;
 const hoverTop=hoverPoint?Math.max(8,Math.min(h-170,hoverPoint.y*h-36)):8;
 return <div className="live-network-scene">
 <svg ref={svg} viewBox={`0 0 ${w} ${h}`} className="live-network" role="group" aria-label={`${scene.nodes.length} 个候选节点，${scene.bundles.length} 个组合方案，点击圆点查看候选`}>
  <defs>{Object.entries(colors).map(([kind,color])=><radialGradient id={`${uid}-neuron-${kind}`} key={kind}><stop stopColor="#eaffff" stopOpacity=".7"/><stop offset=".2" stopColor={color} stopOpacity=".5"/><stop offset=".48" stopColor={color} stopOpacity=".12"/><stop offset="1" stopColor={color} stopOpacity="0"/></radialGradient>)}</defs>
  {!embedded&&<NeuralSearchBackdrop width={w} height={h}/>}
  {stage&&<text x={cx} y="15" textAnchor="middle" className="live-svg-micro">{stage}</text>}
  <g className="live-neural-edges" aria-label="候选关联：同目标、同来源或真实组合，不代表搜索父子关系">
   {edges.map(e=>{const a=slots.current.get(e.a)!,b=slots.current.get(e.b)!;
    const focus=e.bundles.includes(inspected??selected??'')||(focused.has(e.a)||focused.has(e.b))&&e.relation!=='bundle',final=e.bundles.includes(selected??''),color=focus&&inspected?liveColors[2]!:final?liveColors[0]!:'#7dabc0';
    const d=searchConnectionPath(a,b,w,h);
    const runner=active?scene.nodes.find(n=>(n.id===e.a||n.id===e.b)&&n.status==='running'):undefined,running=!!runner,pulseColor=colors[runner?.kind??'']??color;
    return <g key={e.a+'|'+e.b} data-relation={e.relation} data-highlighted={focus||final} pointerEvents="stroke" style={{color:running?pulseColor:color}}><title>{(e.relation==='bundle'?'同属真实组合':e.relation==='source'?'共享出兵来源':'共享目标')+'，无方向关联'}</title>{(focus||final||running)&&<><path d={d} fill="none" stroke={color} strokeWidth="12" opacity=".045"/><path d={d} fill="none" stroke={color} strokeWidth="5" opacity=".12"/></>}<path d={d} fill="none" stroke={running?pulseColor:color} strokeWidth={focus||final?1.5:running?1.1:.7} strokeOpacity={focus||final?.8:running?.65:e.relation==='bundle'?.22:.28} strokeDasharray={e.relation==='source'?'2 5':undefined} className={running?'live-neural-signal':undefined}/>{running&&<Packets path={d} color={pulseColor} count={1}/>}</g>;
   })}
  </g>
  {scene.nodes.map(b=>{const normalized=slots.current.get(b.id)!,p={x:normalized.x*w,y:normalized.y*h},hold=b.kind==='hold',chosen=focused.has(b.id),final=finals.has(b.id),kindColor=colors[b.kind]??colors.fleet!,stateColor=['invalid','unknown','protected','interrupted'].includes(b.status)?'#7b91a5':kindColor,glow=inspected&&chosen?liveColors[2]!:liveColors[0]!,running=active&&b.status==='running',r=hold?Math.max(13,Math.min(22,h*.11)):chosen||running?10:7;
   if(!revealDelays.current.has(b.id))revealDelays.current.set(b.id,Math.floor(Math.random()*401));
   return <g key={b.id} data-branch-id={b.id} data-network-role={hold?'hold':'candidate'} data-final-member={final} style={{color:glow,'--node-reveal-delay':`${revealDelays.current.get(b.id)}ms`} as React.CSSProperties} tabIndex={0} role="button" aria-pressed={chosen} aria-describedby={hovered===b.id?uid+'-tip':undefined} aria-label={`${liveKinds[b.kind]??b.kind} ${b.targets.map(t=>names[t]??short(t,10)).join('、')} · ${liveLabel(b.status)}${final?' · 最终方案组成':''}`} onPointerEnter={()=>setHovered(b.id)} onPointerLeave={()=>{if(inspected!==b.id)setHovered(undefined);}} onFocus={()=>setHovered(b.id)} onBlur={()=>setHovered(undefined)} onClick={()=>setInspected(b.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setInspected(b.id);}}} className={'live-network-node'+(chosen?' live-selected-branch':'')}>
    <circle cx={p.x} cy={p.y} r={r+(chosen?30:17)} fill={`url(#${uid}-neuron-${b.kind in colors?b.kind:'fleet'})`} opacity={chosen?.8:.48} pointerEvents="none"/>
    <circle cx={p.x} cy={p.y} r={Math.max(18,r+7)} fill="transparent" className="live-node-hit"/>
    <circle cx={p.x} cy={p.y} r={chosen?r+10:final?r+6:0} fill={glow} opacity=".12" pointerEvents="none"/>
    {final&&<circle cx={p.x} cy={p.y} r={r+5} fill="none" stroke={liveColors[0]} strokeWidth="1.5" pointerEvents="none"/>}
    <circle cx={p.x} cy={p.y} r={r+6} fill="none" stroke={glow} strokeWidth="2" className="live-node-ring" opacity={chosen?1:0} pointerEvents="none"/>
    <circle cx={p.x} cy={p.y} r={r+4} fill={kindColor} opacity=".055" pointerEvents="none"/>
    <circle cx={p.x} cy={p.y} r={r} fill={stateColor} fillOpacity={b.status==='component'?.12:chosen?.65:.24} stroke={kindColor} strokeWidth="1.5" className="live-node-dot" pointerEvents="none"/>
    {!hold&&<><circle cx={p.x} cy={p.y} r={r+3} fill="none" stroke={kindColor} strokeOpacity={chosen?.7:.26} strokeWidth=".7" strokeDasharray="4 8 1 5" className={running?'live-neuron-spin':undefined} style={{transformOrigin:`${p.x}px ${p.y}px`}} pointerEvents="none"/><circle cx={p.x} cy={p.y} r={chosen?3:1.9} fill={stateColor} opacity={b.status==='component'?.4:.9} pointerEvents="none"/><circle cx={p.x-.7} cy={p.y-.7} r={chosen?1.3:.8} fill="#f0ffff" opacity=".8" pointerEvents="none"/></>}
    {hold&&<><path d={`M${p.x-6} ${p.y}H${p.x+6}`} stroke="#d2ebef" strokeWidth="1.5" pointerEvents="none"/><text x={p.x} y={p.y+r+18} textAnchor="middle" className="live-svg-label" pointerEvents="none">维持</text></>}
    {hold&&<><circle cx={p.x} cy={p.y} r={r+12} fill="none" stroke={kindColor} strokeOpacity=".25" strokeDasharray="17 9 2 8"/><circle cx={p.x} cy={p.y} r={r+19} fill="none" stroke={kindColor} strokeOpacity=".09" strokeDasharray="1 7"/></>}
    {chosen&&<circle key={inspected??'final'} cx={p.x} cy={p.y} r={r+8} fill="none" stroke={glow} strokeWidth="1" className="live-neuron-select-wave" style={{transformOrigin:`${p.x}px ${p.y}px`}} pointerEvents="none"/>}
    {running&&<><circle cx={p.x} cy={p.y} r={r+5} fill="none" stroke={kindColor} className="live-core-pulse" pointerEvents="none"/><circle cx={p.x} cy={p.y} r={r+9} fill="none" stroke={kindColor} className="live-neuron-discharge" style={{transformOrigin:`${p.x}px ${p.y}px`}} pointerEvents="none"/></>}
   </g>;
  })}
  {!scene.nodes.some(b=>b.kind==='hold')&&<g pointerEvents="none"><circle cx={cx} cy={cy} r="18" fill="#172a34" stroke="#6b8998" strokeOpacity=".4"/><text x={cx} y={cy+4} textAnchor="middle" className="live-svg-micro">维持</text></g>}
  <g className="live-network-legend" transform={`translate(${w-87} ${h-90})`} aria-label="节点类别图例" pointerEvents="none">{regions.map((kind,i)=><g key={kind} transform={`translate(0 ${i*20})`}><circle cx="0" cy="-3" r="3" fill={colors[kind]}/><text x="11" y="0" className="live-svg-micro" style={{fill:colors[kind]}}>{kind==='fleet'?'舰队操作':liveKinds[kind]}</text></g>)}</g>
 </svg>
 {hoverBranch&&hoverPoint&&<aside id={uid+'-tip'} className="live-network-tooltip" role="tooltip" style={{left:Math.max(8,Math.min(w-290,hoverPoint.x*w+(hoverPoint.x<.5?18:-298))),top:hoverTop,maxHeight:Math.max(60,h-hoverTop-8)}}><header><b>{liveKinds[hoverBranch.kind]??hoverBranch.kind}</b><span>{liveLabel(hoverBranch.status)}</span></header>{searchActionDetails(hoverBranch,names).map((line,i)=><p key={i}>{line}</p>)}{hoverBranch.reasons?.map((reason,i)=><small key={i}>{reason}</small>)}<footer>单项条件评分 {liveNumber(hoverBranch.utility)}</footer></aside>}
 {scene.bundles.length>0&&<div className="live-network-bundles" aria-label="组合候选"><span>组合</span>{scene.bundles.map((b,i)=><button type="button" key={b.branch.id} data-bundle-id={b.branch.id} aria-pressed={(inspected??selected)===b.branch.id} data-final={selected===b.branch.id} onClick={()=>setInspected(b.branch.id)} title={`${liveLabel(b.branch.status)} · 组合条件评分 ${liveNumber(b.branch.utility)}${b.members.length?'':' · 此记录未提供组成信息'}`}>{i+1}</button>)}</div>}
 <div className="live-network-inspection" title={inspection+(inspectedBranch?'\n'+searchActionDetails(inspectedBranch,names).join('\n'):'')}>{inspection}{inspectedBranch?' · '+searchActionDetails(inspectedBranch,names).join('；'):''}</div>
 </div>;
}

export function PlanGraphic({data,active}:{data:BotLiveSnapshot|null;active:boolean}){
 const decision=data?.decision;
 return <div className="live-plan-summary">
  <div className="live-plan-current"><svg viewBox="0 0 52 52" aria-hidden="true"><Rotor x={26} y={26} r={18} color={liveColors[2]!} on={active}/><path d="M19 26l5 5 10-12" fill="none" stroke="#79d4f5" strokeWidth="1.6"/></svg><div><strong>{decision?liveKinds[decision.kind]??decision.kind:'等待方案'}</strong><span>{decision?.drafts.length?`${decision.drafts.length} 项方案指令`:decision?'本轮不新增操作':'等待搜索结果'}</span></div></div>
 </div>;
}
