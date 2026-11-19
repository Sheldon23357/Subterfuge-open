import type {ChatMessage} from '../../contracts/src/index.js';
/** Input must already be filtered by authenticated chat identity. */
export function searchVisibleChat(messages:ChatMessage[],query:URLSearchParams,count:number){
  const allowed=['with','text','id','before','limit'];
  if([...query.keys()].some(k=>!allowed.includes(k)||query.getAll(k).length!==1))throw Error('Invalid chat search');
  const integer=(key:string,fallback:number)=>{const raw=query.get(key);if(raw===null)return fallback;if(!/^\d+$/.test(raw))throw Error('Invalid search number');const n=Number(raw);if(!Number.isSafeInteger(n))throw Error('Invalid search number');return n;};
  const before=integer('before',messages.length),limit=integer('limit',20),participant=integer('with',-1),text=query.get('text')??'',id=query.get('id');
  if(before>messages.length||limit<1||limit>50||participant>=count||text.length>120||(id!==null&&id.length>128))throw Error('Invalid chat search bounds');
  const matches=messages.slice(0,before).map((message,index)=>({message,index})).filter(({message:m})=>
    (participant<0||m.from===participant||(Array.isArray(m.to)?m.to.includes(participant):m.to===participant))&&
    (!text||m.text.toLowerCase().includes(text.toLowerCase()))&&(id===null||m.id===id)).reverse();
  const page=matches.slice(0,limit);
  return {messages:page.map(r=>r.message),nextBefore:matches.length>limit?page.at(-1)!.index:null};
}
