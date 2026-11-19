import {GARRISON_FORMAT} from './garrison-context.js';
export interface DecisionContextBreakdown {total:number;sections:Record<string,number>}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const groups:Record<string,string>={chat:'chat',notifications:'notifications',notebook:'notebook',notebookIndex:'notebook',memoryConsistency:'memoryConsistency',campaigns:'campaigns',opening:'opening',safeExpansion:'opening',attackScreening:'attackAnalysis',targetSources:'attackAnalysis',sourceSafety:'attackAnalysis',executionEvidence:'executionEvidence',changes:'changes',reminders:'reminders',task:'task',workingContext:'task',roster:'identity',communication:'chat',chatCursor:'identity',notificationCursor:'identity',chatPlayer:'identity',chatCount:'identity',hasMore:'identity'};
const viewGroups:Record<string,string>={outposts:'outposts',fleets:'fleets',self:'economyAndVictory',match:'economyAndVictory',ownerEconomy:'economyAndVictory'};

/** Private JSON can quote section names; only a real line boundary is a marker. */
export function promptDecisionContextStart(prompt:string):number{
 const marker='当前受限情报及新消息：',line=prompt.indexOf('\n'+marker);
 return prompt.startsWith(marker)?0:line<0?-1:line+1;
}

/** Count the actual encoded JSON, including keys/punctuation, never a second
 * uncompressed snapshot. Invalid/truncated or differently formatted archives
 * stay unavailable rather than claiming a partial total is complete. */
export function decisionContextBreakdown(prompt:string):DecisionContextBreakdown|undefined{
 const marker='当前受限情报及新消息：',start=promptDecisionContextStart(prompt),end=prompt.indexOf('\n本轮行动与回执（按执行顺序）：',start);
 if(start<0||end<0)return;
 const body=prompt.slice(start+marker.length,end);
 let value:unknown;try{value=JSON.parse(body);}catch{return;}
 if(!object(value)||JSON.stringify(value)!==body)return;
 const observation=object(value.observation)?value.observation:undefined;
 const garrison=observation&&object(observation.view)&&observation.view.garrisonFormat===GARRISON_FORMAT;
 const sections:Record<string,number>={structure:marker.length+1};
 const add=(key:string,n:number)=>{sections[key]=(sections[key]??0)+n;};
 function visit(v:unknown,path:string[]){
  let group:string|undefined;
  if(path.length===1&&path[0]!=='observation')group=groups[path[0]!]??'other';
  if(path[0]==='observation'&&path.length===2&&path[1]!=='view')group=path[1]==='intel'?'intel':path[1]==='scheduled'?'scheduled':'identity';
  if(path[0]==='observation'&&path[1]==='view'&&path.length===3)group=viewGroups[path[2]!]??'worldMetadata';
  if(group==='outposts'&&garrison){
   // Attribute only the bytes that actually appear in each cell/header. Shared
   // wrappers, commas and row indices stay with outposts, never counted twice.
   const parts:Record<string,number>={outposts:JSON.stringify(v).length};
   const transfer=(field:string,cell:unknown)=>{
    const category=field==='生产'?'production':undefined;
    if(!category)return;
    const n=JSON.stringify(cell).length;parts.outposts!-=n;parts[category]=(parts[category]??0)+n;
   };
   if(object(v)&&v.encoding==='column-groups/1'&&Array.isArray(v.groups)){
    for(const g of v.groups)if(object(g)&&Array.isArray(g.fields)&&Array.isArray(g.rows)){
     g.fields.forEach((field,i)=>{if(typeof field!=='string')return;transfer(field,field);for(const row of g.rows as unknown[][])transfer(field,row[i+1]);});
    }
   }else if(Array.isArray(v))for(const row of v)if(object(row))for(const [field,cell]of Object.entries(row)){transfer(field,field);transfer(field,cell);}
   for(const [category,n]of Object.entries(parts))add(category,n);
   return;
  }
  if(group||!object(v)){add(group??'other',JSON.stringify(v).length);return;}
  const entries=Object.entries(v);add('structure',2+Math.max(0,entries.length-1));
  for(const [key,child]of entries){add('structure',JSON.stringify(key).length+1);visit(child,[...path,key]);}
 }
 try{visit(value,[]);}catch{return;} // Malformed archived tables are unavailable, never fatal to diagnostics.
 const total=end+1-start;
 if(Object.values(sections).reduce((a,b)=>a+b,0)!==total)return;
 return {total,sections};
}
