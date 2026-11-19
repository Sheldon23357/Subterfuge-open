import type {SituationBrief} from './contracts.js';

type Row=Record<string,any>;
export type MaterialReason='round-scope'|'trigger'|'message'|'commander'|'current-task'|'resource-conflict'|'hard-constraint'|'critical-asset'|'incoming'|'candidate-source'|'linked-operation'|'return-option'|'related-fleet';
export interface MaterialSeed {entity:string;reason:MaterialReason}
export interface RoundMaterialSelection {
 focus:ReadonlySet<string>;
 reasons:ReadonlyMap<string,readonly MaterialReason[]>;
}
const rows=(value:any):Row[]=>Array.isArray(value)?value:value?.columns&&value?.rows?value.rows.map((row:any[])=>Object.fromEntries(value.columns.map((key:string,i:number)=>[key,row[i]]))):[];
const taskRows=(value:any):Row[]=>value?.byKind?Object.values(value.byKind).flatMap(rows):rows(value);
const target=(f:Row)=>typeof f.destination==='string'?f.destination:f.destination?.name??f.destination?.id??f.destinationId;
const active=(t:Row)=>!['completed','cancelled','expired'].includes(t.status);

/** A single round's dependency set, not a recursive walk through the map.
 * Narrative strategy memory alone never promotes an entity to detailed facts. */
export function selectRoundMaterials(brief:SituationBrief,seeds:readonly MaterialSeed[]=[]):RoundMaterialSelection {
 const g=brief.global as Row,h=brief.guidance as Row,f=brief.facts as Row,e=brief.evidence as Row;
 const reasons=new Map<string,MaterialReason[]>();
 const add=(entity:unknown,reason:MaterialReason)=>{if(typeof entity!=='string'||!entity)return;const values=reasons.get(entity)??[];if(!values.includes(reason))values.push(reason);reasons.set(entity,values);};
 for(const seed of seeds)add(seed.entity,seed.reason);
 for(const trigger of (brief.changes as Row).triggers??[])for(const id of trigger.entities??[])add(id,'trigger');
 const identities=Array.isArray(g.identities)?g.identities.map(([name]:string[])=>({name})):rows(g.identities);
 const fleets=[...rows(g.ownFleets?.details??g.ownFleets),...rows(f.fleets?.details??f.fleets)];
 const mention=(text:string,reason:MaterialReason)=>{
  for(const id of [...identities.map(p=>p.name),...fleets.map(p=>p.id)].filter((id):id is string=>typeof id==='string')){
   const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   if(new RegExp('(?<![A-Za-z0-9_])'+escaped+'(?![A-Za-z0-9_])','u').test(text))add(id,reason);
  }
 };
 for(const message of e.messages??[])mention(message.text??'','message');
 mention(h.commander?.text??'','commander');
 for(const need of h.diplomacyPurpose?.needs??[])for(const id of need.targets??[])add(id,'round-scope');
 for(const id of h.executionRules?.protectedSources??[])add(id,'hard-constraint');
 for(const reserve of h.executionRules?.reserves??[])add(reserve.source,'hard-constraint');
 for(const p of g.criticalAssets?.mines??[])add(p.name??p.id,'critical-asset');
 for(const fleet of g.criticalAssets?.hostileApproaches??[]){add(fleet.id,'incoming');add(target(fleet),'incoming');}
 const tasks=taskRows(h.intentTasks).filter(active);
 const addTask=(t:Row,reason:MaterialReason)=>{for(const key of ['target','source','rally','fleetId'])add(t[key],reason);};
 for(const task of tasks){
  if(reasons.has(task.id))addTask(task,'current-task');
  else for(const key of ['target','source','rally'])if(reasons.has(task[key]))add(task[key],'current-task');
  if(task.kind==='return-fleet')add(task.fleetId,'current-task');
 }
 // Read-only obligations remain in the brief. Only direct resource conflicts
 // expand their facts; a conflict does not recursively pull in further tasks.
 const roots=new Set(reasons.keys());
 for(const task of taskRows(h.readOnlyIntentTasks).filter(active))for(const key of ['target','source','rally','fleetId'])if(roots.has(task[key]))add(task[key],'resource-conflict');
 // Source budgets, routes and task execution deltas are already supplied by
 // planning. They never promote their other endpoints to raw entity detail.
 return {focus:new Set(reasons.keys()),reasons};
}
