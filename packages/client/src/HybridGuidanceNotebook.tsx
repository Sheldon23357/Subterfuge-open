import React from 'react';
import {playerNames} from './theme.js';
import {notebookReadableText} from './notebook-display.js';
export interface HybridGuidanceData {
 contractAvoidTargets?:string[];
 observedTick:number;worldDay:number;
 forbiddenPlayers:number[];forbiddenTargets:string[];protectedSources:string[];
 reserves:{source:string;drillers:number}[];
 objectives:{id:string;kind:string;targets:string[];priority:number;reason:string}[];
 attackDefenseFactors:{target:string;factor:number;until?:number}[];
}
export interface DiplomacyNotebookAgreement {
 conversation:string;tick?:number;players?:number[];forbidAttack?:boolean;forbiddenTargets?:string[];status:string;summary:string;internalIntent:string;
 expiresWorldDay?:number|null;jointAttack?:{enemy:number;until:number}|null;
}
const side=(id:number)=>playerNames[id]??`玩家 ${id+1}`;
const statuses:Record<string,string>={none:'未成约',proposed:'提议中',negotiating:'协商中',confirmed:'已确认',fulfilled:'已履行',expired:'已到期',terminated:'已终止',violated:'已违约'};
export function DiplomacyNotebook({agreements,names,worldDay,messages=[]}:{agreements:DiplomacyNotebookAgreement[];names:Record<string,string>;worldDay?:number|undefined;messages?:{conversation?:string;status:string;fulfillment?:{state:string;taskIds:string[];reason:string}}[]}){
 const active=agreements.filter(a=>['proposed','negotiating','confirmed'].includes(a.status)&&(worldDay===undefined||a.expiresWorldDay==null||a.expiresWorldDay>worldDay)&&(worldDay===undefined||a.status==='confirmed'||a.tick===undefined||a.tick+72>worldDay));
 const render=(list:DiplomacyNotebookAgreement[])=><ul className="diagnostic-records">{list.map(a=>{
  const execution=[...messages].reverse().find(m=>m.conversation===a.conversation)?.fulfillment;
  const rules=a.jointAttack?'程序展开夹击目标':a.forbidAttack||a.forbiddenTargets?.length?'禁攻规则生效':null;
  const executionLabel=execution&&execution.state!=='none'?({staged:'暂存，尚未启用',active:execution.taskIds.length?`任务已启用 · ${execution.taskIds.length} 项关联`:'执行规则已启用',blocked:'履约受阻'} as Record<string,string>)[execution.state]??execution.state:rules??(a.status==='confirmed'?'未附程序任务':'尚未达成');
  return <li key={a.conversation}><div className="section-heading"><b>{a.players?.length?a.players.map(side).join('、'):a.conversation==='public'?'公开会话':/^\d+$/.test(a.conversation)?side(Number(a.conversation)):a.conversation}</b><span>{statuses[a.status]??a.status}</span></div>
   <p>{notebookReadableText(a.summary,names)}</p><dl className="diagnostic-facts"><div><dt>协议期限</dt><dd>{a.expiresWorldDay==null?'未约定':`第 ${a.expiresWorldDay} 世界日`}</dd></div>
   {a.jointAttack&&<div><dt>联合进攻</dt><dd>{side(a.jointAttack.enemy)} · 至第 {a.jointAttack.until} 世界日</dd></div>}
   {<div><dt>程序履约</dt><dd>{executionLabel}{execution?.reason&&execution.state!=='none'&&<small> · {execution.reason}</small>}</dd></div>}
   <div><dt>内部真实意图</dt><dd>{notebookReadableText(a.internalIntent,names)||'未记录'}</dd></div></dl>
  </li>;
 })}</ul>;
 return <section className="hybrid-objectives" aria-label="外交协议"><div className="section-heading"><h4>当前协议与提案</h4><span>{active.length} 项</span></div>
 {active.length?render(active):<p className="diagnostic-caption">暂无进行中的协议或提案</p>}
 </section>;
}
export function HybridGuidanceNotebook({value,names}:{value:HybridGuidanceData|null|undefined;names:Record<string,string>}){
 if(!value)return <section className="hybrid-objectives" aria-label="程序执行指导"><h4>程序执行指导</h4><p className="diagnostic-caption">当前观察不可用，尚不能核实生效指导</p></section>;
 const name=(id:string)=>names[id]??id;
 const rows:[string,string,string][]=[
  ...(value.contractAvoidTargets??[]).map((p):[string,string,string]=>['协议守约策略',name(p),'默认不新增攻击；可明确选择背叛，服务器仍记录违约']),
  ...value.forbiddenPlayers.map((p):[string,string,string]=>['禁攻玩家',side(p),'禁止攻击其据点']),
  ...value.forbiddenTargets.map((p):[string,string,string]=>['禁止派兵',name(p),'禁止新增进攻、增援及向该点返航；不撤回在途舰队']),
  ...value.protectedSources.map((p):[string,string,string]=>['保护来源',name(p),'限制调出兵力']),
  ...value.reserves.map((r):[string,string,string]=>['最低留守',name(r.source),`${r.drillers} 兵力`]),
  ...value.attackDefenseFactors.map((r):[string,string,string]=>['夹击估算',name(r.target),`目标防御按 ${Math.round(r.factor*100)}% 估算${r.until===undefined?'':`，抵达须早于第 ${r.until} 世界日`}`]),
 ];
 return <section className="hybrid-objectives" aria-label="程序执行指导"><div className="section-heading"><h4>程序执行指导</h4><span>第 {value.worldDay.toLocaleString('zh-CN',{maximumFractionDigits:2})} 世界日</span></div>
 {!rows.length?<p className="diagnostic-caption">当前没有额外执行约束</p>:<div className="diagnostic-table"><table><thead><tr><th scope="col">规则</th><th scope="col">对象</th><th scope="col">执行要求</th></tr></thead><tbody>{rows.map(([kind,target,rule],i)=><tr key={i}><th scope="row">{kind}</th><td>{target}</td><td>{rule}</td></tr>)}</tbody></table></div>}
 </section>;
}
