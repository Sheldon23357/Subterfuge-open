import React from 'react';
import {notebookDisplayText,notebookReadableText} from './notebook-display.js';
import {DiplomacyNotebook,HybridGuidanceNotebook,type HybridGuidanceData,type DiplomacyNotebookAgreement} from './HybridGuidanceNotebook.js';
import {hybridInstructionRows} from './hybrid-instructions.js';
import {playerNames} from './theme.js';
import type {PlayerDiplomacy,ChatMessage} from '../../contracts/src/index.js';
import {ServerAgreements} from './ServerAgreements.js';
export interface HybridSummaryData {
 diplomacy?:PlayerDiplomacy|null;
 state:{chat?:ChatMessage[];handledMessages?:string[];receiptDelivery?:Record<string,{count:number;lastId:number;unavailable:number}>;betrayAgreements?:string[];diplomacyPressure?:{contacts?:Record<string,{wall:number;tick:number;reviewKey?:string}>;streaks:Record<string,number>;attempts:Record<string,{wall:number;tick:number;peer:number}>};conversations?:Record<string,{summary:string;internalIntent:string;archived:number}>;contractCommands?:{id:string;conversation?:string;basis?:{tick:number};status:string;reason?:string;action:{kind:string;[key:string]:unknown}}[];directive:{version:number;summary:string;reviewOn?:string[];commanderVersion:number;objectives:{id:string;kind:string;targets:string[];priority:number;reason:string}[];agreements:DiplomacyNotebookAgreement[]}|null;intents?:{id:string;version?:number;createdAt?:number;updatedAt?:number;authority?:'model'|'commander';origin?:{kind:'diplomacy';conversation:string;agreementId?:string};spec:{kind:string;reason?:string;target?:string;source?:string;rally?:string;drillers?:number|null;fleetId?:string;until:number;priority?:number;minDrillers?:number|null;maxDrillers?:number|null;maxDrillersPerPlan?:number|null;maintain?:boolean};status:string;reason:string}[];tasks:{id:string;kind:string;status:string;attempt:number;characters:number;error?:string}[];messages:{id:string;conversation?:string;to?:number[]|null;basis?:{tick:number};messageIds?:string[];intentEdits?:unknown;requestId?:string;status:string;text:string;fulfillment?:{state:string;taskIds:string[];reason:string}}[];usage?:Record<string,{calls:number;tokens:number;unknown:number}>}|null;
 feedback:{basis?:{tick:number};selected:string;limitations?:string[];conditionalAlternatives?:unknown;unverified?:unknown;diplomacyNeeds?:{kind:string;targets:string[];opponents:number[];limits:string[];evidence:unknown}[];coverage:{simulations?:number;stopReason?:string};objects:{id:string;kind:string;status:string;available?:number|null}[]}|null;
 guidance?:HybridGuidanceData|null;
 operations:{id:string;objective:string;status:string;issues:string[];basis?:{tick:number};strategyVersion?:number;finishedAt?:number;intentBindings?:{id:string;version:number}[];drafts?:{id:string;issueTick:number;action:Record<string,unknown>}[];orders?:string[];fleets?:string[];receiptIds?:string[];commands?:{draftId:string;requestId:string;state:string;orderId?:string;fleetId?:string;evidenceId?:number;reason?:string}[]}[];
}
const kinds:Record<string,string>={'contract-policy':'协议守约策略',avoid:'禁止派兵','return-fleet':'舰队返航',transfer:'指定调兵',reinforce:'增援',focus:'主攻范围',configure:'配置',capture:'攻占',defend:'防守',mine:'建矿',expand:'扩张','opening-cover':'开局覆盖',hold:'维持',strategy:'战略规划',diplomacy:'外交',commander:'指令转译'};
const statuses:Record<string,string>={running:'处理中',completed:'已完成',ended:'运输已结算结束',failed:'失败',pending:'待发送',accepted:'已接受',unknown:'结果未知',proposed:'已提议',underway:'执行中',review:'待复查',cancelled:'已取消',interrupted:'已中断','blocked-context':'上下文受阻',negotiating:'协商中',confirmed:'已确认',fulfilled:'已履行',expired:'已过期',terminated:'已终止',violated:'已违反',none:'无协议'};
const label=(value:string)=>value==='blocked'?'受阻':statuses[value]??value;
export function hybridTacticLabel(value:string,names:Record<string,string>={}){
 return notebookReadableText(value,names).split('+').map(part=>{
  const [kind,...rest]=part.split(':'),target=rest.join(':');
  const operations:Record<string,string>={resize:'调整待发舰队',review:'复核待发舰队',attrition:'消耗进攻'};
  if(kind&&operations[kind])return operations[kind];
  return (kind&&kinds[kind]?kinds[kind]:kind)+(target?':'+target:'');
 }).join(' + ');
}
export function HybridUsage({usage}:{usage:NonNullable<NonNullable<HybridSummaryData['state']>['usage']>}){
 return <section className="hybrid-usage" aria-label="后台模型用量"><div className="section-heading"><h3>后台模型用量</h3></div><div className="diagnostic-table"><table><thead><tr><th scope="col">任务类型</th><th scope="col">已记录调用</th><th scope="col">已知 Token</th><th scope="col">用量未知</th></tr></thead><tbody>{Object.entries(usage).map(([kind,u])=><tr key={kind}><th scope="row">{kinds[kind]??kind}</th><td>{u.calls.toLocaleString()} 次</td><td>{u.tokens.toLocaleString()}</td><td>{u.unknown.toLocaleString()} 次</td></tr>)}</tbody></table></div></section>;
}
export function HybridSummary({value,names}:{value:HybridSummaryData;names:Record<string,string>}){
 const d=value.state?.directive,display=(text:string)=>notebookDisplayText(text,names),instructions=hybridInstructionRows(value);
 const tasks=value.state?.tasks??[],working=tasks.filter(t=>['queued','running'].includes(t.status));
 const active=value.operations.filter(p=>!['completed','ended','cancelled','failed'].includes(p.status));
 const renderOperations=(operations:typeof active)=><ul className="diagnostic-records">{operations.map(p=><li key={p.id}><div className="section-heading"><b>{hybridTacticLabel(p.objective,names)}</b><span>{label(p.status)}</span></div>{p.issues.length>0&&<p>{display(p.issues.join('；'))}</p>}</li>)}</ul>;
 return <section className="decision-panel hybrid-summary" aria-label="分层协同状态">
  <div className="section-heading"><h3>分层协同</h3></div>
  <div className="hybrid-notebook-top">
  <section className="hybrid-recent-action" aria-label="最近行动"><div className="section-heading"><h4>最近行动</h4><small>{active.length} 项未结束操作</small></div>
   <p className="hybrid-current-tactic">{value.feedback?hybridTacticLabel(value.feedback.selected,names):'尚无战术反馈'}</p>
   {active.length>0?<details className="diagnostic-disclosure"><summary>操作与回执 <span>{active.filter(p=>p.status==='underway').length} 项在途记录 · {active.filter(p=>p.status==='review').length} 项待复查</span></summary>{renderOperations(active)}</details>:<p className="diagnostic-caption">暂无待处理操作</p>}
  </section>
  <section className="hybrid-runtime" aria-label="运行详情"><h4>运行详情</h4>
   <dl className="diagnostic-facts"><div><dt>战略版本</dt><dd>{d?.version??'未记录'}</dd></div><div><dt>条件模拟</dt><dd>{value.feedback?.coverage.simulations??'未记录'}{value.feedback?.coverage.simulations!==undefined?' 次':''}</dd></div><div><dt>已转译指挥官版本</dt><dd>{d?.commanderVersion??'未记录'}</dd></div></dl>
   <details className="diagnostic-disclosure"><summary>程序计算详情</summary><HybridGuidanceNotebook value={value.guidance} names={names}/></details>
   <details className="diagnostic-disclosure"><summary>AI 任务记录 <span>{tasks.length} 条 · {working.length} 项处理中</span></summary>
    <div className="diagnostic-table"><table><thead><tr><th scope="col">职责</th><th scope="col">状态</th><th scope="col">输入字符</th></tr></thead><tbody>{tasks.map(t=><tr key={t.id}><th scope="row">{kinds[t.kind]??t.kind}<small>{t.id}</small></th><td><span className="task-status" data-state={t.status}>{t.status==='queued'?'排队中':t.status==='running'?'思考中':label(t.status)}</span>{t.error&&<details className="task-error"><summary>错误详情</summary><p>{t.error}</p></details>}</td><td>{t.characters.toLocaleString()}</td></tr>)}</tbody></table></div>
   </details>
   {!!value.state?.messages.length&&<details className="diagnostic-disclosure"><summary>外交发言与发送回执 <span>{value.state.messages.length} 条</span></summary><ul className="diagnostic-records">{value.state.messages.map(m=><li key={m.id}><span className="diagnostic-badge">{label(m.status)}</span><p>{display(m.text)}</p></li>)}</ul></details>}
  </section>
  </div>
  <section className="hybrid-stage" aria-label="战略判断"><h4><span>1</span>战略判断</h4><p className="strategy-prose">{d?.summary?display(d.summary):'尚未发布战略判断'}</p></section>
  <section className="hybrid-stage" aria-label="当前生效指令"><div className="section-heading"><h4><span>2</span>当前生效指令</h4>{value.guidance&&<small>第 {value.guidance.worldDay.toLocaleString('zh-CN',{maximumFractionDigits:2})} 世界日</small>}</div>
   {!value.guidance&&<p className="diagnostic-caption">当前观察不可用，指令生效情况待核实</p>}
   {!instructions.length?<p className="diagnostic-caption">{value.guidance?'当前没有额外指令，程序按常规策略规划':'尚无可核实的指令'}</p>:<ul className="hybrid-instructions">{instructions.map(row=><li key={row.key}>
    <div className="section-heading"><b>{kinds[row.kind]??({protected:'保护来源',reserve:'最低留守',joint:'联合进攻','avoid-player':'禁攻玩家'} as Record<string,string>)[row.kind]??row.kind} · {row.kind==='avoid-player'?playerNames[Number(row.target)]??`玩家 ${Number(row.target)+1}`:notebookReadableText(names[row.target]??row.target,names)||'全局'}</b><span data-state={row.status==='受阻'?'failed':undefined}>{row.status}</span></div>
    {row.detail&&<p>{display(row.detail)}</p>}
    <small>{row.sources.join('、')}{row.until!==undefined?` · 截止第 ${row.until} 世界日`:''}</small>
    {row.reason&&<details className="instruction-reason" open={row.status==='受阻'}><summary>{row.status==='受阻'?'受阻原因':'原因与反馈'}</summary><p>{display(row.reason)}</p></details>}
   </li>)}</ul>}
   <details className="diagnostic-disclosure"><summary>内部谈判记录</summary><DiplomacyNotebook agreements={d?.agreements??[]} names={names} worldDay={value.guidance?.worldDay} messages={value.state?.messages??[]}/></details>
  </section>
  {value.diplomacy&&<ServerAgreements value={value.diplomacy} names={names}/>}
  {!!value.state?.contractCommands?.length&&<details className="diagnostic-disclosure"><summary>正式协议操作回执</summary><ul className="diagnostic-records">{value.state.contractCommands.slice(-12).reverse().map(c=><li key={c.id}><b>{c.action.kind==='propose-agreement'?'发起或反提协议':'响应协议'}</b><span> · {({pending:'待提交',unknown:'结果待查账',accepted:'命令已接受',failed:'命令未接受'} as Record<string,string>)[c.status]??c.status}</span>{c.reason&&<p>{c.reason}</p>}</li>)}</ul></details>}

 </section>;
}
