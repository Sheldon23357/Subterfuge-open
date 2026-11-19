type Row=Record<string,unknown>;
const row=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Model input uses world days. Convert only typed tool actions, leaving
 * authored prose, opaque evidence and original submitted arguments untouched. */
export function modelActionTimes(tool:string,input:unknown):unknown{
 if(!row(input))return input;
 const action=(raw:unknown):unknown=>{
  if(!row(raw)||raw.kind!=='launch')return raw;
  if(Object.hasOwn(raw,'delaySeconds'))throw Error('显式出航延迟使用delayWorldDays世界天，不接受delaySeconds');
  if(!Object.hasOwn(raw,'delayWorldDays'))return raw;
  const days=raw.delayWorldDays;
  if(typeof days!=='number'||!Number.isFinite(days)||days<0||days>144)throw Error('delayWorldDays须为0～144世界天');
  const seconds=days*600,exact=Math.round(seconds),tolerance=Number.EPSILON*Math.max(1,Math.abs(seconds))*8;
  if(!Number.isSafeInteger(exact)||Math.abs(seconds-exact)>tolerance)throw Error('delayWorldDays精度最多为1/600世界天，不自动取整');
  const {delayWorldDays,...rest}=raw;return {...rest,delaySeconds:exact};
 };
 const drafts=(raw:unknown)=>Array.isArray(raw)?raw.map(d=>row(d)?{...d,action:action(d.action)}:d):raw;
 switch(tool){
  case 'order':case 'deploy':return {...input,action:action(input.action)};
  case 'forecast':case 'decisionSupport':return {...input,...Object.hasOwn(input,'drafts')?{drafts:drafts(input.drafts)}:{}};
  case 'compare':return {...input,...Array.isArray(input.plans)?{plans:input.plans.map(p=>row(p)?{...p,drafts:drafts(p.drafts)}:p)}:{}};
  // Independent query rejection belongs to that child, not the whole batch.
  case 'queries':return input;
  case 'batch':return {...input,...Array.isArray(input.actions)?{actions:input.actions.map(a=>row(a)?{...a,arguments:modelActionTimes(String(a.tool),a.arguments)}:a)}:{}};
  default:return input;
 }
}
