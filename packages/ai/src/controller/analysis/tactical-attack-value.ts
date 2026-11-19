import type {PlayerObservation} from '../../../../contracts/src/index.js';
import type {KnownPathEvidence,KnownPredictionDraft} from '../../../../prediction/src/index.js';
import {RULES} from '../../../../rules/src/index.js';
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
export const MAX_ATTRITION_FORCE_FRACTION=0.25;
/** Relative public victory pressure, not a prediction of hidden enemy plans.
 * Equal public standings get equal weights, regardless of player number. */
export function botOpponentWeight(o:PlayerObservation,player:number):number{
 const v=o.view,goal=v.match?.mode==='domination'?RULES.GameParams.DominationRequirementByPlayerCount[v.playerCount]??Infinity:v.match?.neptuniumGoal??Infinity;
 const standings=o.intel.filter(p=>p.active),target=standings.find(p=>p.player===player&&p.player!==v.player);
 if(!target)return 0;
 const eta=(p:typeof target)=>p.npPerDay>0?144*Math.max(0,goal-p.neptunium)/p.npPerDay:Infinity;
 const compare=(a:typeof target,b:typeof target)=>v.match?.mode==='domination'?b.numOutposts-a.numOutposts:eta(a)-eta(b)||b.neptunium-a.neptunium;
 const better=standings.filter(p=>compare(p,target)<0).length,equal=standings.filter(p=>compare(p,target)===0).length;
 const rank=standings.length===1?1:1-(better+(equal-1)/2)/(standings.length-1);
 const urgency=v.match?.mode==='domination'?clamp((target.numOutposts/goal-0.5)*2):clamp(1-eta(target)/288);
 return 0.4+0.8*rank+0.6*urgency;
}
export function attackPathMatches(o:PlayerObservation,path:KnownPathEvidence|null|undefined):path is KnownPathEvidence{
 return !!path&&path.conditional&&path.roomId===o.roomId&&path.player===o.view.player&&path.basisRevision===o.revision&&path.observedTick===o.view.tick&&path.observedSeconds===o.secondsSinceLastTick&&path.coverage.complete;
}
export interface AttackValue {enemyAttrition:number;capacityPressure:number;jointPressure:number;enemyLosses:number;ownLosses:number}
/** Upper bound on the raid admission gate, not on the full strategic score.
 * New ordinary fleets cannot kill more troops than they lose, or more than
 * their initial force. Include every active opponent for en-route fights.
 * Existing fleet edits have different force semantics and keep full checks. */
export function botAttritionBenefitUpperBound(o:PlayerObservation,drafts:readonly KnownPredictionDraft[],joint:readonly {target:string;until?:number}[]=[]):number{
 if(!drafts.length||drafts.some(d=>d.action.kind!=='launch'||d.action.fleetId!==undefined||!Number.isSafeInteger(d.action.drillers)||Number(d.action.drillers)<=0))return Infinity;
 const force=drafts.reduce((n,d)=>n+Number(d.action.drillers),0);
 const weight=Math.max(0,...o.intel.filter(p=>p.active&&p.player!==o.view.player).map(p=>botOpponentWeight(o,p.player)));
 const now=o.view.tick+o.secondsSinceLastTick/600;
 const jointFactor=joint.some(j=>j.until===undefined||j.until>now)?1.25:1;
 const production=o.view.outposts.some(p=>p.owner===o.view.player&&p.visibility===2&&p.type==='factory'&&p.metrics?.cycleMinutes&&p.metrics.cycleMinutes>0&&p.metrics.output>0);
 const pressure=production&&o.view.self.capacity>0?clamp((o.view.self.drillers/o.view.self.capacity-0.8)/0.2):0;
 return force*Math.max(0,weight*jointFactor+pressure*0.35-1);
}
/** Count only explicit projected troop losses in authorized battles involving us.
 * Shields, foreign-vs-foreign battles and missing endpoints earn no casualty credit. */
