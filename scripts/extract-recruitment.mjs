import fs from 'node:fs';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const node=name=>{const n=ref.tree.statements.find(n=>n.name?.text===name);if(!n)throw Error(name);return n;};
const methods=(owner,names)=>names.map(name=>{const m=node(owner).members.find(m=>m.name?.getText(ref.tree)===name);if(!m)throw Error(`${owner}.${name}`);return m.getText(ref.tree);}).join('\n');
const hire=node('kr').members.find(m=>m.name?.getText(ref.tree)==='hireSpecialist');
if(!hire)throw Error('Original hire method missing');
const code=`// @ts-nocheck
// Verbatim APK12075 recruitment excerpts. Do not format. SHA256 ${ref.sha}
// Regenerate: node scripts/extract-recruitment.mjs
import {RULES,SPECIALISTS} from '../../rules/src/reference.js';
const he=RULES.GameParams,K={MinutesPerTick:10,MaxSpecialistsPerPlayer:48},kc={NumHireOptions:3};
const q={Invalid:0,COUNT:31,...Object.fromEntries(SPECIALISTS.map(s=>[s.id,s.client_type_id]))};
const mh={Attack:1,Defense:2,Other:3,Promoted:4},categories={attack:1,defense:2,other:3,promoted:4};
const kt=Array.from({length:31},()=>({category:0,promotesTo:0,amount:0}));
for(const s of SPECIALISTS)kt[s.client_type_id]={category:categories[s.category]??0,promotesTo:q[s.promotes_to]??0,amount:s.hire_bundle_size};
const DD=3,fne=2147483647,MPe=32767,B={Nothing:0,Outpost:1,Sub:2},ke={InProgress:0,WaitingToStart:1};
const Z=c=>{if(!c)throw Error('Original recruitment assertion');};
${['an','p0','I3','I2e','T2e','pX','k3'].map(n=>node(n).getText(ref.tree)).join('\n')}
class ct{${methods('ct',['add'])}}
class mr{constructor(n){this.count=n;this.elements=Array(n).fill(0);}get(i){return this.elements[i];}set(i,v){this.elements[i]=v;}}
const oI=new p0;
class ut{${methods('ut',['generateDeterministicDrawSeed'])}}
class Ag{${methods('Ag',['getSpecialistsForHire'])}}
class $n{${methods('$n',['getUnpromotedType','getSecondsUntilCommitted','isBeingHired','isBeingPromoted'])}}
const fo=(n,i)=>n.playerStates.get(i).active;
// Host bridges are mandatory: no silently omitted world effects or cache updates.
const Ms={calculate:(_c,n)=>n.world.hooks.recalculate(n)};
class V{
static isSpecialistCaptive(w,i){return w.hooks.isCaptive(w,i);}
${methods('V',['getQueenIndex','playerHasPendingPromotionOrHire'])}
static addSpecialist(w,t,o,l){return w.hooks.addSpecialist(w,t,o,l);}
static destroySpecialist(w,i){return w.hooks.destroySpecialist(w,i);}
static getOutpostIndexForSpecialistAbility(w,i){return w.hooks.getAbilityOutpost(w,i);}
${methods('V',['commitPendingSpecialistsForPlayer'])}
}
const _1=(w,i)=>w.hooks.activate(w,i);
class kr{${methods('kr',['hireSpecialist','togglePromoteSpecialist','cancelHireSpecialist','finalizeHireOrPromotion'])}}
${node('y3e').getText(ref.tree)}
${node('i3e').getText(ref.tree)}
export const originalAllocateSpecialistSlot=i3e;
export const originalRecruitment={hire:kr.hireSpecialist,promote:kr.togglePromoteSpecialist,cancel:kr.cancelHireSpecialist,commit:kr.finalizeHireOrPromotion,tick:y3e};
// Same original hire body; only draw lookup is supplied by restricted knowledge.
// Never call the deterministic seed generator for a forecast's unknown draw.
export function originalHireWithKnownDraw(state,player,data,uid,lookup){
 const Ag={getSpecialistsForHire:(out,seat,number)=>{const choices=lookup(seat,number);if(choices.length!==3)throw Error('Invalid known recruitment draw');choices.forEach((type,i)=>out.set(i,type));}};
 const hire=function(${hire.parameters.map(p=>p.getText(ref.tree)).join(',')})${hire.body.getText(ref.tree)};
 return hire(state,player,data,uid);
}
export function originalHireOptions(seed,player,number){if(seed<0)throw Error('Puzzle seeds require tutorial data');const result=new mr(3);Ag.getSpecialistsForHire(result,player,number,seed);return result.elements;}
export const originalPendingRecruitment=V.playerHasPendingPromotionOrHire;
// Exact time-machine preview gates. The caller supplies the present/offset
// bridges and a draw lookup; null means that draw is absent from known input.
// A per-call lexical fe avoids shared mutable time-machine context.
export function originalRecruitmentPreviews(present,offset,player,lookup){
 const fe={instance:()=>({getGameStateAtOffset:()=>offset,getGameStateAtPresent:()=>present})};
 const requested={current:null,next:null};let stage='current';
 class Ag{
 static getSpecialistsForHire(out,seat,number,seed){
  requested[stage]=number;const values=lookup(seat,number);
  if(values!==null&&values.length!==3)throw Error('Invalid preview recruitment draw');
  for(let i=0;i<3;i++)out.set(i,values===null?q.Invalid:values[i]);
 }
 ${methods('Ag',['getCurrentHireOptionsForPlayer','getNextHireOptionsForPlayer'])}
 }
 const current=new mr(3),next=new mr(3);
 Ag.getCurrentHireOptionsForPlayer(player,current);stage='next';Ag.getNextHireOptionsForPlayer(player,next);
 return{current:current.elements,next:next.elements,requested};
}
export function originalHireSeed(category,seed,player){return ut.generateDeterministicDrawSeed(category,seed,player)>>>0;}
export {p0 as OriginalRecruitmentRandom};
`;
const path='packages/engine/src/original-recruitment.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Recruitment extraction differs from APK');console.log('Recruitment excerpts match locked APK.');}else fs.writeFileSync(path,code);
