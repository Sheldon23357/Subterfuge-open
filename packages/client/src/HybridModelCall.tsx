import React from 'react';

const object=(v:unknown)=>v&&typeof v==='object'?v as Record<string,unknown>:{};
const statuses:Record<string,string>={queued:'排队记录',completed:'已发布',failed:'失败',cancelled:'已取消',superseded:'已过时', 'awaiting-material':'等待补充资料','stale-dependency':'局势已变化','partition-reviewed':'分段已审阅','incomplete-conversation':'会话有新消息','superseded-pressure':'困境已解除'};
export function HybridModelCall({value}:{value:Record<string,unknown>}){
 const usage=object(value.usage),known=object(value.usageKnown),provider=object(value.providerContext);
 const count=(key:string,flag:string)=>known[flag]===true&&typeof usage[key]==='number'?Number(usage[key]).toLocaleString():'未报告';
 const duration=(v:unknown)=>typeof v==='number'?`${(v/1000).toFixed(2)} 秒`:'未记录';
 const time=(v:unknown)=>typeof v==='string'?v:'未记录';
 const block=(label:string,v:unknown)=><details><summary>{label}</summary><pre tabIndex={0}>{typeof v==='string'?v:JSON.stringify(v,null,2)}</pre></details>;
 return <section aria-label="模型调用详情">
  <p>{({strategy:'战略规划',diplomacy:'外交谈判',commander:'指令转译'} as Record<string,string>)[String(value.kind)]??String(value.kind)} · {statuses[String(value.status)]??String(value.status)} · {String(value.model)} · {String(value.effort)}</p>
  <dl className="diagnostic-metrics">
   <div><dt>任务</dt><dd>{String(value.task)} · 尝试 {Number(value.attempt)+1}</dd></div>
   <div><dt>排队时间（UTC）</dt><dd>{time(value.queuedAt)}</dd></div>
   <div><dt>发送时间（UTC）</dt><dd>{time(value.sentAt)}</dd></div>
   <div><dt>结束时间（UTC）</dt><dd>{time(value.finishedAt)}</dd></div>
   <div><dt>总耗时</dt><dd>{duration(value.durationMs)}</dd></div>
   <div><dt>排队耗时</dt><dd>{duration(value.queueWaitMs)}</dd></div>
   <div><dt>模型耗时</dt><dd>{duration(value.providerDurationMs)}</dd></div>
   <div><dt>输入 Token</dt><dd>{count('inputTokens','input')}</dd></div>
   <div><dt>输出 Token</dt><dd>{count('outputTokens','output')}</dd></div>
   <div><dt>缓存输入 Token</dt><dd>{count('cachedInputTokens','cached')}</dd></div>
   {provider.sessionMode==='revert'&&<div><dt>模型历史轮数（调用前 → 完成 → 回退后）</dt><dd>{String(provider.historyBefore)} → {String(provider.historyAfter)} → {String(provider.historyAfterReset)}</dd></div>}
   <div><dt>合计 Token</dt><dd>{known.input===true&&known.output===true&&typeof value.tokens==='number'?value.tokens.toLocaleString():'未完整报告'}</dd></div>
  </dl>
  {block('完整上下文',value.prompt)}
  {block('响应 Schema',value.responseSchema)}
  {value.providerContext!==undefined&&value.providerContext!==null&&block('Codex 会话与输入指纹',value.providerContext)}
  {value.output!==null?block('模型输出',value.output):<p className="diagnostic-caption">{value.finishedAt?'未取得可解析的模型输出':'等待调用结束'}</p>}
 </section>;
}
