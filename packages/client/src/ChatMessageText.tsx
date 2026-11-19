import React, {createContext, useContext, useMemo} from 'react';
import {outpostMentions, aiOutpostMentions, type NamedOutpost} from './outpost-mentions.js';

export const ChatMapContext = createContext<{
  outposts: NamedOutpost[];
  locate: (id: string) => void;
} | null>(null);

export function OutpostLink({id,label}:{id:string;label?:string}){
  const map=useContext(ChatMapContext),post=map?.outposts.find(p=>p.id===id),text=label??post?.name??id;
  if(!map||!post)return <>{text}</>;
  return <a className="chat-outpost-link" href={`#outpost-${encodeURIComponent(id)}`} title={`在地图上定位 ${text}`}
    onClick={event=>{event.preventDefault();event.stopPropagation();map.locate(id);}}>{text}</a>;
}

export function ChatMessageText({text, ai=false}: {text: string; ai?:boolean}) {
  const map = useContext(ChatMapContext);
  const parts = useMemo(() => {
    if(!map)return [{text}];
    return (ai ? aiOutpostMentions : outpostMentions)(text,map.outposts).map(part=>{
      const post=part.outpostId?map.outposts.find(p=>p.id===part.outpostId):undefined;
      return post?.name&&(part.text===post.id||/^据点\s*\d+$/.test(part.text))?{...part,text:post.name}:part;
    });
  }, [text, map?.outposts, ai]);
  return <>{parts.map((part, i) => part.outpostId && map ?
    <a key={i} className="chat-outpost-link" href={`#outpost-${encodeURIComponent(part.outpostId)}`}
      title={`在地图上定位 ${part.text}`} onClick={event => {event.preventDefault();event.stopPropagation(); map.locate(part.outpostId!);}}>{part.text}</a>
    : <React.Fragment key={i}>{part.text}</React.Fragment>)}</>;
}
