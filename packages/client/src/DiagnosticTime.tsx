import React from 'react';
import {formatWorldTimestampFromRuleSeconds,formatWorldTimestampFromTick,formatWorldDurationFromRuleSeconds} from '../../contracts/src/index.js';
type Domain='notebook'|'reminders'|'campaigns'|'event';
const record=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
/** Convert only fields whose meaning is fixed by the selected journal domain. Never inspect arbitrary nested timestamps. */
export function diagnosticTimeSummary(domain:Domain,value:unknown):string[]{
 const p=record(value);if(!p)return [];
 const out:string[]=[];
 const add=(label:string,v:unknown,tick=false)=>{if(v===null||v===undefined)return;if(typeof v==='number'&&Number.isFinite(v)&&v>=0)out.push(`${label} ${tick?formatWorldTimestampFromTick(v):formatWorldTimestampFromRuleSeconds(v)}`);else out.push(`${label}时间未判定`);};
 const domainTime=(label:string,raw:string,worldDay:string)=>{
  if(Object.hasOwn(p,worldDay)){
   const day=p[worldDay];add(label,typeof day==='number'?day*600:day);
   if(Object.hasOwn(p,raw)&&typeof day==='number'&&Number.isFinite(day)&&p[raw]!==day*600){add(label+'（原始锚点）',p[raw]);out.push(label+'时间依据冲突');}
  }else add(label,p[raw]);
 };
 if(domain==='notebook'){domainTime('更新','updatedAt','updatedWorldDay');domainTime('有效至','expiresAt','expiresWorldDay');add('依据',p.basisTick,true);add('复核',record(p.record)?.reviewAt);}
 if(domain==='reminders')domainTime('提醒','atSeconds','atWorldDay');
 if(domain==='campaigns'&&Array.isArray(p.plans))for(const plan of p.plans){const c=record(plan);if(c){const label=typeof c.id==='string'?c.id:'战役';add(`${label} 创建`,c.createdTick,true);add(`${label} 复查`,c.reviewAtTick,true);}}
 if(domain==='campaigns'&&!Array.isArray(p.plans)){add('创建',p.createdTick,true);add('复查',p.reviewAtTick,true);}
 if(domain==='event')add('下次复核',p.nextReview);
 return out;
}
export function DiagnosticTimeSummary({domain,value}:{domain:Domain;value:unknown}){const lines=diagnosticTimeSummary(domain,value);return lines.length?<p className="muted hint">{lines.join(' · ')}</p>:null;}
/** Raw protocol is kept verbatim; identical names such as expiresAt have domain-specific units. */
export function RawTimeLegend({domain='protocol'}:{domain?:Domain|'protocol'|'wall'}){
 const text=domain==='notebook'?'笔记 updatedAt / expiresAt / record.reviewAt 为绝对规则秒；basisTick 为世界日。':domain==='reminders'?'atSeconds 为绝对规则秒。':domain==='campaigns'?'createdTick / reviewAtTick / authoredAtTick 为世界日。':domain==='event'?'nextReview 为绝对规则秒；durationMs / roundElapsedMs 为现实毫秒。':domain==='wall'?'诊断时长为现实毫秒，UTC 时间戳保留原值。':'游戏命令 delaySeconds、atSeconds 为内部规则秒，tick 为世界日；笔记 updatedAt / expiresAt / reviewAt 为规则秒。现实 startedAt / durationMs 与断点 expiresAt 为毫秒。';
 return <small className="muted hint">原始记录：{text} 600规则秒＝1世界日；其他时间字段未判定，保留原值。历史正文不改写。</small>;
}

export function toolTimeSummary(tool:string,value:unknown):string[]{
 const p=record(value);if(!p)return [];
 if(tool==='campaigns')return diagnosticTimeSummary('campaigns',p);
 if(tool!=='notebook'&&tool!=='reminders')return [];
 // Tool responses explicitly expose these containers; never search arbitrary nested result objects.
 const domain=tool==='notebook'?'notebook':'reminders';
 const values=[p.set,p.entries,p.active].find((v):v is unknown[]=>Array.isArray(v)&&v.length>0)??[];
 return values.flatMap(v=>diagnosticTimeSummary(domain,v));
}
export function queryComputeSummary(value:unknown):string[]{
 const p=record(value);if(!p)return [];
 const count=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n.toLocaleString():'未知';
 const lines=[`已处理 ${count(p.processed)} / ${count(p.requested)} 项`],budget=record(p.computeBudget);
 if(budget){
  lines.push(`预测尝试 ${count(budget.simulations)} / ${count(budget.maxSimulations)} 次`,`同步计算 ${count(budget.computeMs)} / ${count(budget.maxComputeMs)} 毫秒`);
  if(budget.stopReason==='simulation-budget')lines.push('预测次数预算耗尽');
  if(budget.stopReason==='time-budget')lines.push('计算时间预算耗尽');
 }else lines.push('计算用量未记录');
 if(p.complete===false)lines.push('部分完成，未执行项不表示无解');
 return lines;
}
export function ToolTimeSummary({tool,value}:{tool:string;value:unknown}){const lines=tool==='queries'?queryComputeSummary(value):toolTimeSummary(tool,value);return lines.length?<p className="muted hint">{lines.join(' · ')}</p>:null;}
export function commandTimeSummary(path:string,value:unknown):string[]{
 const p=record(value);if(!p||path!=='/player/v2/owner/commands'||!['order','schedule'].includes(String(p.kind)))return [];
 const out:string[]=[];const issue=p.kind==='schedule'&&Number.isSafeInteger(p.issueTick)&&Number(p.issueTick)>=0?Number(p.issueTick):null;
 if(issue!==null)out.push(`执行 ${formatWorldTimestampFromTick(issue)}`);
 const action=record(record(p.order)?.action),delay=action?.delaySeconds;
 if(action?.kind==='launch'&&typeof delay==='number'&&Number.isFinite(delay)&&delay>=0){out.push(`准备时长 ${formatWorldDurationFromRuleSeconds(delay)}`);if(issue!==null)out.push(`出发 ${formatWorldTimestampFromRuleSeconds(issue*600+delay)}`);else out.push('缺少原观察完整时刻，未推算绝对出发日');}
 return out;
}
export function CommandTimeSummary({path,value}:{path:string;value:unknown}){const lines=commandTimeSummary(path,value);return lines.length?<p className="muted hint">{lines.join(' · ')}</p>:null;}
export function JournalToolTimeSummary({kind,value}:{kind:string;value:unknown}){const p=record(value);return (kind==='tool-result'||['tool-rejected','query-progress'].includes(kind)&&p?.tool==='queries')&&typeof p?.tool==='string'?<ToolTimeSummary tool={p.tool} value={p.result}/>:null;}
