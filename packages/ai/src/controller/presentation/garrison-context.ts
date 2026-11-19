/** Model presentation only: never pass this shape to the engine or game API.
 * Groups preserve field presence; tuple '?' is only the absent-field marker in
 * typed numeric/boolean slots. Real null, zero and false remain distinct. */
type Row=Record<string,unknown>;
const object=(v:unknown):v is Row=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const own=(v:Row,k:string)=>Object.prototype.hasOwnProperty.call(v,k)&&v[k]!==undefined;
const absent='?';
export const GARRISON_FORMAT='garrison/1';
const postFields:Record<string,string>={owner:'归属',type:'类别',visibility:'可见性',drillers:'兵力',destroyed:'已毁',minePending:'转矿待执行'};
const reverseFields:Record<string,string>={...Object.fromEntries(Object.entries(postFields).map(([a,b])=>[b,a])),生产:'production'};
const shieldFields=['shield','shieldMax','shieldsEnabled'];
const productionFields=['active','paused','output','cycleMinutes','nextMinutes'];
const visibility=['ownership-only','type-known','observed'];
const cell=(v:Row,k:string)=>own(v,k)?v[k]:absent;

/** One explanation per prompt, for the outpost field encoding. */
export const GARRISON_POLICY='地图驻军格式garrison/1：column-groups/1表按相同已知字段分组，fields为列名，rows每行首数为原数组索引，其后各值与fields对应；也可为普通对象数组。id是真实据点ID；归属=owner、类别=type、可见性=visibility（0仅公开归属，1另知类型，2当前可见详情）、兵力=drillers、已毁=destroyed、转矿待执行=minePending。护盾=[当前shield,上限shieldMax,开关shieldsEnabled]；生产中的cycleWorldDays/nextWorldDays为周期/下次产出剩余世界天；cycleMinutes/nextMinutes为规则分钟，10分钟=1世界天。元组?或省略的尾项为字段未提供，不是null/0/false。仅省略据点英文显示名、该点容量贡献和可从原时间字段精确推导的显示换算；ownerEconomy保留已知总容量，不等于该点容量增量。';

function production(value:unknown):unknown{
 if(!object(value))return value;
 // New normalized clocks stay named; do not turn known world-day values into
 // unexplained absent raw-minute slots. Legacy tuples remain unchanged.
 if((own(value,'cycleWorldDays')||own(value,'nextWorldDays'))&&!own(value,'cycleMinutes')&&!own(value,'nextMinutes'))return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='contribution'));
 const extras=Object.fromEntries(Object.entries(value).filter(([k,v])=>{
  if(productionFields.includes(k)||k==='contribution')return false;
  if((k==='cycleWorldDays'||k==='nextWorldDays')){const raw=value[k==='cycleWorldDays'?'cycleMinutes':'nextMinutes'];if(typeof raw==='number'&&v===raw/10)return false;}
  return true;
 }));
 return [...productionFields.map(k=>cell(value,k)),...(Object.keys(extras).length?[extras]:[])];
}
/** Run after semanticMapContext/worldTimeContext and before generic tables. */
export function garrisonContext(value:unknown):unknown{
 if(Array.isArray(value))return value.map(garrisonContext);
 if(!object(value))return value;
 const mapped:Row=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,garrisonContext(v)]));
 if(!['decision-map/1','decision-forecast-map/1'].includes(String(value.format))||!Array.isArray(value.outposts)||!Array.isArray(value.fleets)||Object.prototype.hasOwnProperty.call(value,'garrisonFormat'))return mapped;
 const posts=mapped.outposts as Row[];
 const reserved=[...Object.values(postFields),'护盾','生产'];
 if(posts.some(p=>!object(p)||reserved.some(k=>own(p,k))))return mapped;
 mapped.outposts=posts.map(p=>{
  const row:Row=Object.create(null);
  for(const [key,v]of Object.entries(p)){
   if(shieldFields.includes(key))continue;
   if(key==='production'){row['生产']=production(v);continue;}
   row[own(postFields,key)?postFields[key]!:key]=key==='visibility'&&visibility.includes(String(v))?visibility.indexOf(String(v)):v;
  }
  if(shieldFields.some(k=>own(p,k)))row['护盾']=shieldFields.map(k=>cell(p,k));
  return {...row};
 });
 mapped.garrisonFormat=GARRISON_FORMAT;
 return mapped;
}

/** Decode model tables for validation/inspection, not for gameplay writes. */
function expandTables(value:unknown):unknown{
 if(Array.isArray(value))return value.map(expandTables);
 if(!object(value))return value;
 if(value.encoding==='column-groups/1'&&Array.isArray(value.groups)){
  const rows:unknown[]=new Array(Number(value.length));
  for(const group of value.groups as {fields:string[];rows:unknown[][]}[])for(const row of group.rows)rows[row[0] as number]=Object.fromEntries(group.fields.map((key,i)=>[key,expandTables(row[i+1])]));
  return rows;
 }
 return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expandTables(v)]));
}
export function expandGarrisonContext(value:unknown):unknown{
 const expanded=expandTables(value);
 const visit=(v:unknown):unknown=>{
  if(Array.isArray(v))return v.map(visit);
  if(!object(v))return v;
  const mapped:Row=Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x)]));
  if(v.garrisonFormat!==GARRISON_FORMAT)return mapped;
  mapped.outposts=(mapped.outposts as Row[]).map(p=>{
   const row:Row=Object.create(null);
   for(const [key,x]of Object.entries(p)){
    if(key==='护盾'){(x as unknown[]).forEach((cell,i)=>{if(cell!==absent)row[shieldFields[i]!]=cell;});continue;}
    if(key==='生产'&&Array.isArray(x)){
     const prod:Row=Object.create(null);productionFields.forEach((k,i)=>{if(x[i]!==absent)prod[k]=x[i];});if(object(x[5]))Object.assign(prod,x[5]);row.production={...prod};continue;
    }
    row[own(reverseFields,key)?reverseFields[key]!:key]=key==='可见性'&&typeof x==='number'&&[0,1,2].includes(x)?visibility[x]:x;
   }
   return {...row};
  });
  delete mapped.garrisonFormat;return mapped;
 };
 return visit(expanded);
}
