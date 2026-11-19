type Row=Record<string,any>;
const rows=(value:any):Row[]=>Array.isArray(value)?value:value?.columns&&value?.rows?value.rows.map((row:any[])=>Object.fromEntries(value.columns.map((key:string,i:number)=>[key,row[i]]))):[];
const conclusions:Record<string,string>={action:'通过进攻初筛，仍需前台战术验证',conditional:'进攻条件尚需满足或验证',review:'已有己方进攻在途，需复核既有行动'};

/** An explicitly relevant program conclusion, never a second tactical shortlist. */
export function attackConclusions(planning:Row|undefined,targets:ReadonlySet<string>){
 if(!planning||!targets.size)return undefined;
 const assessments=rows(planning.candidates).filter(c=>targets.has(c.target)).flatMap(c=>{
  const conclusion=c.assessment?.conclusion??conclusions[c.classification];
  return conclusion?[{target:c.target,conclusion,reasons:c.assessment?.reasons??[]}]:[];
 });
 for(const excluded of planning.excluded??[])if(targets.has(excluded.target)&&!assessments.some(a=>a.target===excluded.target)){
  assessments.push({target:excluded.target,conclusion:'未形成可用进攻初筛方案',reasons:[excluded.reason==='no-uncommitted-source-within-time-window'?'当前窗口内没有未占用的出兵来源':excluded.reason]});
 }
 return assessments.length?{...(typeof planning.worldDay==='number'?{assessedAtWorldDay:planning.worldDay}:{}),targets:assessments,meaning:'仅本轮相关目标的程序初筛结论，不代表前台已选方案或实际执行；前台自主完成战术选择，模型只调整战略方向和约束。未列出不代表不可进攻。'}:undefined;
}
