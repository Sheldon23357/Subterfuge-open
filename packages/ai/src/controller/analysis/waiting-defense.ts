import type {PlayerMapView} from '../../../../contracts/src/index.js';

/** Foreign source IDs are private. Infer only a unique same-owner outpost
 * at the observed waiting position, including equivalent wrapped coordinates. */
export function enemyWaitingSources(v:PlayerMapView){
 return new Map(v.fleets.filter(f=>f.owner!==v.player&&f.state==='waiting'&&f.departureCommitted!==true).flatMap(f=>{
   const at=v.outposts.filter(p=>p.owner===f.owner&&(['x','y'] as const).every(a=>{
     const size=a==='x'?v.size.width:v.size.height;
     const d=((f.position[a]-p.position[a])%size+size)%size;
     return Math.min(d,size-d)<1e-8;
   }));
   return at.length===1?[[f.id,at[0]!.id] as const]:[];
 }));
}
