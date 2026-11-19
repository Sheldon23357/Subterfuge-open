export interface ModelRateLimitStats {
 byRound?:Record<string,number>;
 unassigned?:number;
 total:number;
 byLane:{automatic:number;background:number;commander:number};
 lastAt:string|null;
}
/** One terminal failure is one attempt, even when evidence repeats HTTP 429.
 * Retry and derived error events are excluded by the compact reader. */
export function aggregateModelRateLimits(read:(after:number)=>{id:number;kind:string;metrics:unknown[]}[],after:number):ModelRateLimitStats{
 const result:ModelRateLimitStats={total:0,byLane:{automatic:0,background:0,commander:0},lastAt:null,byRound:{},unassigned:0};
 while(true){
  const page=read(after);
  for(const row of page){
   const [status,providerStatus,statuses,providerStatuses,sequence,diagnosticSequence,...times]=row.metrics;
   if(status!==429&&providerStatus!==429&&!(Array.isArray(statuses)&&statuses.includes(429))&&!(Array.isArray(providerStatuses)&&providerStatuses.includes(429)))continue;
   const lane=row.kind.startsWith('mode-')&&row.kind.endsWith('-task-failed')?'background':row.kind==='commander-call-failed'?'commander':'automatic';
   result.total++;result.byLane[lane]++;
   const round=[sequence,diagnosticSequence].find(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0);
   if(typeof round==='number')result.byRound![round]=(result.byRound![round]??0)+1;
   else result.unassigned!++;
   const at=times.find(t=>typeof t==='string'&&Number.isFinite(Date.parse(t)));
   if(typeof at==='string'&&(result.lastAt===null||Date.parse(at)>Date.parse(result.lastAt)))result.lastAt=new Date(at).toISOString();
  }
  if(page.length<100)break;
  after=page.at(-1)!.id;
 }
 return result;
}
