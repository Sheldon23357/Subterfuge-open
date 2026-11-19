import type {PlayerObservation,PlayerMapView,PlayerForecastResult,AttackRoutes} from '../../../../contracts/src/index.js';
import {createKnownForceRouteEstimator,basicRouteTicks} from '../../../../prediction/src/index.js';
import {scheduledCommitments} from './scheduled-commitments.js';
import {loadOutpostRiskConfig,type OutpostRiskConfig} from './outpost-risk-config.js';

type Frame=PlayerMapView|PlayerForecastResult;
type Post=PlayerMapView['outposts'][number];
export interface OutpostRisk {
 id:string;basis:'authorized-static-pressure';available:number;defense:number;enemy:number;
 support:{id:string;ticks:number;available:number;weighted:number}[];
 firstSupportTicks:number;secondSupportTicks:number;friendlyIncoming:number;hostileIncoming:number;
 pressureRatio:number;shortfall:number;requiredGarrison:number;importance:number;priority:number;penalty:number;
 earliestDeficitTicks:number|null;arrivalShortfall:number;unknowns:string[];
}
/** Conditional endpoints get their own clock, ownership, fleets and remaining
 * reservations. Never reuse current-route caches against a future frame. */
export function riskObservation(o:PlayerObservation,frame:Frame):PlayerObservation {
 if(frame===o.view)return o;
 if(!('targetTick'in frame))return {...o,view:frame};
 return {...o,secondsSinceLastTick:0,scheduled:o.scheduled.filter(s=>s.issueTick>frame.targetTick),
  view:{...o.view,...frame,format:'player-observation/2',tick:frame.targetTick,match:frame.match?{...frame.match,ended:frame.match.ended!==null}:o.view.match}};
}

/** Potential mobilization, not an attack forecast. Each point is an independent
 * pressure estimate; joint orders still share the real resource budget. */
