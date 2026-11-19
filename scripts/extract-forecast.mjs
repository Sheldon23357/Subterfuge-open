import fs from 'node:fs';
import ts from 'typescript';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const cls=name=>ref.tree.statements.find(n=>n.name?.text===name);
const method=(owner,name)=>{const m=cls(owner)?.members.find(m=>m.name?.getText(ref.tree)===name);if(!m)throw Error(owner+'.'+name);return m;};
const arrival=method('V','handleSubArrival');
const branch=arrival.body.statements.find(n=>ts.isIfStatement(n)&&n.expression.getText(ref.tree).includes('o.futureUnknown'));
if(!branch)throw Error('Unknown arrival branch missing');
const code=`// @ts-nocheck
// Exact APK 12075 forecast excerpts. Do not format. Source SHA256 ${ref.sha}.
import {SPECIALISTS} from '../../rules/src/reference.js';
const B={Nothing:0,Outpost:1,Sub:2},rt={Unknown:0,Known:1,Visible:2};
const mh={Promoted:'promoted'},q={IntelligenceOfficer:23};
q.IntelligenceOfficer=SPECIALISTS.find(p=>p.id==='IntelligenceOfficer').client_type_id;
const kt=Object.fromEntries(SPECIALISTS.map(p=>[p.client_type_id,{category:p.category}]));
const Z=c=>{if(!c)throw Error('Original forecast assertion');};
class we{constructor(type=0,index=-1){this.type=type;this.index=index;}}
const wn={getVisibility:(e,l,w)=>e(l,w)};
const V={
 isSpecialistCaptive:(w,i)=>w.isSpecialistCaptive(i),
 destroySpecialist:(w,i)=>w.destroySpecialist(i),
 destroySub:(n,i)=>n.world.destroySub(i),
};
const wm=(w,i,l,gift)=>w.transferSpecialists(i,l,gift);
class Forecast{${method('ZOe','removeAllNonVisibleItems').getText(ref.tree)}}
export function originalPruneForecast(state,visibility){
 const f=Object.create(Forecast.prototype);f.workingState=state;
 f.removedFreeSpecialistCount=Array.from({length:state.info.maxPlayerCount},()=>Array(31).fill(0));
 f.removeAllNonVisibleItems(visibility);return f.removedFreeSpecialistCount;
}
export function originalUnknownArrival(e,t){
 const s=e.world,i=s.subs.get(t),a=i.destination.index,o=s.outposts.get(a);
 ${branch.getText(ref.tree)}
}
`;
const path='packages/engine/src/original-forecast.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Forecast differs from APK');}else fs.writeFileSync(path,code);
