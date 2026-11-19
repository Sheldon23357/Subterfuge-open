import React,{useEffect,useRef,useState} from 'react';
import type {ConsoleRequest} from './AgentConnectionWizard.js';
import {LiveSeatCache} from './live-seat-cache.js';

interface Instruction {id:string;kind:string;description:string;state:string;reason:string;delivery?:'issued'|'pending'|'rejected'|'unconfirmed'|'cancelled'|'skipped'}
interface InstructionGroup {id:string;round:number|null;tick:number|null;instructions:Instruction[]}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown)=>typeof v==='string'?v:null;
export function liveGuidanceCalls(value:unknown):Record<string,number|null>|null{
 const hybrid=record(value)&&record(value.hybrid)?value.hybrid:null;
 const state=hybrid&&record(hybrid.state)?hybrid.state:null;
 if(!state||!record(state.usage))return null;
 return Object.fromEntries(['strategy','diplomacy','commander'].map(kind=>{const entry=state.usage as Record<string,unknown>,row=entry[kind];return [kind,row===undefined?0:record(row)&&Number.isSafeInteger(row.calls)&&Number(row.calls)>=0?Number(row.calls):null];}));
}
export const readableExecutionText=(value:string)=>value.replace(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi,id=>`代号 ${id.slice(0,8).toUpperCase()}`).replace(/p(\d+)-([a-f0-9]{24,})/gi,(_,owner:string,hash:string)=>`F${Number(owner)+1}-${hash.slice(0,8).toUpperCase()}`).replace(/\b[a-f0-9]{24,}\b/gi,hash=>`代号 ${hash.slice(0,8).toUpperCase()}`);
const states:Record<string,string>={proposal:'方案',suggestion:'建议',proposed:'待提交',accepted:'已接受',underway:'执行中',completed:'已完成',failed:'失败',cancelled:'已取消',skipped:'未执行',unknown:'结果未知',issued:'已下达',pending:'待下达',rejected:'未下达',unconfirmed:'提交未确认'};

/** Presentation of dispatch only. Keep transport outcome and settlement tracking untouched. */
export function instructionDeliveryState(command:Record<string,unknown>|undefined,operationStatus:unknown,operation?:Record<string,unknown>):NonNullable<Instruction['delivery']>{
 if(command&&(['accepted','underway','completed'].includes(String(command.state))||['orderId','fleetId'].some(k=>typeof command[k]==='string'&&String(command[k]).length>0)||Number.isSafeInteger(command.evidenceId)&&Number(command.evidenceId)>=0))return 'issued';
 if(command?.state==='unknown')return 'unconfirmed';
 if(command?.state==='cancelled')return 'cancelled';
 if(command?.state==='failed')return command.reason==='未执行'?'skipped':'rejected';
 // Only an explicitly cancelled, wholly unsubmitted operation can settle a
 // missing child. Partial receipts and legacy submission evidence stay unknown.
 if(!command&&operationStatus==='cancelled'&&operation&&!['commands','orders','fleets','receiptIds'].some(key=>Array.isArray(operation[key])&&(operation[key] as unknown[]).length>0))return 'cancelled';
 return operationStatus==='proposed'?'pending':'unconfirmed';
}

export function describeLiveInstruction(action:Record<string,unknown>,names:Record<string,string>):Pick<Instruction,'kind'|'description'> {
 const name=(v:unknown)=>typeof v==='string'?readableExecutionText(names[v]??v):'未记录';
 switch(action.kind){
  case 'launch':return {kind:'出兵',description:`${name(action.source)} → ${name(action.destination)} · ${typeof action.drillers==='number'?action.drillers.toLocaleString()+' 兵':'兵力未记录'}`};
  case 'return-fleet':return {kind:'返航',description:`舰队 ${readableExecutionText(text(action.fleetId)??'未记录')}`};
  case 'cancel-launch':return {kind:'取消出航',description:`舰队 ${readableExecutionText(text(action.fleetId)??'未记录')}`};
  case 'set-shields':return {kind:action.enabled===true?'开启护盾':action.enabled===false?'关闭护盾':'设置护盾',description:name(action.outpostId)+(typeof action.enabled==='boolean'?'':' · 开关未记录')};
  case 'toggle-mine':return {kind:'切换矿场',description:name(action.outpostId)};
  case 'check-in':return {kind:'确认活跃',description:'提交活跃状态确认'};
  case 'cancel-inactivity-warning':return {kind:'取消警告',description:'取消不活跃警告'};
  default:return {kind:'操作',description:`${text(action.kind)??'类型未记录'} · ${name(action.outpostId??action.fleetId??action.destination??action.source)}`};
 }
}

