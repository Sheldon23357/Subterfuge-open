import React,{useState} from 'react';
import {DIPLOMACY_RULES} from '../../rules/src/index.js';
import type {PlayerDiplomacy} from '../../contracts/src/index.js';
import {playerNames,colors} from './theme.js';

const statuses:Record<string,string>={proposed:'待签署',active:'履约中',completed:'已完成',unfulfilled:'未完成',violated:'已违约',rejected:'已拒绝',withdrawn:'已撤回',superseded:'已反提替代',expired:'提案已过期',terminated:'已终止'};
const reasons:Record<string,string>={'proposal-expired':'提案未在有效期内签署','deadline-shortfall':'截止时尚有个人承诺未完成','ceasefire-fulfilled':'停战期完整履行','both-fulfilled':'双方个人目标均已完成','hostile-battle':'实际交战违反停战','recipient-rejected':'对方拒绝','proposer-withdrew':'提议方撤回','counteroffer':'已由反提替代','game-ended':'对局结束','participant-or-target-eliminated':'参与方或共同目标已淘汰'};
const receipts:Record<string,string>={'agreement-acceptance-failed':'签署失败','agreement-proposed':'提案已建立','agreement-signed':'双方已签署','agreement-ended':'协议已结束','agreement-subsidy':'矿产补贴已支付','agreement-personal-fulfilled':'个人已达标','agreement-progress':'履约进度更新','trust-changed':'信任已结算'};
export function ServerAgreements({value,names,outposts=[],viewer,disabled=false,onRespond,onCounter,historyExpanded=false,historyOnly=false,headerAction,children}:{value:PlayerDiplomacy;names:Record<string,string>;outposts?:readonly {id:string;owner?:number|null}[];viewer?:number;disabled?:boolean;onRespond?:(id:string,response:'accept'|'reject'|'withdraw')=>void;onCounter?:(a:PlayerDiplomacy['agreements'][number])=>void;historyExpanded?:boolean;historyOnly?:boolean;headerAction?:React.ReactNode;children?:React.ReactNode}){
  const [section,setSection]=useState<'current'|'history'|'receipts'>('current');
  const player=(p:number)=>playerNames[p]??`玩家 ${p+1}`;
  const owners=new Map(outposts.map(p=>[p.id,p.owner]));
  const current=value.agreements.filter(a=>a.status==='proposed'||a.status==='active');
  const active=current.filter(a=>a.status==='active');
  const ceasefires=active.filter(a=>a.terms.kind==='ceasefire').length,jointAttacks=active.filter(a=>a.terms.kind==='joint-attack').length;
  const failure=(reason:unknown)=>{const limit=/^Active (ceasefire|joint-attack) agreement limit reached for player (\d+): (\d+)$/.exec(String(reason));return limit?`${player(Number(limit[2]))}的${limit[1]==='ceasefire'?'停战':'夹击'}生效名额已满（上限${limit[3]}份）`:reason==='Insufficient or overflowing subsidy balance'?'补贴余额不足或收款余额超限':String(reason);};
  const closedRows=value.agreements.filter(a=>a.status!=='proposed'&&a.status!=='active');
  const closed=(historyExpanded?closedRows:closedRows.slice(-10)).slice().reverse();
  const list=(items:typeof current)=><ul className="diagnostic-records agreement-cards">{items.map(a=><li key={a.id} data-status={a.status}>
    <div className="section-heading"><div className="agreement-identity"><b>{a.terms.kind==='ceasefire'?'据点停战':'攻击第三方'}</b><span className="agreement-partners">{(viewer===undefined?a.players:a.players.filter(p=>p!==viewer)).map(p=><span key={p} style={{color:colors[p]}}>{player(p)}</span>)}</span></div><span className="agreement-status">{a.status==='proposed'&&viewer!==undefined?(a.players[1]===viewer?'待我签署':'待对方签署'):statuses[a.status]}</span></div>
    {a.terms.kind==='ceasefire'?<div className="agreement-outposts" aria-label="停战据点">{a.terms.outposts.map(id=>{const owner=owners.get(id);return <span key={id} style={{color:owner==null?undefined:colors[owner]}}>{names[id]??id}</span>;})}</div>:<p className="agreement-target">共同目标 <b style={{color:colors[a.terms.enemy]}}>{player(a.terms.enemy)}</b></p>}
    <div className="agreement-timing"><span>签署后 {a.terms.kind==='ceasefire'?DIPLOMACY_RULES.ceasefireTicks:DIPLOMACY_RULES.jointAttackTicks} tick</span><span>{a.startedAt===null?'提案截止':'履约截止'} <b>{a.deadline}</b> tick</span></div>
    {a.terms.kind==='joint-attack'&&<div className="agreement-progress">{a.players.map((p,i)=>{
      const commitment=DIPLOMACY_RULES.jointCaptureGoal;
      return <div key={p}><div className="agreement-progress-label"><span>{p===viewer?'我方':player(p)}</span><span>{a.startedAt===null?`占领任意 ${commitment} 个据点`:`${a.progress[i]} / ${commitment}`}{a.fulfilled[i]&&<em>已达标</em>}</span></div>{a.startedAt!==null&&<div className="agreement-progress-track" role="progressbar" aria-label={`${p===viewer?'我方':player(p)}占领据点`} aria-valuemin={0} aria-valuemax={commitment} aria-valuenow={Math.min(a.progress[i]!,commitment)} aria-valuetext={`${a.progress[i]} / ${commitment} 占领据点`}><span style={{width:`${Math.min(100,a.progress[i]!/commitment*100)}%`}}/></div>}</div>;
    })}<small>双方各占领共同敌人任意一个据点</small></div>}
    <dl className="diagnostic-facts agreement-facts">
      {a.subsidy&&<div><dt>矿产补贴</dt><dd>{player(a.subsidy.payer)} → {player(a.players.find(p=>p!==a.subsidy!.payer)!)}：{a.subsidy.amount}{a.startedAt===null?(a.status==='proposed'?' · 签署时支付':' · 未签署，未支付'):' · 已支付'}</dd></div>}
    </dl>
    {a.reason&&<p>{reasons[a.reason]??a.reason}</p>}
    {a.status==='proposed'&&viewer!==undefined&&onRespond&&<div className="agreement-actions">
      {a.players[1]===viewer?<><button className="agreement-primary" disabled={disabled} onClick={()=>onRespond(a.id,'accept')}>同意并签署</button>{onCounter&&<button disabled={disabled} onClick={()=>onCounter(a)}>修改并反提</button>}<button className="agreement-reject" disabled={disabled} onClick={()=>onRespond(a.id,'reject')}>拒绝</button></>:a.players[0]===viewer?<button disabled={disabled} onClick={()=>onRespond(a.id,'withdraw')}>撤回提案</button>:null}
    </div>}
  </li>)}</ul>;
  const receiptRows=historyExpanded?value.receipts:value.receipts.filter(r=>r.agreementId!==null).slice(-12);
  const receiptAgreement=(id:string|null)=>{
    const a=value.agreements.find(a=>a.id===id);
    return a?`${a.terms.kind==='ceasefire'?'据点停战':'攻击第三方'} · ${(viewer===undefined?a.players:a.players.filter(p=>p!==viewer)).map(player).join('、')}`:null;
  };
  const receiptList=<ol className="diagnostic-records agreement-receipts">{receiptRows.slice().reverse().map(r=><li key={r.id}>
      <b>{receipts[r.kind]??r.kind}</b><small> · 第 {r.time} tick{r.actor===null?'':` · ${player(r.actor)}`}</small>
      {!historyExpanded&&receiptAgreement(r.agreementId)&&<small className="agreement-receipt-context">{receiptAgreement(r.agreementId)}</small>}
      {r.kind==='agreement-acceptance-failed'&&<p>{failure(r.details.reason)}</p>}
      {!historyExpanded&&r.kind==='agreement-ended'&&r.details.reason&&<p>{reasons[String(r.details.reason)]??String(r.details.reason)}</p>}
      {!historyExpanded&&r.kind==='trust-changed'&&<p>{player(Number(r.details.from))} 对 {player(Number(r.details.to))}：{String(r.details.before)} → {String(r.details.after)}</p>}
      {!historyExpanded&&r.kind==='agreement-subsidy'&&<p>{player(Number(r.details.payer))} → {player(Number(r.details.payee))}：{String(r.details.amount)} 矿产</p>}
      {!historyExpanded&&r.kind==='agreement-progress'&&<p>已占领共同敌人据点 · {String(r.details.total)} / 1</p>}
      {historyExpanded&&Object.keys(r.details).length>0&&<dl className="agreement-receipt-fields">{Object.entries(r.details).map(([key,v])=><div key={key}><dt>{({reason:'原因',status:'结算状态',from:'信任发起方',to:'信任接收方',before:'结算前',after:'结算后',payer:'支付方',payee:'接收方',amount:'矿产数量',capturedOutposts:'本次占领据点',total:'已占领据点',player:'玩家',progress:'履约进度',fulfilled:'已履约'} as Record<string,string>)[key]??key}</dt><dd>{v===null?'未知':typeof v==='boolean'?(v?'是':'否'):['from','to','payer','payee','player'].includes(key)&&typeof v==='number'?player(v):key==='reason'?(reasons[String(v)]??String(v)):String(v)}</dd></div>)}</dl>}
      {historyExpanded&&<details className="note-raw"><summary>原始回执</summary><pre>{JSON.stringify(r,null,2)}</pre></details>}
    </li>)}</ol>;
  const quota=(label:string,used:number,max:number)=><div className="agreement-quota"><span>{label}</span><div className="agreement-quota-slots" aria-hidden="true">{Array.from({length:max},(_,i)=><i key={i} className={i<used?'is-used':''}/>)}</div><span><b>{used}</b> / {max}</span></div>;
  const groups=viewer===undefined?[['待签署',current.filter(a=>a.status==='proposed')],['履约中',active]] as const:[['待我签署',current.filter(a=>a.status==='proposed'&&a.players[1]===viewer)],['等待对方',current.filter(a=>a.status==='proposed'&&a.players[0]===viewer)],['履约中',active]] as const;
  return <section className="server-agreements" aria-label="服务器外交协议"><header className="agreement-header"><h4>外交协议</h4>{headerAction}</header>{!historyOnly&&<div className="agreement-quotas" aria-label="生效协议名额">{quota('据点停战',ceasefires,DIPLOMACY_RULES.maxActiveCeasefires)}{quota('夹击',jointAttacks,DIPLOMACY_RULES.maxActiveJointAttacks)}</div>}
    {children}
    {!historyExpanded?<>
      <div className="agreement-navigation" role="group" aria-label="协议分类">{([['current','进行中',current.length],['history','协议记录',closed.length],['receipts','结算动态',receiptRows.length]] as const).filter(([key])=>!historyOnly||key!=='current').map(([key,label,count])=><button type="button" key={key} aria-pressed={(historyOnly&&section==='current'?'history':section)===key} onClick={()=>setSection(key)}>{label}<span>{count}</span></button>)}</div>
      {section==='current'&&!historyOnly&&(current.length?groups.map(([label,items])=>items.length>0&&<section className="agreement-group" key={label}><h5>{label}<span>{items.length}</span></h5>{list(items)}</section>):<div className="agreement-empty"><b>暂无进行中的协议</b><span>可发起据点停战或共同攻击第三方的提案</span></div>)}
      {(section==='history'||(historyOnly&&section==='current'))&&(closed.length?<><p className="agreement-window-label">最近 {closed.length} 份已结束协议</p>{list(closed)}</>:<div className="agreement-empty"><b>暂无协议记录</b></div>)}
      {section==='receipts'&&(receiptRows.length?<><p className="agreement-window-label">最近 {receiptRows.length} 条协议动态</p>{receiptList}</>:<div className="agreement-empty"><b>暂无结算动态</b></div>)}
    </>:<>
      {!historyOnly&&(current.length?list(current):<p>暂无待签署或履约中的协议</p>)}
      {!!closed.length&&<section><h3 className="notebook-memory-heading">保留的协议结果 <small>{closed.length}</small></h3>{list(closed)}</section>}
      {!!receiptRows.length&&<section><h3 className="notebook-memory-heading">授权窗口内的结算回执 <small>{receiptRows.length} / {value.receiptCount}</small></h3>{receiptList}</section>}
      {historyOnly&&!closed.length&&!receiptRows.length&&<p>当前授权资料内没有协议结果或回执</p>}
    </>}
  </section>;
}
