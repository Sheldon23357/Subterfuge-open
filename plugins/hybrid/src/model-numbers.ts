/** Presentation only. Admission, sorting, thresholds and settlement use original
 * values. Unknown fields, authored text, deadlines and actual receipts are exact. */
export const MODEL_NUMBER_RULES='距离、坐标、评分、比例和条件估算最多显示3位小数，极小非零量保留3位有效数字；分类和排序按程序原值确定，不依据显示尾数重算。实际时刻、期限、额度、实际兵量及回执不按此精度约化。';
export interface ModelNumberChange {path:string;keys:(string|number)[];before:number;after:number}
const fields=[
 /^global\.opening\[\d+\]\.(?:ownDistance|rivalDistance)$/,
 /^global\.players\[\d+\]\.staticVictoryWorldDays$/,
 /^global\.mining\.staticVictoryWorldDays$/,
 /^global\.relations\.competition\[\d+\]\.score$/,
 /^guidance\.diplomacyPurpose\.needs\[\d+\]\.evidence\.(?:pressureRatio|earliestDeficitWorldDays)$/,
 /^(?:global\.)?planning\.candidates\[\d+\]\.(?:score|attackWorldDays|additionalForceEstimate)$/,
 /^(?:global\.)?planning\.candidates\[\d+\]\.launchSources\[\d+\]\.(?:availableEstimate|travelWorldDays)$/,
 /^(?:global\.)?planning\.estimates\.forceSources\[\d+\]\.(?:reserveEstimate|availableEstimate)$/,
 /^guidance\.executionFeasibility\[\d+\]\.(?:safeAvailableEstimate|additionalForceEstimate|earliestListedSourceTravel|travelWorldDays)$/,
 /^guidance\.executionFeasibility\[\d+\]\.listedSources\[\d+\]\.(?:availableEstimate|travelWorldDays)$/,
 /^guidance\.serverAgreements\.current\.(?:ceasefire|jointAttack)\[\d+\]\.feasibility\.observedEnemyTargets\[\d+\]\.additionalForceEstimate$/,
 /^guidance\.serverAgreements\.current\.(?:ceasefire|jointAttack)\[\d+\]\.taskFeasibility\[\d+\]\.(?:additionalForceEstimate|earliestSourceTravel)$/,
 /^global\.feedback\.(?:selected|conditionalAlternatives\[\d+\]|unverified\[\d+\])\.resourceGap\.(?:requiredEstimate|shortfallEstimate)$/,
];
export const modelNumberHasDisplayPrecision=(path:string)=>fields.some(pattern=>pattern.test(path));

/** Preserve nonzero magnitude and sign even below the fixed decimal resolution. */
function displayNumber(value:number){
 if(!Number.isFinite(value)||Number.isInteger(value))return value;
 const rounded=Number(value.toFixed(3));
 return rounded===0?Number(value.toPrecision(3)):rounded;
}

/** Knows semantic table columns, including shared source columns. It never
 * rounds by a bare key such as score/time, nor touches numeric text or schemas. */
export function presentModelNumbers<T>(input:T):{value:T;changes:ModelNumberChange[]}{
 const value=structuredClone(input),changes:ModelNumberChange[]=[];
 const visit=(v:any,path:string,keys:(string|number)[],launchColumns?:string[]):any=>{
  if(typeof v==='number'&&modelNumberHasDisplayPrecision(path)){
   const after=displayNumber(v);if(!Object.is(after,v))changes.push({path,keys,before:v,after});return after;
  }
  const tableRows=(list:any[],columns:string[],listKeys:(string|number)[])=>list.map((row:any[],i)=>
   row.map((x,j)=>visit(x,path+'['+i+'].'+columns[j],[...listKeys,i,j],launchColumns)));
  if(Array.isArray(v)){
   if(path.endsWith('.launchSources')&&launchColumns&&v.every(Array.isArray))return tableRows(v,launchColumns,keys);
   return v.map((x,i)=>visit(x,path+'['+i+']',[...keys,i],launchColumns));
  }
  if(v&&typeof v==='object'){
   launchColumns=Array.isArray(v.launchSourceColumns)?v.launchSourceColumns:launchColumns;
   for(const [key,x]of Object.entries(v)){
    if(['rows','ownPosts'].includes(key)&&Array.isArray(v.columns)&&Array.isArray(x))v[key]=tableRows(x,v.columns,[...keys,key]);
    else v[key]=visit(x,path?path+'.'+key:key,[...keys,key],launchColumns);
   }
  }
  return v;
 };
 return {value:visit(value,'',[]),changes};
}