export function createOutpostRiskAnalysis(o:PlayerObservation,config:OutpostRiskConfig=loadOutpostRiskConfig(),knownRoutes?:AttackRoutes){
 const v=o.view,posts=v.outposts.filter(p=>!p.destroyed),commitments=new Map(scheduledCommitments(o).map(c=>[c.source,c]));
 let estimator:ReturnType<typeof createKnownForceRouteEstimator>|undefined;
 const timing=()=>estimator??=createKnownForceRouteEstimator(o);
 const postTime=(source:string,target:string,maxTicks:number)=>{
  if(knownRoutes&&Object.hasOwn(knownRoutes.postTicks[source]??{},target)){
   const ticks=knownRoutes.postTicks[source]![target];return ticks!=null&&ticks<=maxTicks?ticks:null;
  }
  {
   const from=posts.find(p=>p.id===source),to=posts.find(p=>p.id===target);
   return from&&to?basicRouteTicks(from.position,to.position,v.size,v.tick,maxTicks):null;
  }
 };
 const fleetTime=(id:string)=>{
  if(knownRoutes&&Object.hasOwn(knownRoutes.fleetTicks,id))return knownRoutes.fleetTicks[id]??null;
  return timing().fleet(id,144);
 };
 const cache=new Map<string,OutpostRisk>();
 const available=(p:Post)=>p.drillers===undefined||p.owner===v.player&&commitments.get(p.id)?.unknownSchedules.length?0:
  Math.max(0,p.drillers-(p.owner===v.player?commitments.get(p.id)?.drillers??0:0));
 const get=(id:string):OutpostRisk=>{
  const saved=cache.get(id);if(saved)return saved;
  const p=posts.find(p=>p.id===id);if(!p)throw Error(`Unknown risk outpost: ${id}`);
  const unknowns=new Set<string>(),owner=p.owner;
  const addUnknown=(p:Post)=>{if(p.owner===undefined||p.visibility!==2||p.drillers===undefined)unknowns.add(`garrison:${p.id}`);};
  addUnknown(p);if(p.shield===undefined)unknowns.add(`shield:${id}`);
  if(owner===v.player&&commitments.get(id)?.unknownSchedules.length)unknowns.add(`commitment:${id}`);
  const support=owner==null?[]:posts.filter(s=>s.id!==id&&s.owner===owner).flatMap(s=>{
   const ticks=postTime(s.id,id,config.horizonTicks);
   if(ticks===null)return [];
   addUnknown(s);if(owner===v.player&&commitments.get(s.id)?.unknownSchedules.length)unknowns.add(`commitment:${s.id}`);
   return available(s)<=0?[]:[{id:s.id,ticks,available:available(s),weighted:0}];
  }).sort((a,b)=>a.ticks-b.ticks||a.id.localeCompare(b.id)).slice(0,2);
  support.forEach((s,i)=>{s.weighted=s.available*(i===0?config.firstSupportWeight:config.secondSupportWeight);});
  const first=support[0]?.ticks??config.horizonTicks,second=support[1]?.ticks??config.horizonTicks;
  let enemy=0,friendlyIncoming=0,hostileIncoming=0;
  for(const other of posts){
   if(other.id===id||owner!=null&&other.owner===owner||other.owner===null)continue;
   // Unknown geometry is never converted to an undefended or zero-force enemy.
   if(other.owner===undefined||other.visibility!==2||other.drillers===undefined){
    const row=knownRoutes?.postTicks[other.id];
    const near=row&&Object.hasOwn(row,id)?row[id]:basicRouteTicks(other.position,p.position,v.size,v.tick,config.horizonTicks);
    if(near!=null&&near<=config.horizonTicks)addUnknown(other);
    continue;
   }
   const ticks=postTime(other.id,id,config.horizonTicks);if(ticks===null||ticks>second)continue;
   enemy+=available(other)*(ticks<=first?1:config.outerEnemyWeight);
  }
  const waves:{ticks:number;force:number;friendly:boolean}[]=[];
  for(const f of v.fleets){
   if(f.destination?.kind!=='outpost'||f.destination.id!==id)continue;
   const friendly=owner!=null&&(f.owner===owner||f.gift);
   const ticks=fleetTime(f.id);
   if(ticks===null){unknowns.add(`arrival:${f.id}`);if(!friendly)hostileIncoming+=f.drillers;continue;}
   waves.push({ticks,force:f.drillers,friendly});
   if(friendly){if(ticks<=second)friendlyIncoming+=f.drillers;}
   else{hostileIncoming+=f.drillers;if(ticks<=second)enemy+=f.drillers*(ticks<=first?1:config.outerEnemyWeight);}
  }
  // Same-tick arrivals are conservatively hostile-first: this static estimate
  // does not claim to resolve fractional combat order.
  waves.sort((a,b)=>a.ticks-b.ticks||Number(a.friendly)-Number(b.friendly));
  let balance=p.shield??0,requiredArrival=0,earliestDeficitTicks:number|null=null;
  for(const wave of waves){balance+=wave.friendly?wave.force:-wave.force;
   if(!wave.friendly&&wave.force>0)requiredArrival=Math.max(requiredArrival,1-balance);
   if(!wave.friendly&&wave.force>0&&balance+available(p)<=0&&earliestDeficitTicks===null)earliestDeficitTicks=wave.ticks;
  }
  // Unresolved observed attacks remain a demand, never a promise of safety.
  const unresolved=v.fleets.filter(f=>f.destination?.kind==='outpost'&&f.destination.id===id&&f.owner!==owner&&!f.gift&&fleetTime(f.id)===null).reduce((n,f)=>n+f.drillers,0);
  requiredArrival=Math.max(requiredArrival,unresolved>0?unresolved+1-(p.shield??0):0);
  const supportForce=support.reduce((n,s)=>n+s.weighted,0),defense=available(p)+(p.shield??0)+friendlyIncoming+supportForce;
  const requiredGarrison=Math.max(0,Math.ceil(enemy-(p.shield??0)-friendlyIncoming-supportForce),Math.ceil(requiredArrival));
  const arrivalShortfall=Math.max(0,requiredArrival-available(p)),shortfall=Math.max(0,requiredGarrison-available(p));
  const importance=p.type==='mine'?config.mineMultiplier:1,pressureRatio=enemy/Math.max(1,defense);
  const result:OutpostRisk={id,basis:'authorized-static-pressure',available:available(p),defense,enemy,support,firstSupportTicks:first,secondSupportTicks:second,
   friendlyIncoming,hostileIncoming,pressureRatio,shortfall,requiredGarrison,importance,priority:Math.max(pressureRatio,arrivalShortfall>0?1+arrivalShortfall/Math.max(1,available(p)+(p.shield??0)):0)*importance,
   penalty:(shortfall+0.1*enemy*enemy/Math.max(1,defense+enemy))*importance*0.5,
   earliestDeficitTicks,arrivalShortfall,unknowns:[...unknowns].sort()};
  cache.set(id,result);return result;
 };
 return {get,config,available,routes:knownRoutes,
  own:()=>posts.filter(p=>p.owner===v.player).map(p=>get(p.id)),
  /** Ordinary nearest targets plus strategically necessary exceptions. */
  targets:(extra:readonly string[]=[])=>{
   const own=posts.filter(p=>p.owner===v.player);
   const ranked=posts.filter(p=>p.owner!==v.player).map(p=>({p,time:Math.min(Infinity,...own.map(s=>postTime(s.id,p.id,144)??Infinity))}))
    .sort((a,b)=>a.time-b.time||a.p.id.localeCompare(b.p.id));
   const selected=new Set([...extra,...ranked.slice(0,config.targetLimit).map(x=>x.p.id)]);
   for(const {p} of ranked)if(p.type==='mine'
    ||v.fleets.some(f=>f.destination?.kind==='outpost'&&f.destination.id===p.id))selected.add(p.id);
   return selected;
  },
 };
}
export type OutpostRiskAnalysis=ReturnType<typeof createOutpostRiskAnalysis>;
