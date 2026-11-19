import fs from 'node:fs';
import ts from 'typescript';
import {readReference} from './reference-functions.mjs';
import {ordinaryMapSource} from './ordinary-map-adapter.mjs';
const ref=readReference();
const names=['I3','p0','b2','AX','R2e','O2e','B2e','xne','L2e','D2e','N2e','yX','wne','V2e','G2e'];
const pieces=names.map(name=>{const n=ref.tree.statements.find(n=>n.name?.text===name);if(!n)throw Error(name);return n.getText(ref.tree)});
const v=ref.tree.statements.find(n=>ts.isClassDeclaration(n)&&n.name.text==='V');
const geo=['getUnwrappedPosWithDimensions','getUnwrappedPos','getWrappedPos2','getWrappedPos','getMinDist'].map(name=>v.members.find(m=>m.name?.getText(ref.tree)===name).getText(ref.tree));
const header=`// @ts-nocheck
// Reviewed, verbatim APK 12075 excerpts. Regenerate with scripts/extract-map.mjs.
// SHA256 ${ref.sha}. No bundle initialization, UI, network or dynamic code execution.
import {RULES} from '../../rules/src/reference-profile.js';
const he=RULES.GameParams,Vn=RULES.OutpostParams;
const K={MaxPlayerCount:10,MaxOutpostCount:100,OutpostsPerPlayer:10,MinutesPerTick:10,MaxSpecialistsPerLocation:128};
const pe={Mine:0,Factory:1,Generator:2,Destroyed:3},q={Queen:'Queen'},B={Outpost:1};
const P2e=200,gX=3,M2e=.33,MPe=32767,Zn=999999974e-13,ta=340282347e30;
const Z=(v)=>{if(!v)throw Error('Original map assertion');},Xte=Z;
const So=n=>Number.isInteger(n)?n>>31|1:n>=0?1:-1;
class G{constructor(x=0,y=0){this.x=x;this.y=y;}set(x,y){if(typeof x==='object'){this.x=x.x;this.y=x.y;}else{this.x=x;this.y=y;}return this;}clone(){return new G(this.x,this.y)}add(p){this.x+=p.x;this.y+=p.y;return this;}length(){return Math.sqrt(this.x*this.x+this.y*this.y);}static add(e,t,r){e.x=t.x+r.x;e.y=t.y+r.y;return e;}static subtract(e,t,r){e.x=t.x-r.x;e.y=t.y-r.y;return e;}}
class an{constructor(n){this.count=0;this.elements=new Array(n);}get(i){return this.elements[i];}}
class mr{constructor(n){this.elements=new Array(n);}}
const ct={add(a,p){a.elements[a.count++]=p;}};
class we{constructor(type,index){this.type=type;this.index=index;}}
const na=new G();
class V{${geo.join('\n')}
static addSpecialistCommitted(w,type,owner,location){w.queens.push({type,owner,outpost:location.index});}
}
`;
const footer=`
export function originalCandidate(players,seed,min=30,max=60){
 const w={width:0,height:0,outposts:new an(100),playerOrigins:Array.from({length:10},()=>new G()),queens:[]};
 w.outposts.elements=Array.from({length:100},()=>new b2());
 const rng=new p0();rng.setSeed(seed);
 const score=V2e(w,players,rng,min,max);
 return {valid:score<=3&&G2e(w,players),score,width:w.width,height:w.height,origins:w.playerOrigins.slice(0,players).map(p=>({x:p.x,y:p.y})),queens:w.queens,outposts:w.outposts.elements.slice(0,w.outposts.count).map(p=>({position:{x:p.pos.x,y:p.pos.y},owner:p.ownerIndex,type:p.private_type,drillers:p.drillers,shield:p.shieldCharge,shieldMax:p.shieldMaxCharge,productionProgress:p.ticksSinceLastDrillerProduction,meantForPlayer:p.meantForPlayer,nameIndex:p.nameIndex}))};
}
`;
const output=header+pieces.join('\n\n')+footer;
const file='packages/engine/src/original-map.generated.ts';
const normalized=text=>text.replaceAll('\r\n','\n');
if(process.argv.includes('--check')){if(normalized(fs.readFileSync(file,'utf8'))!==normalized(output))throw Error('Map extraction differs from reviewed source');console.log('Map excerpts match locked APK source.');}else fs.writeFileSync(file,output);
const ordinaryFile='packages/engine/src/ordinary-map.generated.ts',ordinary=ordinaryMapSource(output);
if(process.argv.includes('--check')){if(normalized(fs.readFileSync(ordinaryFile,'utf8'))!==normalized(ordinary))throw Error('Ordinary map adaptation differs from its generator');}
else fs.writeFileSync(ordinaryFile,ordinary);
