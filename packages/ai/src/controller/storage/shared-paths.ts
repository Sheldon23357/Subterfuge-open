type Row=Record<string,unknown>;
const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

/** Share identical metadata and event bodies across comparison alternatives.
 * Each path keeps its exact ordered [event index, emission sequence?] references.
 * Sequence is scenario-specific; it is never used to merge distinct events. */
export function sharedComparisonPaths<T extends {scenarios:unknown[]}>(report:T):T{
 const copied=structuredClone(report),paths=copied.scenarios.flatMap(s=>row(s)&&row(s.path)?[s.path]:[]);
 if(paths.length<2)return copied;
 const common=Object.fromEntries(Object.keys(paths[0]!).filter(key=>key!=='events'&&paths.every(p=>Object.hasOwn(p,key)&&same(p[key],paths[0]![key]))).map(key=>[key,paths[0]![key]]));
 for(const path of paths)for(const key of Object.keys(common))delete path[key];
 const events:Row[]=[],index=new Map<string,number>();
 for(const path of paths){
  if(!Array.isArray(path.events)||!path.events.every(row))continue;
  const refs=path.events.map(event=>{
   const body=Object.fromEntries(Object.entries(event).filter(([key])=>key!=='sequence')),key=JSON.stringify(body);
   let id=index.get(key);if(id===undefined){id=events.length;index.set(key,id);events.push(body);}
   return Object.hasOwn(event,'sequence')?[id,event.sequence]:[id];
  });
  delete path.events;path.eventRefs=refs;
 }
 const candidate={...copied,pathCommon:common,pathEvents:events,pathEncoding:'shared-events/1：各方案path继承pathCommon；eventRefs按原顺序给出[pathEvents下标,该方案sequence?]，缺sequence与null不同。'};
 return JSON.stringify(candidate).length<JSON.stringify(report).length?candidate:structuredClone(report);
}