/** Read the existing mode diagnostic, retaining each child's own receipt state. */
export function liveInstructionGroups(value:unknown):{generation:string;groups:InstructionGroup[]} {
 if(!record(value)||typeof value.generation!=='string')throw Error('执行记录格式不匹配');
 const names:Record<string,string>=Object.create(null);
 if(record(value.outpostNames))for(const [id,name] of Object.entries(value.outpostNames))if(typeof name==='string')names[id]=name;
 const hybrid=record(value.hybrid)?value.hybrid:null;
 const executionHistory=Array.isArray(value.executionHistory)?value.executionHistory.filter(record):null;
 const operations=Array.isArray(hybrid?.operations)?hybrid.operations.filter(record):[];
 const tickOf=(o:Record<string,unknown>)=>record(o.basis)&&typeof o.basis.tick==='number'?o.basis.tick:-Infinity;
 const candidates=operations.filter(o=>Array.isArray(o.drafts)&&o.drafts.length).reverse().sort((a,b)=>tickOf(b)-tickOf(a));
 const groups=executionHistory?executionHistory.map((group,index)=>({id:text(group.id)??String(index),round:typeof group.round==='number'?group.round:null,tick:typeof group.tick==='number'?group.tick:null,
  instructions:(Array.isArray(group.instructions)?group.instructions:[]).filter(record).flatMap((instruction,i)=>{
   if(!record(instruction.action))return [];
   const state=text(instruction.state)??'unknown';
   const delivery:NonNullable<Instruction['delivery']>=state==='skipped'?'skipped':instructionDeliveryState({state},state);
   return [{id:text(instruction.id)??String(i),...describeLiveInstruction(instruction.action,names),state,delivery,reason:readableExecutionText(text(instruction.reason)??'')}];
  })})):candidates.map((operation,index)=>{
  const commands=Array.isArray(operation.commands)?operation.commands.filter(record):[];
  const basis=record(operation.basis)?operation.basis:{};
  const instructions=(operation.drafts as unknown[]).filter(record).flatMap((draft,i)=>{
   if(!record(draft.action))return [];
   const receipt=commands.find(c=>c.draftId===draft.id);
   const state=receipt&&typeof receipt.state==='string'&&Object.hasOwn(states,receipt.state)?receipt.state:operation.status==='proposed'?'proposed':'unknown';
   const delivery=instructionDeliveryState(receipt,operation.status,operation);
   const reason=receipt?readableExecutionText(text(receipt.reason)??''):delivery==='cancelled'?'方案在提交前已取消':state==='unknown'?'尚无该指令的独立下达确认':'';
   return [{id:text(draft.id)??String(i),...describeLiveInstruction(draft.action,names),state,delivery,reason}];
  });
  return {id:text(operation.id)??String(index),round:/^operation-(\d+)(?:-internal)?$/.test(String(operation.id))?Number(/^operation-(\d+)/.exec(String(operation.id))![1]):null,tick:typeof basis.tick==='number'?basis.tick:null,instructions};
 }).filter(g=>g.instructions.length);
 const byRound=new Map<string,InstructionGroup>();
 for(const group of groups){
  const id=group.round===null?group.id:'round-'+group.round,previous=byRound.get(id);
  if(previous)previous.instructions.push(...group.instructions);
  else byRound.set(id,{...group,id});
 }
 return {generation:value.generation,groups:[...byRound.values()].sort((a,b)=>(b.tick??-Infinity)-(a.tick??-Infinity)||(b.round??-1)-(a.round??-1)).slice(0,5)};
}

