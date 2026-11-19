import type {BotSearchProgress,BotLiveSnapshot} from '../../contracts/src/index.js';
type Branch=BotSearchProgress['branches'][number];
export interface SearchNetworkFrame {scope:string;sequence:number;observedTick:number|null;branches:Branch[];settled:boolean;selected?:string}
/** Merge only within a binding and round. Final receipts update nodes, never replace the graph. */
export function mergeSearchNetwork(previous:SearchNetworkFrame|undefined,scope:string,progress:{sequence:number;progress:BotSearchProgress}|undefined,decision:BotLiveSnapshot['decision']|undefined,searching:boolean):SearchNetworkFrame{
 const old=previous?.scope===scope?previous:undefined;
 const sequence=Math.max(old?.sequence??-1,progress?.sequence??-1,decision?.sequence??-1);
 const frame:SearchNetworkFrame=old?.sequence===sequence?{...old}: {scope,sequence,observedTick:null,branches:[],settled:false};
 const nodes=new Map(frame.branches.map(b=>[b.id,b]));
 if(progress?.sequence===sequence){for(const b of progress.progress.branches)nodes.set(b.id,b);frame.observedTick=progress.progress.observedTick;frame.settled=false;delete frame.selected;}
 if(!searching&&decision?.sequence===sequence){
  for(const b of decision.branches)nodes.set(b.id,b);
  for(const [id,b] of nodes)if(b.status==='running')nodes.set(id,{...b,status:'interrupted'});
  frame.observedTick=decision.observedTick;frame.settled=decision.finalized;if(decision.finalized)frame.selected=decision.selected;else delete frame.selected;
 }
 frame.branches=[...nodes.values()];return frame;
}
/** Identity controls position; arrivals, sorting and result status cannot move existing nodes. */
export function searchNodePosition(id:string,center:{x:number;y:number;rx:number;ry:number}){
 let hash=2166136261;for(const c of id)hash=Math.imul(hash^c.charCodeAt(0),16777619);
 // Avalanche similar suffixes (e.g. force sizes 21, 22, 23) before placing nodes.
 hash=Math.imul(hash^(hash>>>16),0x85ebca6b);hash=Math.imul(hash^(hash>>>13),0xc2b2ae35);hash^=hash>>>16;
 const angle=(hash&65535)/65536*Math.PI*2,radius=Math.sqrt(((hash>>>16)+.5)/65536);
 return {x:center.x+Math.cos(angle)*center.rx*radius,y:center.y+Math.sin(angle)*center.ry*radius};
}

/** A single cubic with chord-aligned tangents, gentle outward curvature and no midpoint corner. */
export function searchConnectionPath(a:{x:number;y:number},b:{x:number;y:number},w:number,h:number){
 const ax=a.x*w,ay=a.y*h,bx=b.x*w,by=b.y*h,dx=bx-ax,dy=by-ay,length=Math.hypot(dx,dy);
 if(length<.001)return `M${ax} ${ay}C${ax} ${ay} ${bx} ${by} ${bx} ${by}`;
 const nx=-dy/length,ny=dx/length,mx=(ax+bx)/2,my=(ay+by)/2,sign=(mx-w/2)*nx+(my-h/2)*ny<0?-1:1;
 const t=Math.max(0,Math.min(1,((w/2-ax)*dx+(h/2-ay)*dy)/(length*length))),px=ax+t*dx,py=ay+t*dy;
 const central=((px-w/2)/(w*.10))**2+((py-h/2)/(h*.17))**2<1;
 const bend=Math.min(length*.48,Math.max(Math.min(length*.16,h*.11),central?h*.30:0))*sign;
 return `M${ax} ${ay}C${ax+dx*.34+nx*bend} ${ay+dy*.34+ny*bend} ${ax+dx*.66+nx*bend} ${ay+dy*.66+ny*bend} ${bx} ${by}`;
}

/** Bundles select their real constituent candidates; never render an extra combined dot. */
export function searchNetworkScene(branches:Branch[]):{nodes:Branch[];bundles:{branch:Branch;members:string[]}[]}{
 const nodes=new Map(branches.filter(b=>b.kind!=='combined'&&!b.components?.length).map(b=>[b.id,b]));
 const bundles=branches.filter(b=>b.kind==='combined'||!!b.components?.length).map(b=>({branch:b,members:(b.components??[]).map(p=>p.id)}));
 for(const {branch} of bundles)for(const part of branch.components??[])if(!nodes.has(part.id))nodes.set(part.id,{...part,status:'component',utility:null});
 return {nodes:[...nodes.values()],bundles};
}
export function searchNetworkSelection(scene:ReturnType<typeof searchNetworkScene>,id:string|undefined){
 if(!id)return [];
 const bundle=scene.bundles.find(b=>b.branch.id===id);
 return bundle?bundle.members:scene.nodes.some(n=>n.id===id)?[id]:[];
}

