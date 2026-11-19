import React from 'react';
import './chat-channels.css';

interface Channel {id:string;label:string;color?:string|undefined;count:number;unread?:number}
export function ChatChannels({channels,selected,choose,disabled}:{channels:Channel[];selected:string;choose:(id:string)=>void;disabled?:boolean}) {
  return <nav className="chat-shortcuts" aria-label="聊天频道">
    {channels.map(channel=><button
      key={channel.id}
      type="button"
      aria-pressed={selected===channel.id}
      aria-label={`${channel.label}，${channel.count} 条消息${channel.unread?`，${channel.unread} 条未读`:''}`}
      title={`${channel.label} · ${channel.count} 条消息${channel.unread?` · ${channel.unread} 条未读`:''}`}
      style={{color:channel.color}}
      disabled={disabled}
      onClick={()=>{if(selected!==channel.id)choose(channel.id);}}
    ><span>{channel.label}</span><small>{channel.count}</small>{!!channel.unread&&<i aria-hidden="true"/>}</button>)}
  </nav>;
}
