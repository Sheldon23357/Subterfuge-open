import React from 'react';
import type {CommanderThread,PlayerObservation,ManualCommandReceipt} from '../../contracts/src/index.js';
import {hybridTacticLabel,type HybridSummaryData} from './HybridSummary.js';
import {notebookReadableText} from './notebook-display.js';
import {playerNames} from './theme.js';

export interface NotebookContextMemory {
 observedTick:number|null;commander:CommanderThread|null;
 manual:PlayerObservation['manualCommands']|null;pendingManual:ManualCommandReceipt[];
 mining:{stage:string;observedTick:number;reason:string;evidence:unknown}|null;
 localPlan?:unknown;
 execution:{pending:Record<string,unknown>[];observations:Record<string,unknown>[];notices:Record<string,unknown>[]} |null;
}
type Intent=NonNullable<NonNullable<HybridSummaryData['state']>['intents']>[number];
const ended=new Set(['completed','cancelled','expired','failed']);
export const notebookEndedIntents=(value:HybridSummaryData|undefined)=>(value?.state?.intents??[]).filter(t=>ended.has(t.status));
export const notebookOpenOperations=(value:HybridSummaryData|undefined)=>(value?.operations??[]).filter(o=>!ended.has(o.status));
const states:Record<string,string>={pending:'待提交',proposed:'待提交',accepted:'命令已接受',underway:'执行中，待实际结算',review:'待复查',completed:'已完成',ended:'运输已结算结束',cancelled:'已取消',expired:'已过期',failed:'失败',unknown:'结果未知',running:'执行中',blocked:'受阻',staged:'暂存，未启用',active:'已启用',none:'无附加任务',pendingReceipt:'等待回执',acceptedKnown:'已核实接受',awaitingVisibleTransition:'等待可见状态变化',confirmedFact:'已核实事实',contradiction:'事实不一致',queued:'排队中'};
const fields:Record<string,string>={id:'记录身份',kind:'类型',target:'目标',targets:'相关目标',source:'来源',destination:'目的地',outpostId:'据点',fleetId:'舰队',drillers:'兵力',priority:'优先级',until:'截止世界日',reason:'原因',status:'状态',state:'状态',objective:'目标',atTick:'保存 tick',scoutedTargets:'已接受侦察的目标',independentReview:'独立行动复核',basisRevision:'依据版本',minDrillers:'最低兵力',maxDrillers:'最高兵力',maxDrillersPerPlan:'每方案投入上限',maintain:'持续保持',rally:'集结点',requestId:'请求身份',orderId:'命令身份',evidenceId:'证据身份',draftId:'行动身份',issueTick:'下达 tick',taskIds:'关联意图',commandId:'命令身份',predicate:'核实条件',deadlineSeconds:'核实截止规则秒',fact:'已确认事实',tool:'操作',result:'实际回执',effects:'提交效果',receiptState:'回执状态',arguments:'请求内容',evidence:'依据',message:'消息',meaning:'含义',format:'格式',player:'玩家',version:'版本',from:'发起方',to:'接收方',peer:'对方',enemy:'共同目标',terms:'条款',commitments:'双方额度',outposts:'停战范围',subsidy:'补贴',payer:'支付方',amount:'数量',response:'响应',agreementId:'协议身份',counterTo:'反提来源',available:'可用兵力',selected:'选用方案',limitations:'限制',conditionalAlternatives:'条件替代方案',unverified:'待核实项',objects:'相关对象',diplomacyNeeds:'外交需求',opponents:'相关玩家',limits:'限制',tick:'tick',wall:'现实时间',count:'已交付回执数',lastId:'已交付到的回执身份',unavailable:'窗口外未展开数量',reviewKey:'复查依据',attempts:'联系尝试',streaks:'持续触发记录',contacts:'最近联系',history:'累计关系',trust:'信任',borderPressure:'边界压力',competitionPressure:'竞争压力'};
const player=(p:number)=>playerNames[p]??`玩家 ${p+1}`;
const conversation=(key:string|undefined)=>key==='public'?'公开会话':key?.split(',').map(p=>/^\d+$/.test(p)?player(Number(p)):p).join('、')||'会话未记录';
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const operations:Record<string,string>={launch:'立即出兵','return-fleet':'舰队返航',capture:'攻占',configure:'驻军配置',transfer:'指定调兵',focus:'主攻与集结',avoid:'禁止派兵',hold:'维持',ceasefire:'据点停战','joint-attack':'联合进攻','propose-agreement':'提案或反提协议','respond-agreement':'响应协议','await-current-facts':'等待当前事实复核',accept:'同意',reject:'拒绝',withdraw:'撤回'};

