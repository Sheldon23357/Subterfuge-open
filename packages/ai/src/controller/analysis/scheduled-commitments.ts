import type {PlayerObservation} from '../../../../contracts/src/index.js';

export interface ScheduledCommitment {source:string;drillers:number;scheduleIds:string[];unknownSchedules:string[]}
/** Future commitments are not a physical debit. Count only authoritative own
 * pending orders; executed orders have already affected the current map. Costs
 * that depend on execution-time state stay explicit instead of becoming zero. */
export function scheduledCommitments(o:PlayerObservation,afterTick=-Infinity):ScheduledCommitment[]{
 const sources=new Map<string,ScheduledCommitment>(),seen=new Set<string>();
 for(const order of o.scheduled){
  if(order.player!==o.view.player||order.status!=='pending'||order.failed||order.issueTick<=afterTick||seen.has(order.id))continue;
  seen.add(order.id);
  const a=order.action,source=a.kind==='launch'?a.source:a.kind==='toggle-mine'?a.outpostId:undefined;
  if(typeof source!=='string')continue;
  const row=sources.get(source)??{source,drillers:0,scheduleIds:[],unknownSchedules:[]};
  row.scheduleIds.push(order.id);
  if(a.kind==='launch'&&Number.isSafeInteger(a.drillers)&&Number(a.drillers)>=0)row.drillers+=Number(a.drillers);
  else row.unknownSchedules.push(order.id);
  sources.set(source,row);
 }
 return [...sources.values()];
}
