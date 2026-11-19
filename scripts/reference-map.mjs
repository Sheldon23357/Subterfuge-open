import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {readReference} from './reference-functions.mjs';

/** Independent extraction from the APK, never from the generated implementation.
 * Only reviewed numerical methods run. Queen insertion records location without world effects.
 * World allocation omits unused submarine/cache storage; no network or bundle initialization.
 */
export async function referenceBestMap(players, seed) {
  if (!Number.isInteger(players) || players < 2 || players > 10 || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff - 499) throw Error('Invalid reference input');
  const ref = readReference();
  const node = name => {
    const result = ref.tree.statements.find(n => n.name?.text === name);
    if (!result) throw Error(`Missing reference ${name}`);
    return result;
  };
  const methods = (name, names) => node(name).members.filter(m => names.includes(m.name?.getText(ref.tree)) || (name === 'G' && ts.isConstructorDeclaration(m))).map(m => m.getText(ref.tree)).join('\n');
  const extracted = ['I3','p0','an','ct','lPe','mr','b2','AX','R2e','O2e','B2e','xne','L2e','D2e','N2e','yX','wne','V2e','G2e','_a'].map(n => node(n).getText(ref.tree)).join('\n');
  // UI yielding escapes vm's synchronous timeout. Remove only that scheduling
  // boundary; retain the extracted candidate loop and its numerical methods.
  const code=extracted.replace('static async createBestWorldStartingAtSeed','static createBestWorldStartingAtSeed').replace('await this.breakLoopToUpdateUI(0), ','');
  if(code===extracted||code.includes('await this.breakLoopToUpdateUI'))throw Error('Reference map scheduling boundary changed');
  const geometry = methods('V', ['getUnwrappedPosWithDimensions','getUnwrappedPos','getWrappedPos2','getWrappedPos','getMinDist']);
  const vector = methods('G', ['clone','set','add','subtract','length']);
  const rules = fs.readFileSync('research/analysis/rules-current-4300.json','utf8');
  const program = `
    // Lexical references avoid a context-global lookup on every distance step.
    // These are the same realm builtins; numerical operations remain unchanged.
    const Math=globalThis.Math,Number=globalThis.Number,Array=globalThis.Array;
    const RULES=${rules},he=RULES.GameParams,Vn=RULES.OutpostParams;
    const K={MaxPlayerCount:10,MaxOutpostCount:100,OutpostsPerPlayer:10,MinutesPerTick:10,MaxSpecialistsPerLocation:128};
    const pe={Mine:0,Factory:1,Generator:2,Destroyed:3},q={Queen:'Queen'},B={Outpost:1};
    const P2e=200,gX=3,M2e=.33,MPe=32767,Zn=999999974e-13,ta=340282347e30;
    const Z=c=>{if(!c)throw Error('Reference assertion')},Xte=Z;
    const So=n=>Number.isInteger(n)?n>>31|1:UPe(n,1,-1),UPe=(n,e,t)=>n>=0?e:t;
    class Hc{}; class G extends Hc{${vector}}
    class we{constructor(type,index){this.type=type;this.index=index;}}
    const na=new G();
    class V{${geometry}
      static addSpecialistCommitted(w,type,owner,location){w.queens.push({type,owner,outpost:location.index});}
    }
    ${code}
    class Y0{constructor(){this.width=0;this.height=0;this.queens=[];this.outposts=new an(K.MaxOutpostCount);this.outposts.elements=this.outposts.elements.fill(null).map(()=>new b2());this.playerOrigins=Array.from({length:K.MaxPlayerCount},()=>new G(0,0));}}
    const setTimeout=fn=>fn();
    (()=>{
      const state={}; const seed=_a.createBestWorldStartingAtSeed(state,${players},${seed},30,60);
      const w=state.world;
      return JSON.stringify({seed,map:{score:wne(w,${players}),width:w.width,height:w.height,origins:w.playerOrigins.slice(0,${players}).map(p=>({x:p.x,y:p.y})),queens:w.queens,outposts:w.outposts.elements.slice(0,w.outposts.count).map(p=>({position:{x:p.pos.x,y:p.pos.y},owner:p.ownerIndex,type:p.private_type,drillers:p.drillers,shield:p.shieldCharge,shieldMax:p.shieldMaxCharge,productionProgress:p.ticksSinceLastDrillerProduction,meantForPlayer:p.meantForPlayer,nameIndex:p.nameIndex}))}});
    })();`;
  const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  return JSON.parse(await new vm.Script(program).runInContext(context,{timeout:15000}));
}