export function MemoryFields({value,names}:{value:unknown;names:Record<string,string>}){
 if(value===null||value===undefined)return <span className="notebook-memory-muted">未知</span>;
 if(typeof value!=='object')return <span>{typeof value==='boolean'?(value?'是':'否'):notebookReadableText(typeof value==='string'?(operations[value]??states[value]??value):String(value),names)}</span>;
 if(Array.isArray(value))return value.length?<ul className="notebook-memory-values">{value.map((v,i)=><li key={i}><MemoryFields value={v} names={names}/></li>)}</ul>:<span className="notebook-memory-muted">无</span>;
 return <dl className="notebook-memory-fields">{Object.entries(value).map(([key,v])=><div key={key}><dt>{fields[key]??key}</dt><dd>{v===null&&['maxDrillers','maxDrillersPerPlan'].includes(key)?'不限上限':v===null&&key==='minDrillers'?'不设下限':v===null&&key==='drillers'&&object(value).kind==='transfer'?'执行时的安全可调兵力':key==='wall'&&typeof v==='number'?new Date(v).toLocaleString('zh-CN',{hour12:false}):<MemoryFields value={v} names={names}/>}</dd></div>)}</dl>;
}
function Card({title,status,source,raw,children}:{title:string;status?:string;source?:string;raw?:unknown;children:React.ReactNode}){
 return <article className="notebook-card" aria-label={title}><header className="notebook-reader-heading"><h3>{title}</h3>{status&&<span>{states[status]??status}</span>}</header>{children}{source&&<p className="notebook-source">{source}</p>}{raw!==undefined&&<details className="note-raw"><summary>原始记录</summary><pre>{JSON.stringify(raw,null,2)}</pre></details>}</article>;
}
function Group({title,count}:{title:string;count?:number|undefined}){return <h3 className="notebook-memory-heading">{title}{count!==undefined&&<small>{count}</small>}</h3>;}
function Empty({text}:{text:string}){return <p className="notebook-memory-empty">{text}</p>;}
const at=(tick:number|undefined)=>tick===undefined?'时间未记录':`第 ${tick} tick`;