export function botAttackValue(o:PlayerObservation,path:KnownPathEvidence|null|undefined,joint:readonly {target:string;until?:number}[]=[],drafts?:readonly KnownPredictionDraft[]):AttackValue{
 const result:AttackValue={enemyAttrition:0,capacityPressure:0,jointPressure:0,enemyLosses:0,ownLosses:0};
 if(!attackPathMatches(o,path))return result;
 const fleetIds=drafts?new Set(path.orderFleets.filter(f=>f.status==='executed'&&drafts.some(d=>d.id===f.orderId&&d.action.kind==='launch')).map(f=>f.fleetId)):null;
 const loss=(before:unknown,after:unknown)=>typeof before==='number'&&Number.isFinite(before)&&before>=0&&typeof after==='number'&&Number.isFinite(after)&&after>=0&&after<=before?before-after:0;
 for(const e of path.events){
  if(e.kind!=='battle')continue;
  const d=e.details,attacking=d.attackerOwner===o.view.player,defending=d.defenderOwner===o.view.player;
  if(!attacking&&!defending||attacking&&defending)continue;
  if(!o.view.outposts.some(p=>p.id===d.target&&p.visibility===2)&&!o.view.fleets.some(f=>f.id===d.target)&&!path.orderFleets.some(f=>f.status==='executed'&&f.fleetId===d.target))continue;
  // The new sortie may also fight an explicitly simulated fleet en route,
  // including being the defender in a fleet interception.
  if(fleetIds&&!(attacking?fleetIds.has(e.subject):fleetIds.has(String(d.target))))continue;
  const enemy=attacking?d.defenderOwner:d.attackerOwner;
  if(typeof enemy!=='number'||!o.intel.some(p=>p.player===enemy&&p.active&&enemy!==o.view.player))continue;
  const inflicted=attacking?loss(d.defenderBefore,d.defender):loss(d.attackerBefore,d.attacker);
  const own=attacking?loss(d.attackerBefore,d.attacker):loss(d.defenderBefore,d.defender);
  result.enemyLosses+=inflicted;result.ownLosses+=own;
  const value=inflicted*botOpponentWeight(o,enemy);result.enemyAttrition+=value;
  if(attacking&&o.view.outposts.some(p=>p.id===d.target&&p.owner===enemy)&&joint.some(j=>j.target===d.target&&(j.until===undefined||e.tick-1+e.fraction<j.until)))result.jointPressure+=value*0.25;
 }
 const force=o.view.self.drillers,capacity=o.view.self.capacity;
 const pressure=capacity>0?clamp((force/capacity-0.8)/0.2):0;
 const production=o.view.outposts.filter(p=>p.owner===o.view.player&&p.visibility===2&&p.type==='factory').reduce((n,p)=>n+(p.metrics?.cycleMinutes&&p.metrics.cycleMinutes>0?p.metrics.output*10/p.metrics.cycleMinutes:0),0);
 const window=Math.max(0,path.actualTargetTick-o.view.tick-o.secondsSinceLastTick/600);
 const freed=Math.max(0,result.ownLosses-Math.max(0,force-capacity));
 result.capacityPressure=Math.min(freed,result.enemyLosses,production*window)*pressure*0.35;
 return result;
}
/** A raid must demonstrate a beneficial direct exchange, not merely arrive or
 * spend troops. Base utility still charges own losses, commitment and exposure. */
export function botAttritionAllowed(o:PlayerObservation,path:KnownPathEvidence|null|undefined,drafts:readonly KnownPredictionDraft[],joint:readonly {target:string;until?:number}[]=[],margin=2){
 const force=drafts.reduce((n,d)=>n+Number(d.action.drillers??0),0);
 if(!force||force>Math.floor(o.view.self.drillers*MAX_ATTRITION_FORCE_FRACTION)||drafts.some(d=>d.action.kind!=='launch'||!o.view.outposts.some(p=>p.id===d.action.destination&&p.visibility===2&&p.owner!=null&&p.owner!==o.view.player)))return false;
 const value=botAttackValue(o,path,joint,drafts);
 return value.enemyLosses>0&&value.enemyAttrition+value.capacityPressure+value.jointPressure>value.ownLosses+margin;
}