export function AgentPlanInstructions({id,generation,scope=JSON.stringify([id,generation]),connected,enabled,request,onCalls}:{id:string;generation:string|undefined;scope?:string;connected:boolean;enabled:boolean;request:ConsoleRequest;onCalls?:(calls:Record<string,number|null>|null)=>void}){
 const cache=useRef(new LiveSeatCache<{detail:{generation:string;groups:InstructionGroup[]}|null;error:string}>()),[,refresh]=useState(0);
 const {detail,error}=cache.current.read(id,scope)??{detail:null,error:''};
 const selectedScope=useRef(scope);selectedScope.current=scope;
 const requestRef=useRef(request);requestRef.current=request;
 const callsRef=useRef(onCalls);callsRef.current=onCalls;
 useEffect(()=>{
  if(!connected)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,loading=false;
  const poll=async()=>{
   if(controller.signal.aborted||loading)return;
   if(document.hidden){timer=setTimeout(()=>void poll(),1500);return;}
   loading=true;
   try{
    const page=await requestRef.current<unknown>(`debug/notebook?seat=${encodeURIComponent(id)}&scope=current&limit=1`,undefined,controller.signal);
    const next=liveInstructionGroups(page);
    if(generation&&next.generation!==generation)throw Error('席位绑定已变化，等待同步');
    if(!controller.signal.aborted){const old=cache.current.peek(id,scope);if(cache.current.write(id,scope,{detail:JSON.stringify(old?.detail)===JSON.stringify(next)?old!.detail:next,error:''}))refresh(n=>n+1);if(selectedScope.current===scope)callsRef.current?.(liveGuidanceCalls(page));}
   }catch(e){if(!controller.signal.aborted&&cache.current.write(id,scope,{detail:cache.current.peek(id,scope)?.detail??null,error:e instanceof Error?e.message:'执行记录读取失败'}))refresh(n=>n+1);}
   finally{loading=false;if(!controller.signal.aborted&&enabled)timer=setTimeout(()=>void poll(),1500);}
  };
  const visible=()=>{if(!document.hidden){clearTimeout(timer);void poll();}};
  document.addEventListener('visibilitychange',visible);void poll();
  return()=>{controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
 },[id,generation,scope,connected,enabled]);
 const groups=detail&&(!generation||detail.generation===generation)?detail.groups:[];
 return <div className="live-command-section">
  <div className="live-command-heading"><b>执行指令</b><span title={error||(!connected?'连接中断':'')}>{!connected||error?'上次记录':'最近 5 轮行动'}</span></div>
  <div className="live-command-scroll" tabIndex={0} aria-label="最近五轮有行动的指令记录">
   {groups.map(group=><section className="live-command-group" key={group.id}>
    <div className="live-command-basis"><span>{group.round!==null?`R${group.round}`:'执行记录'}</span><span>{group.tick!==null?`第 ${group.tick} 日 · `:''}{group.instructions.length} 项</span></div>
    {group.instructions.map(command=><div className="live-command" key={group.id+':'+command.id} data-state={command.delivery??command.state}>
     <span className="live-command-icon" aria-hidden="true">{command.kind==='出兵'?'↗':command.kind==='返航'?'↶':command.kind.includes('护盾')?'◇':'⌁'}</span>
     <div className="live-command-content"><div className="live-command-line"><b>{command.kind}</b><small>{states[command.delivery??command.state]??'提交未确认'}</small></div><p>{command.description}</p>{command.reason&&['rejected','unconfirmed','cancelled','skipped'].includes(command.delivery??'')&&<span className="live-command-issue">{command.reason}</span>}</div>
    </div>)}
   </section>)}
   {!groups.length&&<p className="live-command-empty">{error?'下达记录暂不可用':!connected?'连接中断，暂无下达记录':!detail?'正在读取下达记录':'暂无行动记录'}</p>}
  </div>
 </div>;
}