export function NotebookActionMemory({value,context,names}:{value:HybridSummaryData|undefined;context?:NotebookContextMemory|undefined;names:Record<string,string>}){
 if(!value)return <Empty text="行动记录未核实"/>;
 const intents=value.state?.intents??[],open=notebookOpenOperations(value),closed=value.operations.filter(o=>ended.has(o.status));
 const results=notebookEndedIntents(value);
 const operations=(rows:typeof open)=>rows.map(o=><Card key={o.id} title={hybridTacticLabel(o.objective,names)} status={o.status} source={`程序行动 · ${at(o.basis?.tick)}${o.finishedAt!==undefined?` · 结束于第 ${o.finishedAt} 世界日`:''}`} raw={o}>
  {!!o.issues.length&&<p className="notebook-prose">{notebookReadableText(o.issues.join('；'),names)}</p>}
  {!!o.drafts?.length&&<div className="notebook-action-steps">{o.drafts.map(d=><div key={d.id}>{d.action.kind==='launch'?<><p className="notebook-prose">{notebookReadableText(`${d.action.source} → ${d.action.destination}`,names)}</p><p className="notebook-source">{typeof d.action.drillers==='number'?`${d.action.drillers} 兵力`:'兵力未记录'} · 第 {d.issueTick} tick 下达</p></>:<MemoryFields value={{issueTick:d.issueTick,...d.action}} names={names}/>}</div>)}</div>}
  {!!o.intentBindings?.length&&<section className="notebook-diplomacy-section"><h4>关联作战意图</h4>{o.intentBindings.map(b=>{const t=intents.find(t=>t.id===b.id);return <p className="notebook-prose" key={b.id}>{t?hybridTacticLabel(`${t.spec.kind}:${t.spec.target??t.spec.fleetId??''}`,names):b.id} · 版本 {b.version}</p>;})}</section>}
  {!!o.commands?.length&&<section className="notebook-diplomacy-section"><h4>命令与回执</h4><ul className="notebook-command-results">{o.commands.map(c=><li key={c.draftId}><span>{states[c.state]??c.state}</span>{c.reason&&<p>{notebookReadableText(c.reason,names)}</p>}{c.evidenceId!==undefined&&<small>结算证据 #{c.evidenceId}</small>}</li>)}</ul></section>}
  {!!o.fleets?.length&&<p className="notebook-source">关联舰队 {o.fleets.length} 支</p>}
 </Card>);
 return <>
  <Group title="未完成行动" count={open.length}/>{open.length?operations(open):<Empty text="当前没有保留的未完成行动"/>}
  <Group title="近期任务结果" count={results.length}/>{results.length?[...results].reverse().map(t=><Card key={t.id} title={hybridTacticLabel(`${t.spec.kind}:${t.spec.target??t.spec.fleetId??''}`,names)} status={t.status} source={`${t.authority==='commander'?'指挥官指令':t.origin?'外交履约':'AI 指令'} · ${at(t.updatedAt)}`} raw={t}><MemoryFields value={t.spec} names={names}/><p className="notebook-prose">{notebookReadableText(t.reason,names)}</p></Card>):<Empty text="没有保留的已结束任务"/>}
  <Group title="近期行动结果" count={closed.length}/>{closed.length?operations([...closed].reverse()):<Empty text="没有保留的已结束行动"/>}
  <Group title="上轮战术反馈"/>{value.feedback?<Card title={hybridTacticLabel(value.feedback.selected,names)} status="条件计算" source={`程序推演 · ${at(value.feedback.basis?.tick)}`} raw={value.feedback}><MemoryFields value={{limitations:value.feedback.limitations??null,objects:value.feedback.objects,...(value.feedback.conditionalAlternatives!==undefined?{conditionalAlternatives:value.feedback.conditionalAlternatives}:{}),...(value.feedback.unverified!==undefined?{unverified:value.feedback.unverified}:{}),...(value.feedback.diplomacyNeeds?{diplomacyNeeds:value.feedback.diplomacyNeeds.map(({kind,targets,opponents,limits,evidence})=>({kind,targets,opponents,limits,evidence:Object.fromEntries(Object.entries(object(evidence)).filter(([,v])=>v===null||['string','number','boolean'].includes(typeof v)))}))}:{})}} names={names}/></Card>:<Empty text="没有保存的战术反馈"/>}
  <Group title="待核实请求与跨轮回执"/>{context?.execution?<>
   {context.execution.pending.map((r,i)=><Card title="待查账请求" status="unknown" key={`pending:${i}`} raw={r}><MemoryFields value={r} names={names}/></Card>)}
   {context.execution.observations.map((r,i)=><Card title="程序事实核验" key={`observation:${i}`} raw={r}><MemoryFields value={r} names={names}/></Card>)}
   {context.execution.notices.map((r,i)=><Card title="待交付的核实回执" key={`notice:${i}`} raw={r}><MemoryFields value={r} names={names}/></Card>)}
   {!context.execution.pending.length&&!context.execution.observations.length&&!context.execution.notices.length&&<Empty text="没有待续接的请求或回执"/>}
  </>:<Empty text="跨轮回执资料未核实"/>}
 </>;
}

export function NotebookCommunicationMemory({value,names}:{value:HybridSummaryData|undefined;names:Record<string,string>}){
 const state=value?.state;
 if(!state)return <Empty text="外交往来资料未核实"/>;
 const handled=new Set(state.handledMessages??[]);
 return <>
  <Group title="保留的会话原文" count={state.chat?.length}/>{state.chat?.length?state.chat.map(m=><Card key={m.id} title={`${player(m.from)} → ${m.to===null?'公开频道':(Array.isArray(m.to)?m.to:[m.to]).map(player).join('、')}`} status={handled.has(m.id)?'已处理':'未标记处理'} source={`服务器会话原文 · ${at(m.tick)}`} raw={m}><p className="notebook-prose">{notebookReadableText(m.text,names)}</p></Card>):<Empty text="没有保留的会话原文"/>}
  <Group title="发言与履约衔接" count={state.messages.length}/>{state.messages.length?[...state.messages].reverse().map(m=><Card key={m.id} title={conversation(m.conversation)} status={m.status==='accepted'?'发言已接受':m.status} source={`外交发送记录 · ${at(m.basis?.tick)}`} raw={m}>
   <p className="notebook-prose">{notebookReadableText(m.text,names)||'未发送正文'}</p>
   {m.fulfillment&&<section className="notebook-diplomacy-section"><h4>程序履约衔接 · {states[m.fulfillment.state]??m.fulfillment.state}</h4><p className="notebook-prose">{notebookReadableText(m.fulfillment.reason,names)}</p>{!!m.fulfillment.taskIds.length&&<MemoryFields value={{taskIds:m.fulfillment.taskIds}} names={names}/>}</section>}
   {m.intentEdits!==undefined&&<section className="notebook-diplomacy-section"><h4>随消息保存的意图编辑</h4><MemoryFields value={m.intentEdits} names={names}/></section>}
  </Card>):<Empty text="没有保留的外交发送记录"/>}
  <Group title="正式协议操作回执" count={state.contractCommands?.length}/>{state.contractCommands?.length?[...state.contractCommands].reverse().map(c=><Card key={c.id} title={c.action.kind==='propose-agreement'?'协议提案或反提':'协议响应'} status={c.status} source={`${conversation(c.conversation)} · ${at(c.basis?.tick)}`} raw={c}><MemoryFields value={c.action} names={names}/>{c.reason&&<p className="notebook-prose">{notebookReadableText(c.reason,names)}</p>}</Card>):<Empty text="没有保留的协议提交记录"/>}
 </>;
}

export function NotebookDiscussionMemory({context,names}:{context:NotebookContextMemory|undefined;names:Record<string,string>}){
 const thread=context?.commander;
 if(!thread)return <Empty text="指挥官讨论资料未核实"/>;
 return <>{thread.messages.length?thread.messages.map(m=><Card key={m.id} title={m.role==='player'?'玩家指示':m.role==='assistant'?'AI 回复':'进展反馈'} status={m.status} source={at(m.tick)} raw={m}>
  <p className="notebook-prose">{notebookReadableText(m.text,names)}</p>
  {!!m.references.length&&<MemoryFields value={{targets:m.references.map(r=>r.label??names[r.id]??r.id)}} names={names}/>}
  {m.proposal&&<section className="notebook-diplomacy-section"><h4>指令提案 · {({pending:'待玩家确认',confirmed:'已确认',superseded:'已被替代'} as Record<string,string>)[m.proposal.status]}</h4><p className="notebook-prose">{notebookReadableText(m.proposal.summary,names)}</p><p className="notebook-prose">{notebookReadableText(m.proposal.text,names)||'清除现有指令'}</p><p className="notebook-source">基于指令版本 {m.proposal.baseVersion}</p></section>}
 </Card>):<Empty text="本局暂无指挥官讨论"/>}</>;
}

export function NotebookProgramMemory({context,value,plans,names}:{context:NotebookContextMemory|undefined;value:HybridSummaryData|undefined;plans:unknown[];names:Record<string,string>}){
 const local=object(context?.localPlan),allPlans=local.plan?[local.plan,...plans.filter(p=>JSON.stringify(p)!==JSON.stringify(local.plan))]:plans;
 return <>
  <Group title="程序计划记忆"/>{allPlans.length?allPlans.map((p,i)=><Card title="保留的行动计划" key={i} raw={p}><MemoryFields value={p} names={names}/></Card>):<Empty text="没有保存的程序计划"/>}
  <Group title="人工操作与待核对事实"/>{context?<><Card title="当前人工操作记录" raw={context.manual}><MemoryFields value={context.manual} names={names}/></Card>{context.pendingManual.map(r=><Card title="尚未认知确认的人工操作" key={r.id} raw={r}><MemoryFields value={r} names={names}/></Card>)}</>:<Empty text="人工操作资料未核实"/>}
  <Group title="采矿阶段里程碑"/>{context?.mining?<Card title={({'early':'前期','mid':'中期','late':'后期'} as Record<string,string>)[context.mining.stage]??context.mining.stage} source={`程序确认的阶段记录 · ${at(context.mining.observedTick)}`} raw={context.mining}><p className="notebook-prose">{({'complete-public-roster-without-mining':'完整公开经济信息显示尚未进入采矿','observed-mining':'已观察到采矿活动','observed-half-goal':'已观察到至少一方达到胜利目标的一半'} as Record<string,string>)[context.mining.reason]??context.mining.reason}</p><MemoryFields value={context.mining.evidence} names={names}/></Card>:<Empty text="没有可核实的采矿阶段记录"/>}
  <Group title="上下文衔接记录"/>{value?.state?<>
   <Card title="协议回执交付范围" raw={value.state.receiptDelivery}><MemoryFields value={value.state.receiptDelivery??null} names={names}/></Card>
   <Card title="外交联系与复查记录" raw={value.state.diplomacyPressure}><MemoryFields value={value.state.diplomacyPressure?{contacts:value.state.diplomacyPressure.contacts??{},attempts:value.state.diplomacyPressure.attempts,streaks:value.state.diplomacyPressure.streaks}:null} names={names}/></Card>
   {!!value.state.betrayAgreements?.length&&<Card title="保存的背约选择"><MemoryFields value={{agreementId:value.state.betrayAgreements}} names={names}/></Card>}
  </>:<Empty text="上下文衔接资料未核实"/>}
 </>;
}
