import type {BotRuntimeTelemetry} from '../../../../contracts/src/index.js';
type Node=keyof NonNullable<BotRuntimeTelemetry['pipeline']>['milliseconds'];
/** Transient monotonic timings, scoped to an observed tick. Never game authority. */
export class PipelineTiming {
 private tick:number|null=null;
 private totals:Record<Node,number>={sync:0,search:0,execution:0,finish:0,readiness:0};
 private spans=new Set<{node:Node;tick:number|null;start:number}>();
 constructor(private now:()=>number=()=>performance.now()){}
 scope(tick:number){
  if(this.tick!==null&&tick<=this.tick)return;
  this.tick=tick;this.totals={sync:0,search:0,execution:0,finish:0,readiness:0};
 }
 start(node:Node,tick:number|null){
  if(tick!==null)this.scope(tick);
  const span={node,tick,start:this.now()};this.spans.add(span);
  return (resolvedTick=tick)=>{
   if(!this.spans.delete(span))return;
   if(resolvedTick!==null)this.scope(resolvedTick);
   if(resolvedTick===this.tick)this.totals[node]+=Math.max(0,this.now()-span.start);
  };
 }
 async measure<T>(node:Node,tick:number|null,run:()=>Promise<T>,resolveTick?:(value:T)=>number){
  const end=this.start(node,tick);let resolved=tick;
  try{const value=await run();resolved=resolveTick?.(value)??tick;return value;}finally{end(resolved);}
 }
 read(){
  if(this.tick===null)return undefined;
  const milliseconds={...this.totals};
  for(const span of this.spans)if(span.tick===this.tick)milliseconds[span.node]+=Math.max(0,this.now()-span.start);
  return {tick:this.tick,milliseconds};
 }
}
