import type {DiagnosticReadModel} from '../storage/store-interfaces.js';
type Row=Record<string,unknown>;
const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const state=(status:unknown)=>status==='accepted'||status==='committed'?'accepted':status==='rejected'?'failed':status==='not-executed'?'skipped':status==='unknown'||status==='pending'?'unknown':null;
/** Dispatch evidence only; never infer arrival or battle outcomes from it. */
export function actionHistory(sources:ReturnType<DiagnosticReadModel['debugActionRows']>){
  return sources.flatMap(source=>{
    const p=source.intent;if(!row(p)||typeof p.id!=='string'||!row(p.arguments))return [];
    const actions=p.tool==='batch'&&Array.isArray(p.arguments.actions)?p.arguments.actions:p.tool==='order'?[{tool:'order',arguments:p.arguments}]:[];
    const instructions=actions.flatMap((raw,index)=>{
      if(!row(raw)||raw.tool!=='order'||!row(raw.arguments)||!row(raw.arguments.action))return [];
      const id=p.tool==='batch'?`${p.id}-item-${index}`:p.id;
      let status='proposed',reason='';
      const apply=(result:Row)=>{const next=state(result.status);if(next){if(status==='accepted')return;status=next;reason=typeof result.error==='string'?result.error:typeof result.reason==='string'?result.reason:'';}};
      for(const event of source.events){
        const e=event.payload;if(!row(e))continue;
        if(e.id===p.id){
          const result=row(e.result)?e.result:{};
          if(p.tool==='batch'&&Array.isArray(result.results)){
            const child=result.results.find(c=>row(c)&&c.id===id);if(row(child))apply(child);
          }else if(p.tool==='order'){
            if(event.kind==='tool-result')apply({...result,status:result.error?'rejected':result.status??'accepted'});
            if(event.kind==='write-reconciled')apply(e);
          }
          if(event.kind==='tool-unknown'&&status==='proposed')apply({status:'unknown',error:result.error});
          if(event.kind==='tool-rejected'&&status==='proposed')apply({status:'rejected',error:result.error});
        }
        if(e.id===id){
          if(event.kind==='batch-item-result'||event.kind==='write-reconciled')apply(e);
          if(event.kind==='batch-item-intent'||event.kind==='batch-item-unknown'){if(status==='proposed')apply({status:'unknown'});}
        }
      }
      return [{id,action:raw.arguments.action,state:status,reason}];
    });
    return instructions.length?[{id:p.id,round:source.round,tick:source.tick,instructions}]:[];
  });
}
