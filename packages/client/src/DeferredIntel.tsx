import React from 'react';
import {ChatMessageText} from './ChatMessageText.js';
import {ChevronDown,Layers,Radio,MapPin} from 'lucide-react';

export function DeferredIntel({entries}:{entries:{key:string;summary:string;count:number}[]}){
  if(!entries.length)return null;
  return <details className="ai-deferred">
    <summary><Layers size={15} aria-hidden="true"/><span>待合并情报</span><small>{entries.length} 项</small><ChevronDown size={15} className="ai-deferred-chevron" aria-hidden="true"/></summary>
    <ul>{entries.map(e=><li key={e.key}>
      {/舰队/.test(e.summary)?<Radio size={14} aria-hidden="true"/>:<MapPin size={14} aria-hidden="true"/>}
      <span><ChatMessageText text={e.summary} ai/></span><small title={`累计合并 ${e.count} 次变化`} aria-label={`累计合并 ${e.count} 次变化`}>×{e.count}</small>
    </li>)}</ul>
  </details>;
}
