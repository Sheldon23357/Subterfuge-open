export interface TerritoryPoint {id:string;owner?:number|null;destroyed?:boolean;position:{x:number;y:number}}
/** Average within the shortest covering arc: the seam is not a territory boundary. */
function axisCenter(values:number[],period:number){
  const sorted=values.map(v=>((v%period)+period)%period).sort((a,b)=>a-b);
  let gap=-1,start=sorted[0]!;
  for(let i=0;i<sorted.length;i++){
    const next=sorted[(i+1)%sorted.length]!,distance=next+(i===sorted.length-1?period:0)-sorted[i]!;
    if(distance>gap){gap=distance;start=next;}
  }
  const value=(sorted.reduce((sum,v)=>sum+(v<start?v+period:v),0)/sorted.length)%period;
  return value>=period/2?value-period:value;
}
export function territoryCenters(points:TerritoryPoint[],size:{width:number;height:number}){
  if(!(size.width>0&&size.height>0))return [];
  const groups=new Map<number,TerritoryPoint[]>(),seen=new Set<string>();
  for(const p of points){if(seen.has(p.id)||p.owner==null||p.destroyed)continue;seen.add(p.id);const group=groups.get(p.owner)??[];group.push(p);groups.set(p.owner,group);}
  return [...groups].sort(([a],[b])=>a-b).map(([owner,posts])=>({owner,position:{x:axisCenter(posts.map(p=>p.position.x),size.width),y:axisCenter(posts.map(p=>p.position.y),size.height)}}));
}
