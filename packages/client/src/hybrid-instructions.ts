import type {HybridSummaryData} from './HybridSummary.js';
export interface InstructionRow {key:string;kind:string;target:string;status:string;detail:string;reason:string;sources:string[];until?:number|undefined}
const ended=new Set(['completed','cancelled','expired']);
export const intentEnded=(status:string)=>ended.has(status);
/** A read-only presentation of the actual guidance. Never invent commands from prose. */
export function hybridInstructionRows(value:HybridSummaryData):InstructionRow[]{
 const g=value.guidance,d=value.state?.directive,rows:InstructionRow[]=[];
 const tasks=(value.state?.intents??[]).filter(t=>!ended.has(t.status)&&(g===null||g===undefined||t.spec.until>g.worldDay));
 const owner=(t:typeof tasks[number])=>t.authority==='commander'?'指挥官指令':t.origin?.kind==='diplomacy'?'外交履约':'AI 指令';
 const origin=(kind:string,target:string)=>{
  const from=tasks.filter(t=>t.spec.target===target&&t.spec.kind===kind).map(t=>`${owner(t)} · 至第 ${t.spec.until} 世界日`);
  const agreements=value.diplomacy?[]:d?.agreements.filter(a=>['proposed','negotiating','confirmed'].includes(a.status)&&(a.expiresWorldDay==null||!g||a.expiresWorldDay>g.worldDay))??[];
  if(kind==='avoid')for(const a of agreements.filter(a=>a.forbiddenTargets?.includes(target)))from.push(`外交协议${a.expiresWorldDay==null?'':` · 至第 ${a.expiresWorldDay} 世界日`}`);
  return [...new Set(from.length?from:['程序汇总'])];
 };
 const rule=(kind:string,target:string,detail:string,sources:string[])=>rows.push({key:kind+':'+target,kind,target,status:'限制生效',detail,reason:tasks.filter(t=>t.spec.kind===kind&&t.spec.target===target).map(t=>t.reason).join('；'),sources});
 if(g){
  for(const target of g.contractAvoidTargets??[])rows.push({key:'contract-policy:'+target,kind:'contract-policy',target,status:'守约策略',detail:'默认不新增攻击，可明确选择背叛并承担服务器违约后果',reason:'',sources:['已签署外交协议的本方规划策略']});
  for(const p of new Set(g.forbiddenPlayers))rule('avoid-player',String(p),'禁止攻击其据点',['指令与外交协议汇总']);
  for(const p of new Set(g.forbiddenTargets))rule('avoid',p,'禁止向该点新增派兵（含进攻、增援及返航）；不撤回在途舰队',origin('avoid',p));
  for(const p of new Set(g.protectedSources))rule('protected',p,'限制调出兵力',['指令汇总']);
  for(const r of g.reserves)if(!tasks.some(t=>t.spec.kind==='configure'&&t.spec.maintain&&t.spec.minDrillers!=null&&t.spec.target===r.source))rule('reserve',r.source,`最低留守 ${r.drillers} 兵力（含已接受预约的资源承诺）`,['指令与预约汇总']);
  for(const r of g.attackDefenseFactors)if(!g.objectives.some(p=>p.kind==='capture'&&p.targets.includes(r.target)))rows.push({key:'joint:'+r.target,kind:'joint',target:r.target,status:'参与估算',detail:`夹击估算：目标防御按 ${Math.round(r.factor*100)}%；实际战斗推演仍使用真实兵力`,reason:'',sources:['外交协议'],until:r.until});
 }
 for(const t of tasks){
  if(g&&t.spec.kind==='avoid')continue;
  const s=t.spec,parts:string[]=[];
  if(s.kind==='transfer'){
   parts.push(`${s.source} → ${s.target}`);
   parts.push(s.drillers===null?'执行时的安全可调兵力':`${s.drillers} 兵力`);
   parts.push('实际交付后完成');
  }else if(s.kind==='focus'){
   parts.push(`${s.rally} 集结，主攻 ${s.target}`);
   parts.push('关联集结任务完成后启用主攻，范围以已确认指令为准');
  }else if(s.kind==='configure'){
   parts.push(`兵力 ${s.minDrillers??'不限下限'} ～ ${s.maxDrillers??'不限上限'}`);
   parts.push(s.maintain?'持续保持':'一次性达标后结束');
   const reserve=g?.reserves.find(r=>r.source===s.target);if(s.maintain&&reserve)parts.push(`执行最低留守 ${reserve.drillers} 兵力（含预约）`);
  }else if(s.kind==='capture'){
   parts.push(`优先级 ${s.priority??'未记录'} · 程序选择来源、兵量和时机`);
   if(s.maxDrillersPerPlan!=null)parts.push(`每个方案向该目标合计最多 ${s.maxDrillersPerPlan} 兵力`);
   const joint=g?.attackDefenseFactors.find(r=>r.target===s.target);if(joint)parts.push(`夹击估算：目标防御按 ${Math.round(joint.factor*100)}%${joint.until!==undefined?`，抵达须早于第 ${joint.until} 世界日`:''}`);
  }
  rows.push({key:t.id,kind:s.kind,target:s.target??s.fleetId??'',status:!g?'待核实':t.status==='blocked'?'受阻':t.status==='running'?'执行中':'待规划',detail:parts.join('；'),reason:t.reason,sources:[owner(t)],until:s.until});
 }
 // The same capture task is already shown above. Legacy and treaty goals are read-only planning preferences.
 const goals=new Map<string,InstructionRow&{priority:number}>(),activeIds=new Set(tasks.map(t=>t.id));
 for(const objective of g?.objectives??[]){
  if(activeIds.has(objective.id))continue;
  for(const target of objective.targets.length?objective.targets:['']){
   if(tasks.some(t=>t.spec.kind==='capture'&&t.spec.target===target)&&objective.kind==='capture')continue;
   const key=objective.kind+':'+target,old=goals.get(key);
   const joint=g?.attackDefenseFactors.find(r=>r.target===target);
   if(!old||old.priority<objective.priority)goals.set(key,{key,kind:objective.kind,target,status:'参与规划',detail:`规划偏好 · 优先级 ${objective.priority}`+(joint?`；夹击估算：目标防御按 ${Math.round(joint.factor*100)}%`:''),reason:objective.reason,sources:[(objective.id.startsWith('joint-attack:')||objective.id.startsWith('server-joint:'))?'外交协议':'既有战略目标'],priority:objective.priority,...(joint?.until!==undefined?{until:joint.until}:{})});
  }
 }
 rows.push(...goals.values());return rows;
}
