export interface ToolUsageBucket {total:number;counts:Record<string,number>}
export interface ToolUsageStatistics {all:ToolUsageBucket;recent:ToolUsageBucket;recentRounds:number[];unassigned:number}
export interface ToolUsageRow {id:number;kind:string;sequence:unknown;logicalId:unknown;tool:unknown}
/** Compact journal pages only: never load prompts, arguments or result bodies. */
export function aggregateToolUsage(read:(after:number)=>ToolUsageRow[],after:number):ToolUsageStatistics{
 const counts=new Map<string,number>(),rounds=new Map<number,Map<string,number>>(),seen=new Set<string>();
 let current:number|null=null,unassigned=0,cursor=after;
 const roundNumber=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?v:null;
 const ensure=(round:number)=>{if(rounds.size===50&&!rounds.has(round)&&round<Math.min(...rounds.keys()))return; if(!rounds.has(round))rounds.set(round,new Map());if(rounds.size>50)rounds.delete(Math.min(...rounds.keys()));return rounds.get(round);};
 while(true){const rows=read(cursor);if(!rows.length)break;
  for(const row of rows){cursor=row.id;
   if(row.kind!=='tool-intent'){const round=roundNumber(row.sequence);if(round!==null){current=round;ensure(round);}continue;}
   if(typeof row.tool!=='string'||!row.tool||row.tool.length>100)continue;
   const id=typeof row.logicalId==='string'&&row.logicalId?row.logicalId:`journal:${row.id}`;
   if(seen.has(id))continue;seen.add(id);counts.set(row.tool,(counts.get(row.tool)??0)+1);
   const encoded=typeof row.logicalId==='string'?row.logicalId.match(/^ai-\d+-(\d+)-\d+$/)?.[1]:undefined;
   const round=roundNumber(row.sequence)??(encoded?roundNumber(Number(encoded)):null)??current;
   if(round===null){unassigned++;continue;}
   const group=ensure(round);if(group)group.set(row.tool,(group.get(row.tool)??0)+1);
  }
 }
 const recent=new Map<string,number>();for(const group of rounds.values())for(const [tool,n] of group)recent.set(tool,(recent.get(tool)??0)+n);
 const bucket=(values:Map<string,number>):ToolUsageBucket=>({total:[...values.values()].reduce((a,b)=>a+b,0),counts:Object.fromEntries([...values].sort(([a,x],[b,y])=>y-x||a.localeCompare(b)))});
 return {all:bucket(counts),recent:bucket(recent),recentRounds:[...rounds.keys()].sort((a,b)=>a-b),unassigned};
}