/** Edges are undirected facts: shared targets, shared launch origins, or real bundle membership. */
export function searchNetworkEdges(scene:ReturnType<typeof searchNetworkScene>,positions:ReadonlyMap<string,{x:number;y:number}>){
 const edges=new Map<string,{a:string;b:string;relation:'target'|'source'|'bundle';bundles:string[]}>();
 const add=(a:string,b:string,relation:'target'|'source'|'bundle',bundle?:string)=>{
  if(a===b)return;const [left,right]=[a,b].sort(),key=left+'|'+right,old=edges.get(key);
  if(old){if(bundle){old.relation='bundle';if(!old.bundles.includes(bundle))old.bundles.push(bundle);}return;}
  edges.set(key,{a:left!,b:right!,relation,bundles:bundle?[bundle]:[]});
 };
 const distance=(a:Branch,b:Branch)=>{const p=positions.get(a.id)!,q=positions.get(b.id)!;return Math.hypot((p.x-q.x)*1.5,p.y-q.y);};
 const nodes=scene.nodes.filter(n=>n.kind!=='hold');
 for(const a of nodes){
  const peers=nodes.filter(b=>b.id!==a.id).sort((b,c)=>distance(a,b)-distance(a,c));
  for(const b of peers.filter(b=>a.targets.some(t=>b.targets.includes(t))).slice(0,2))add(a.id,b.id,'target');
  const source=peers.find(b=>a.routes.some(r=>b.routes.some(s=>s.source===r.source)));
  if(source)add(a.id,source.id,'source');
 }
 for(const bundle of scene.bundles)for(let i=0;i<bundle.members.length;i++)for(let j=i+1;j<bundle.members.length;j++)add(bundle.members[i]!,bundle.members[j]!,'bundle',bundle.branch.id);
 return [...edges.values()];
}

/** Stable organic clusters; reserve a central gap for the hold baseline. */
export function placeSearchNodes(branches:{id:string;kind:string;targets?:string[];routes?:{source:string;target:string;drillers:number|null}[]}[],previous:ReadonlyMap<string,{x:number;y:number}>=new Map()){
 const placed=new Map(previous),occupied=[...placed.values()],slots:{x:number;y:number}[]=[];
 const cells=new Map<string,{x:number;y:number}[]>(),cellKey=(x:number,y:number)=>x+':'+y;
 const occupy=(p:{x:number;y:number})=>{const key=cellKey(Math.floor(p.x/.067),Math.floor(p.y/.067));cells.set(key,[...(cells.get(key)??[]),p]);};
 const available=(p:{x:number;y:number})=>{const x=Math.floor(p.x/.067),y=Math.floor(p.y/.067);for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)if(cells.get(cellKey(x+dx,y+dy))?.some(o=>Math.hypot((o.x-p.x)*1.65,o.y-p.y)<.067))return false;return true;};
 occupied.forEach(occupy);
 const relation=(b:typeof branches[number])=>([...(b.targets??[])].sort().join('|')||[...new Set((b.routes??[]).map(r=>r.target))].sort().join('|')||b.id);
 const keys=[...new Set(branches.filter(b=>b.kind!=='hold').map(relation))].sort();
 const byId=new Map(branches.map(b=>[b.id,b])),clusters=new Map<string,{x:number;y:number}>(),counts=new Map<string,number>();
 for(const [id,p] of previous){const b=byId.get(id);if(b){const key=relation(b);if(b.kind!=='hold'&&!clusters.has(key))clusters.set(key,p);counts.set(key,(counts.get(key)??0)+1);}}
 for(let i=1;i<1800;i++){
  const p={x:.055+((i*.754877666)%1)*.89,y:.14+((i*.569840291)%1)*.70};
  if((p.x-.5)**2/.075**2+(p.y-.5)**2/.16**2>=1&&!(p.x>.80&&p.y>.62))slots.push(p);
 }

 for(const b of [...branches].sort((a,b)=>a.id.localeCompare(b.id))){
  if(placed.has(b.id))continue;
  if(b.kind==='hold'){placed.set(b.id,{x:.5,y:.5});continue;}
  const key=relation(b),angleSeed=-2.5+keys.indexOf(key)*2.399963,related=!!(b.targets?.length||b.routes?.length),cluster=clusters.get(key)??{x:.5+Math.cos(angleSeed)*(related?.25:.37),y:.5+Math.sin(angleSeed)*(related?.21:.29)},index=counts.get(key)??0;
  const angle=index*2.399963,radius=Math.sqrt(index),preferred={x:cluster.x+Math.cos(angle)*radius*.056,y:cluster.y+Math.sin(angle)*radius*.078};
  let p:{x:number;y:number}|undefined,best=Infinity;
  for(const slot of slots){const d=((slot.x-preferred.x)*1.7)**2+(slot.y-preferred.y)**2;if(d<best&&available(slot)){p=slot;best=d;}}
  p??=slots.map(s=>({x:s.x+.011,y:s.y+.022})).find(s=>!occupied.some(o=>Math.hypot(o.x-s.x,o.y-s.y)<.005))??preferred;
  placed.set(b.id,p);occupied.push(p);occupy(p);if(!clusters.has(key))clusters.set(key,p);counts.set(key,index+1);
 }
 return placed;
}
