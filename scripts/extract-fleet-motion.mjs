import fs from 'node:fs';
import ts from 'typescript';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const node=name=>{const n=ref.tree.statements.find(n=>n.name?.text===name);if(!n)throw Error(name);return n;};
const vectorNames=['clone','copy','add','subtract','multiplyScalar','divide2f','length'];
const vector=node('G').members.filter(n=>ts.isConstructorDeclaration(n)||vectorNames.includes(n.name?.getText(ref.tree))).map(n=>n.getText(ref.tree)).join('\n');
const code=`// @ts-nocheck
// Exact APK12075 ZD/MH and vector methods. Do not format. SHA256 ${ref.sha}
import {RULES} from '../../rules/src/reference-profile.js';
import {CLIENT_EPSILON,unwrapClientPoint,wrapClientPoint} from './client-geometry.js';
const he=RULES.GameParams,Zn=CLIENT_EPSILON,K={MinutesPerTick:10};
const B={Outpost:1,Sub:2},He={Moving:'moving',Arriving:'arriving',Launching:'launching'};
const Z=c=>{if(!c)throw Error('Original movement assertion');};
class Hc{}
class G extends Hc{${vector}}
${node('fp').getText(ref.tree)}
const na=new G();
const vec=p=>new G(p.x,p.y);
const V={
 getSubCurrentPosToDest:w=>vec(w.pursuit?w.target:unwrapClientPoint(w.target,w.sub.pos,w)).subtract(w.sub.pos),
 getSubSpeed:w=>w.speed,
 getItemPosition:w=>vec(w.target),
 getUnwrappedPos:(w,p,anchor)=>vec(unwrapClientPoint(p,anchor,w)),
 getWrappedPos:(width,height,p)=>vec(wrapClientPoint(p,{width,height})),
};
${node('ZD').getText(ref.tree)}
${node('MH').getText(ref.tree)}
function context(f,target,size,speed,pursuit){
 const sub={used:true,pos:vec(f.position),prevPos:vec(f.previous),state:f.state,fractionMoved:f.fractionMoved,
 trueDestPos:new G(),lastSunkAt:new G(),destination:{type:pursuit?B.Sub:B.Outpost}};
 return {...size,target,speed,pursuit,sub,subs:{get:()=>sub}};
}
export function originalMoveFleet(f,target,size,speed,fraction,pursuit){
 const w=context(f,target,size,speed,pursuit);ZD(w,0,fraction);
 f.position={x:w.sub.pos.x,y:w.sub.pos.y};f.state=w.sub.state;f.fractionMoved=w.sub.fractionMoved;
}
export function originalFleetSegment(f,target,anchor,size,speed,pursuit=false){
 const w=context(f,target,size,speed,pursuit),segment=MH(w,0,anchor);
 return {a:{x:segment.a.x,y:segment.a.y},b:{x:segment.b.x,y:segment.b.y}};
}
`;
const path='packages/engine/src/original-fleet-motion.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Fleet motion differs from APK');}else fs.writeFileSync(path,code);
