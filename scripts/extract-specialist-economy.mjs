import fs from 'node:fs';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const node=name=>{const n=ref.tree.statements.find(n=>n.name?.text===name);if(!n)throw Error(name);return n;};
const methods=(owner,names)=>names.map(name=>{const m=node(owner).members.find(m=>m.name?.getText(ref.tree)===name);if(!m)throw Error(`${owner}.${name}`);return m.getText(ref.tree);}).join('\n');
const code=`// @ts-nocheck
// Verbatim APK12075 specialist economy/sonar excerpts. Do not format. SHA256 ${ref.sha}
// Regenerate: node scripts/extract-specialist-economy.mjs
import {originalCommandTime} from './original-command-time.generated.js';
import {RULES,SPECIALISTS} from '../../rules/src/reference.js';
import {clientDistance,clientDistanceSquared,wrapClientPoint} from './client-geometry.js';
const he=RULES.GameParams,$e=RULES.SpecialistParams,Vn=RULES.OutpostParams,K={MinutesPerTick:10,TicksPerDay:144,MaxSpecialistsPerLocation:128,MaxSubsPerPlayer:128,MaxSpecialistsPerSub:3};
const q={COUNT:31,...Object.fromEntries(SPECIALISTS.map(s=>[s.id,s.client_type_id]))};
const B={Nothing:0,Outpost:1,Sub:2,Specialist:3},pe={Factory:1,Destroyed:3},UG=.5;
const g0={BaseSpeed:0.004999999888};
const He={Moving:'moving'},ta=340282347e30;
const kt=Array.from({length:31},()=>({speed:1}));for(const s of SPECIALISTS)kt[s.client_type_id].speed=s.base_speed_multiplier;
const Z=c=>{if(!c)throw Error('Original specialist economy assertion');};
class mr{constructor(n){this.count=n;this.values=Array(n).fill(0);}get(i){return this.values[i];}set(i,v){this.values[i]=v;}}
class we{constructor(type,index){this.type=type;this.index=index;}set(type,index){this.type=type;this.index=index;return this;}}
const rt={Unknown:0,Known:1,Visible:2},kD=4,xMe=0,wMe=0,B3=new we();
const E={gameState:null};
const fe={instance:()=>({isSimulatedFuture:n=>n.simulatedFuture===true})};
class Circle{set(center,radius){this.center={...center};this.radius=radius;return this;}}
const CX=new Circle(),wX=new Circle();
${node('Ev').getText(ref.tree)}
class te{${methods('te',['teamOf','teamFirstSeat','teamEndSeat'])}}
${['CMe','tp','IX','IMe','TMe'].map(name=>node(name).getText(ref.tree)).join('\n')}
${node('an').getText(ref.tree)}
class ct{${methods('ct',['add','remove','getIndexFor'])}}
const G={copy:(out,p)=>{out.x=p.x;out.y=p.y;return out;}};
class Slots{${methods('V',['getFirstUnusedSubIndexForPlayer'])}}
const $n={getSecondsUntilCommitted:(p,t)=>Math.max(p.secsUntilCommitted-Math.trunc(t),0)};
class Jt{static getSecondsUntilLaunch(p,t){return Math.max(p.secsUntilLaunch-Math.trunc(t),0);}static isGift=originalCommandTime.gift;
${methods('Jt',['getTravelTimeInMinutes'])}}
const qn={getType:originalCommandTime.outpostType};
const ut={countFundersForPlayer:(n,i)=>n.funders[i]};
class V{
static isSpecialistCaptive(w,i){const p=w.specialists.get(i);return p.ownerIndex!==(p.location.type===B.Outpost?w.outposts.get(p.location.index):w.subs.get(p.location.index)).ownerIndex;}
static getItemPosition(w,l){return (l.type===B.Outpost?w.outposts.get(l.index):w.subs.get(l.index)).pos;}
static getMinDist(w,a,b){return clientDistance(a,b,w);}
static getMinDistSquared(a,b,width,height){return clientDistanceSquared(a,b,{width,height});}
static getWrappedPos(width,height,p){return wrapClientPoint(p,{width,height});}
${methods('V',['isElectricalCapKnown'])}
${methods('V',['canOutpostProduceDrillers','calculateDrillerProductionRateByPlayer'])}
static getFirstUnusedSubIndexForPlayer(w,owner){const slot=Slots.getFirstUnusedSubIndexForPlayer(w.slotView,owner);return slot<0?-1:w.allocateSub(slot);}
static setSubPath(w,i,source,destination){w.setReleasePath(i,source,destination);}
${methods('V',['applyDiplomatAbilityForPlayerInLocation','setSpecialistLocation'])}
${methods('V',['getItemOwnerIndex','getSpecialistCountByTypeAtLocation','addSpecialistCountByTypeFromCache','getOutpostIndexForSpecialistAbility','calculateDrillersForNextProductionAtOutpost','calculateTicksBetweenDrillerProductions','getAdjustedOutpostElectricalOutput','getTheoreticalMaxShieldCharge','getCurrentMaxShieldCharge','changeSpecialistOwnership','getStartSpeedupFactor','getStartSpeedupFactorValue','getBaseSpeed','getBestSpeedForLocation','getBestSpeedWithSpecialists'])}
${methods('V',['countSpecialistOfType','getSubTravelTimeInMinutes','getTravelMinutesWithSpeedup'])}
static countSpecialistOfTypeAtLocation(w,l,type,free,captive){const counts=new mr(q.COUNT);V.getSpecialistCountByTypeAtLocation(counts,w,l,free,captive);return counts.get(type);}
}
class Ms{${methods('Ms',['calculate'])}}
class wn{${methods('wn',['computeVisibilityRange','compute','isVisible','isVisibleForPlayer','getVisibility'])}}
${node('n3e').getText(ref.tree)}
${node('kH').getText(ref.tree)}
${node('e1').getText(ref.tree)}
${node('x3e').getText(ref.tree)}
${['x2','Lne','EMe'].map(name=>node(name).getText(ref.tree)).join('\n')}
${['_1','C2','a3e','v3e'].map(name=>node(name).getText(ref.tree)).join('\n')}
${['fre','l3e','c3e'].map(name=>node(name).getText(ref.tree)).join('\n')}
export function originalFactoryPeriod(w,i){return V.calculateTicksBetweenDrillerProductions(w,i);}
export function originalCanFactoryProduce(n,i){return V.canOutpostProduceDrillers(n,i,n.youPlayerIndex);}
export function originalFactoryAmount(n,i,c){return V.calculateDrillersForNextProductionAtOutpost(n,i,c);}
export function originalPlayerProductionRate(n,player){return V.calculateDrillerProductionRateByPlayer(n,player);}
export function originalSonarRange(w,i){return wn.computeVisibilityRange(new we(B.Outpost,i),w);}
export const originalForemenInRange=n3e;
export function originalOutpostShieldMaximum(w,i){if(w.outposts.get(i).private_type===pe.Destroyed)return 0;const counts=new mr(q.COUNT);V.getSpecialistCountByTypeAtLocation(counts,w,new we(B.Outpost,i),true,false);return kH(w,i,counts);}
// This entry is authoritative-state only. Filtered projections must not pass removed hidden specialists.
export const originalElectricalCapKnown=(n,player)=>V.isElectricalCapKnown(n,player);
export function originalGlobalCaches(n){Ms.calculate(n.world.cachedValues,n,{isSimulatedFuture:()=>false});}
/** Same original body, with a per-call forecast context; no mutable singleton. */
export function originalForecastGlobalCaches(n,removed){
 const fe={instance:()=>({isSimulatedFuture:()=>true,getRemovedFreeSpecialistCount:(player,type)=>removed[player][type]})};
 class ForecastMs{${methods('Ms',['calculate'])}}
 ForecastMs.calculate(n.world.cachedValues,n);
}
// Preserve i2e's descending global slot cleanup, independently of local order.
export function originalCleanupDyingSpecialists(count,isDying,destroy){
 const V={destroySpecialist:(_world,slot)=>destroy(slot)};
 ${node('i2e').getText(ref.tree)}
 i2e({world:{specialists:{count,get:slot=>({isDying:isDying(slot)})}}});
}
// V.setSpecialistLocation removes with ct.remove, not removePreservingOrder.
export function originalRemoveLocalSpecialist(elements,id){
 const cache={count:elements.length,elements:elements.slice()};
 ct.remove(cache,ct.getIndexFor(cache,id));return cache.elements.slice(0,cache.count);
}
export function originalFleetSpeed(w,i,destination){return V.getBestSpeedForLocation(w,new we(B.Sub,i),destination);}
export const originalFleetTravelMinutes=(w,i)=>V.getSubTravelTimeInMinutes(w,i);
export const originalPointVisible=(p,player,w,info)=>wn.isVisibleForPlayer(p,player,w,info);
export const originalCountSpecialists=(w,cache,type,free,captive)=>V.countSpecialistOfType(w,cache,type,free,captive);
export const originalAbilityOutpost=(w,i)=>V.getOutpostIndexForSpecialistAbility(w,i);
export const originalTinkererTick=x3e;
export const originalSpecialistActivation=_1;
export const originalHypnotistTick=v3e;
export const originalSentryTick=EMe;
export const originalDiplomatTick=fre;
export const originalDiplomatRelease=V.applyDiplomatAbilityForPlayerInLocation;
export function originalVisibility(world,player,info){
 const result={areas:new an(world.outposts.count),outposts:new mr(world.outposts.count),subs:new mr(world.subs.count)};
 E.gameState={world,info};
 try{wn.compute(result,world,player,world,info);return{outposts:result.outposts.values,fleets:result.subs.values,areas:result.areas.elements.slice(0,result.areas.count).map(a=>({center:{...a.center},radius:a.visRadius}))};}
 finally{E.gameState=null;}
}
// Post-combat effects in V.handleSubArrival, after transfer and before Queen demotion.
export function originalAfterHostileArrival(s,a){
 V.countSpecialistOfTypeAtLocation(s, new we(B.Outpost, a), q.Inspector, !0, !1) > 0 && (s.outposts.get(a).shieldCharge = V.getCurrentMaxShieldCharge(s, a));
 V.countSpecialistOfTypeAtLocation(s, new we(B.Outpost, a), q.Hypnotist, !0, !1) > 0 && C2(s, a);
}
// Exact post-transfer branch of wm; movement itself is performed by the world adapter.
export function originalAfterSpecialistTransfer(n,t,i){${node('wm').body.statements.find(s=>s.getText(ref.tree).startsWith('if (t.type == B.Outpost')).getText(ref.tree)}}
`;
const path='packages/engine/src/original-specialist-economy.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Specialist economy extraction differs from APK');console.log('Specialist economy excerpts match locked APK.');}else fs.writeFileSync(path,code);
