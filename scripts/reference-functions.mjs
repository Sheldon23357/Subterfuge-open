import fs from 'node:fs';
import crypto from 'node:crypto';
import ts from 'typescript';
import vm from 'node:vm';

export const sourcePath = 'research/analysis/javascript/index-DgdyVR_2.js';
export function readReference() {
  const source = fs.readFileSync(sourcePath,'utf8');
  const manifest = JSON.parse(fs.readFileSync('docs/rules/data/build-manifest.json','utf8'));
  const sha = crypto.createHash('sha256').update(source).digest('hex');
  if (sha !== manifest.formatted_js_sha256) throw new Error('Reference bundle hash changed; re-audit before executing excerpts.');
  return { source, sha, tree:ts.createSourceFile(sourcePath,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS) };
}

const approved = new Set(['calculateTicksBetweenNpProductions','calculateTicksBetweenDrillerProductions']);
export function extractReferenceMethod(reference, name) {
  if (!approved.has(name)) throw new Error(`Method not reviewed for execution: ${name}`);
  const owner = reference.tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'V');
  const method = owner?.members.find(node => ts.isMethodDeclaration(node) && node.name?.getText(reference.tree) === name);
  if (!method?.body) throw new Error(`Missing V.${name}`);
  return { name, line:reference.tree.getLineAndCharacterOfPosition(method.getStart()).line+1,
    code:`function reference(${method.parameters.map(p=>p.getText(reference.tree)).join(',')}) ${method.body.getText(reference.tree)}` };
}

/** Runs only two reviewed AST-extracted numerical methods, never the bundle or its initialization.
 * VM is capability isolation for these reviewed expressions, not a sandbox for arbitrary JS.
 * Stubs and inputs are created inside the context; no process, require, fetch, host functions or timers.
 */
export function runReference(method, fixture) {
  const context = vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  const script = new vm.Script(`
    const fixture=${JSON.stringify(fixture)};
    const he={RulesVersion:4300}; const er=1; const K={TicksPerDay:144,MinutesPerTick:10};
    const Vn={MinutesBetweenDrillerProductions:480}; const $e={TycoonProductionRateBonusFactor:.5};
    const pe={Factory:0,Generator:1,Mine:2}; const q={Tycoon:0};
    const Z=(condition)=>{if(!condition) throw new Error('Reference assertion');};
    const qn={getType:()=>pe.Factory};
    const world={secondsSinceLastTick:0,outposts:{get:()=>({ownerIndex:0})},
      cachedValues:{get:()=>({outpostCountByType:[fixture.outposts??0,0,0],freeSpecialistCount:[fixture.tycoons??0]})}};
    ${method.code}; reference(world,0);`);
  return script.runInContext(context,{timeout:250});
}

export function runReferenceRecruitment(reference, fixtures) {
  const approvedNames=['p0','I3','I2e','T2e','pX','k3'];
  const snippets=approvedNames.map(name=>{
    const node=reference.tree.statements.find(n=>(ts.isClassDeclaration(n)||ts.isFunctionDeclaration(n))&&n.name?.text===name);
    if(!node) throw new Error(`Missing reviewed recruitment symbol ${name}`);
    return node.getText(reference.tree);
  });
  const specialists=JSON.parse(fs.readFileSync('docs/rules/data/specialists.json','utf8'));
  const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  const script=new vm.Script(`
    const data=${JSON.stringify(specialists)}; const fixtures=${JSON.stringify(fixtures)};
    const Z=c=>{if(!c)throw new Error('Reference assertion')};
    const he={RulesVersion:4300},q={COUNT:31,Invalid:0},DD=3,fne=2147483647,MPe=32767;
    const categories={attack:1,defense:2,other:3,promoted:4};
    const kt=Array.from({length:31},()=>({category:0}));
    for(const s of data)kt[s.client_type_id]={category:categories[s.category]};
    class an{constructor(){this.elements=[];this.count=0}get(i){return this.elements[i]}set(i,v){this.elements[i]=v}}
    const ct={add(a,v){a.elements[a.count++]=v}};
    const ut={generateDeterministicDrawSeed(e,t,r){return -1609100829^t^e<<4^r}};
    ${snippets.join('\n')}; const oI=new p0;
    fixtures.map(f=>[3,1,2].map(category=>k3(f.playerIndex,f.hireNumber-1,f.gameSeed,category)));
  `);
  return JSON.parse(JSON.stringify(script.runInContext(context,{timeout:3000})));
}

/** Full original p3e phase with no specialists/fleets, at exact tick boundaries.
 * Context adapters model array storage and caches; original production/mining/shield bodies execute unchanged.
 */
export function runReferenceEconomy(reference,setup,ticks,options={}) {
  const extract=name=>{
    const node=reference.tree.statements.find(n=>(ts.isClassDeclaration(n)||ts.isFunctionDeclaration(n))&&n.name?.text===name);
    if(!node)throw new Error(`Missing reviewed economic symbol ${name}`);
    return node.getText(reference.tree);
  };
  const owner=reference.tree.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V');
  const methodNames=['isElectricalCapKnown','calculateDrillersForNextProductionAtOutpost','calculateTicksBetweenDrillerProductions','calculateTicksBetweenNpProductions','canOutpostProduceDrillers','getStartSpeedupFactor','getStartSpeedupFactorValue','convertToMine'];
  const methods=methodNames.map(name=>{
    const node=owner.members.find(n=>ts.isMethodDeclaration(n)&&n.name?.getText(reference.tree)===name);
    if(!node?.body)throw new Error(`Missing economic V.${name}`);
    return `V.${name}=function(${node.parameters.map(p=>p.getText(reference.tree)).join(',')})${node.body.getText(reference.tree)};`;
  }).join('\n');
  const profile=JSON.parse(fs.readFileSync('docs/rules/data/profile-4300.json','utf8'));
  const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  return JSON.parse(JSON.stringify(new vm.Script(`
    const initial=${JSON.stringify(setup)},count=${JSON.stringify(ticks)},profile=${JSON.stringify(profile)},options=${JSON.stringify(options)};
    const he=profile.GameParams,$e=profile.SpecialistParams,Vn={...profile.OutpostParams,MineElectricalLoadPenalty:0};
    const K={SecondsPerTick:600,MinutesPerTick:10,TicksPerDay:144},er=1;
    const q={COUNT:31,Foreman:23,Tycoon:4,MinisterOfEnergy:9};
    const pe={Mine:0,Factory:1,Generator:2},B={Outpost:1},De={Occupied:1};
    const Z=c=>{if(!c)throw new Error('Reference assertion')};
    class mr{constructor(n){this.values=Array(n).fill(0)}get(i){return this.values[i]}set(i,v){this.values[i]=v}}
    class we{constructor(type,index){this.type=type;this.index=index}}
    const n3e=()=>0,o3e=()=>1;
    const wrap=values=>({count:values.length,get:i=>values[i]});
    const players=initial.players.map(p=>({seatState:p.active?De.Occupied:0,neptunium:p.neptunium,mineCreationCount:p.minesCreated}));
    const outposts=initial.outposts.map(o=>({ownerIndex:o.owner??-1,private_type:pe[o.type==='factory'?'Factory':o.type==='mine'?'Mine':'Generator'],drillers:o.drillers,
      shieldCharge:o.shield,shieldMaxCharge:o.shieldMax,shieldsEnabled:o.shieldsEnabled,
      ticksSinceLastDrillerProduction:o.productionProgress,ticksSinceLastNeptuniumProduction:o.miningProgress,ticksSinceLastShieldPower:o.shieldProgress,
      private_secsUntilMineCreation:o.minePending?600:0,secsUntilShieldDisable:o.shieldDisablePending?600:0,
      electricalOutput:o.type==='generator'?50:0}));
    const world={outposts:wrap(outposts),secondsSinceLastTick:0,tickCount:initial.initialTick,cachedValues:null};
    const state={world,playerStates:wrap(players),youPlayerIndex:options.forecastPlayer??0,listener:{handleDrillerProduction(){},handleNpProduction(){},handleCreateMine(){}}};
    const fe={instance:()=>({isSimulatedFuture:()=>options.forecastPlayer!==undefined})};
    const ut={countFundersForPlayer:()=>0};
    const V={getSpecialistCountByTypeAtLocation(){},isElectricalCapKnown:()=>true,
      getCurrentMaxShieldCharge:(w,i)=>w.outposts.get(i).shieldsEnabled?w.outposts.get(i).shieldMaxCharge:0};
    ${extract('qn')};${methods}
    ${['p3e','m3e','g3e','A3e'].map(extract).join('\n')}
    function refresh(){world.cachedValues=wrap(players.map((p,index)=>{
      const owned=outposts.filter(o=>o.ownerIndex===index),counts=[0,0,0];for(const o of owned)counts[o.private_type]++;
      return{drillers:owned.reduce((sum,o)=>sum+o.drillers,0),electricalOutput:150+owned.reduce((sum,o)=>sum+o.electricalOutput,0),
        freeSpecialistCount:Array(31).fill(0),outpostCountByType:counts};
    }));}
    refresh();const trace=[];
    for(let tick=0;tick<count;tick++){
      world.tickCount++;p3e(state);
      for(const o of outposts)o.shieldCharge=Math.min(o.shieldCharge,o.shieldsEnabled?o.shieldMaxCharge:0);
      refresh();trace.push({tick:world.tickCount,players:players.map(p=>({neptunium:p.neptunium,minesCreated:p.mineCreationCount})),
        outposts:outposts.map(o=>({type:o.private_type,drillers:o.drillers,shield:o.shieldCharge,
          productionProgress:o.ticksSinceLastDrillerProduction,miningProgress:o.ticksSinceLastNeptuniumProduction,shieldProgress:o.ticksSinceLastShieldPower}))});
    }
    trace;
  `).runInContext(context,{timeout:3000})));
}

export function runReferenceGeometry(reference,fixtures){
  const declaration=name=>{
    const node=reference.tree.statements.find(n=>(ts.isClassDeclaration(n)||ts.isFunctionDeclaration(n))&&n.name?.text===name);
    if(!node)throw new Error(`Missing reviewed geometry symbol ${name}`);return node.getText(reference.tree);
  };
  const owner=reference.tree.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V');
  const names=['getUnwrappedPosWithDimensions','getUnwrappedPos','getWrappedPos','getMinDist','getMinDistSquared'];
  const methods=names.map(name=>{
    const node=owner.members.find(n=>ts.isMethodDeclaration(n)&&n.name?.getText(reference.tree)===name);
    if(!node?.body)throw new Error(`Missing V.${name}`);
    return `V.${name}=function(${node.parameters.map(p=>p.getText(reference.tree)).join(',')})${node.body.getText(reference.tree)};`;
  }).join('\n');
  const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  return JSON.parse(JSON.stringify(new vm.Script(`
    const fixtures=${JSON.stringify(fixtures)},Zn=999999974e-13;
    const he={RulesVersion:4300},B={Outpost:1},So=n=>Number.isInteger(n)?n>>31|1:n>=0?1:-1;
    const Z=c=>{if(!c)throw new Error('Reference assertion')};
    class G{
      constructor(x=0,y=0){this.x=x;this.y=y}clone(){return new G(this.x,this.y)}
      add(v){this.x+=v.x;this.y+=v.y;return this}subtract(v){this.x-=v.x;this.y-=v.y;return this}
      divide2f(x,y){this.x/=x;this.y/=y;return this}multiplyScalar(v){this.x*=v;this.y*=v;return this}
      length(){return Math.sqrt(this.x*this.x+this.y*this.y)}lengthSqr(){return this.x*this.x+this.y*this.y}
      static add(out,a,b){out.x=a.x+b.x;out.y=a.y+b.y;return out}
      static subtract(out,a,b){out.x=a.x-b.x;out.y=a.y-b.y;return out}
      static dot(a,b){return a.x*b.x+a.y*b.y}
    }
    const na=new G,V={};${methods}
    ${declaration('Js')}
    class $G{constructor(){this.subIndex=0;this.tickFraction=0}}
    const ct={add:(array,value)=>array.push(value)};
    const MH=(world,index)=>world.segments[index];
    ${declaration('RH')}
    const vector=p=>new G(p.x,p.y),segment=s=>({a:vector(s.a),b:vector(s.b)});
    fixtures.map(f=>{
      if(f.kind==='distance')return{distance:V.getMinDist(f.size,vector(f.a),vector(f.b)),squared:V.getMinDistSquared(vector(f.a),vector(f.b),f.size.width,f.size.height),unwrapped:V.getUnwrappedPos(f.size,vector(f.a),vector(f.b))};
      if(f.kind==='wrap')return V.getWrappedPos(f.size.width,f.size.height,vector(f.point));
      const first=segment(f.a),second=segment(f.b),values=[];
      const subs=[{used:true,srcOutpostIndex:0,ownerIndex:0,pos:first.a,destination:{type:1,index:1}},{used:true,srcOutpostIndex:1,ownerIndex:1,pos:second.a,destination:{type:1,index:0},avoidCombatThisTick:false}];
      const world={subs:{get:i=>subs[i]},segments:[first,second],subLookup:{index:{get:()=>({start:0,count:1})},items:{get:()=>1}}};
      RH(world,0,1,0,values);
      return{intersect:Js.intersect(first,second),fraction:values[0]?.tickFraction??null};
    });
  `).runInContext(context,{timeout:3000})));
}

/** Reviewed mre/eF/ZD/MH for an outpost destination, no specialists and no invalid-target path.
 * This proves movement arithmetic/order, not combat, pursuit or command validation.
 */
export function runReferenceFleetMovement(reference,fixtures){
  const extract=name=>{
    const node=reference.tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
    if(!node)throw new Error(`Missing reviewed movement symbol ${name}`);return node.getText(reference.tree);
  };
  const owner=reference.tree.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V');
  const methods=['getUnwrappedPosWithDimensions','getUnwrappedPos','getWrappedPos'].map(name=>{
    const node=owner.members.find(n=>ts.isMethodDeclaration(n)&&n.name?.getText(reference.tree)===name);
    return `V.${name}=function(${node.parameters.map(p=>p.getText(reference.tree)).join(',')})${node.body.getText(reference.tree)};`;
  }).join('\n');
  const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  return JSON.parse(JSON.stringify(new vm.Script(`
    const fixtures=${JSON.stringify(fixtures)},Zn=999999974e-13,he={RulesVersion:4300};
    const K={SecondsPerTick:600,MinutesPerTick:10},B={Outpost:1},He={WaitingForLaunch:0,Launching:1,Moving:2,Arriving:3,WaitingForCourseChange:4};
    const So=n=>Number.isInteger(n)?n>>31|1:n>=0?1:-1,Z=c=>{if(!c)throw new Error('Reference assertion')};
    class G{
      constructor(x=0,y=0){this.x=x;this.y=y}clone(){return new G(this.x,this.y)}
      add(v){this.x+=v.x;this.y+=v.y;return this}subtract(v){this.x-=v.x;this.y-=v.y;return this}
      divide2f(x,y){this.x/=x;this.y/=y;return this}multiplyScalar(v){this.x*=v;this.y*=v;return this}
      length(){return Math.sqrt(this.x*this.x+this.y*this.y)}
      static copy(out,a){out.x=a.x;out.y=a.y;return out}
      static add(out,a,b){out.x=a.x+b.x;out.y=a.y+b.y;return out}
      static subtract(out,a,b){out.x=a.x-b.x;out.y=a.y-b.y;return out}
      static multiplyScalar(out,a,s){out.x=a.x*s;out.y=a.y*s;return out}
    }
    class fp{constructor(a,b){this.a=a;this.b=b}}
    const na=new G(),xg=()=>false,V={
      getSubCurrentPosToDest:(w,i)=>V.getUnwrappedPos(w,w.target,w.subs.get(i).pos).subtract(w.subs.get(i).pos),
      getSubSpeed:w=>0.004999999888*(w.tickCount<=72?1.5:1),isSubDestinationValid:()=>true,
      getItemPosition:w=>w.target.clone()
    };
    ${methods}
    ${['mre','eF','ZD','MH'].map(extract).join('\n')}
    const names=['waiting','launching','moving','arriving'];
    fixtures.map(f=>{
      const sub={used:true,pos:new G(f.position.x,f.position.y),prevPos:new G(f.position.x,f.position.y),
        trueDestPos:new G(),lastSunkAt:new G(),state:names.indexOf(f.state),secsUntilLaunch:f.secondsUntilLaunch,
        fractionMoved:0,destination:{type:1,index:0},specialistCache:{count:0},drillers:20};
      const w={...f.size,tickCount:f.initialTick,target:new G(f.target.x,f.target.y),subs:{get:()=>sub}};
      const n={world:w,listener:{handleSubDeparture(){}}},trace=[];
      const snap=()=>({position:{x:sub.pos.x,y:sub.pos.y},previous:{x:sub.prevPos.x,y:sub.prevPos.y},
        state:names[sub.state],secondsUntilLaunch:sub.secsUntilLaunch,fractionMoved:sub.fractionMoved});
      for(let step=0;step<f.ticks;step++){
        w.tickCount++;G.copy(sub.prevPos,sub.pos);mre(n,0);
        const prepared=snap(),segment=MH(w,0,sub.pos);eF(n,0);trace.push({prepared,segment,after:snap()});
      }
      return trace;
    });
  `).runInContext(context,{timeout:3000})));
}

/** Original r2e/a2e/lX, with local-only adapters. Scheduling uses the reviewed priority loop
 * and metadata; it is not independent verification of oX/world postprocessing. Martyr excluded.
 */
export function runReferenceSpecialistAbilities(reference,fixtures){
  const metadata=JSON.parse(fs.readFileSync('docs/rules/data/specialists.json','utf8'));
  const params=JSON.parse(fs.readFileSync('docs/rules/data/profile-4300.json','utf8')).SpecialistParams;
  const owner=reference.tree.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V');
  const ownership=owner.members.find(n=>n.name?.getText(reference.tree)==='changeSpecialistOwnership');
  if(!ownership)throw Error('Missing V.changeSpecialistOwnership');
  const extract=name=>{
    const node=reference.tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
    if(!node)throw new Error(`Missing reviewed specialist symbol ${name}`);return node.getText(reference.tree);
  };
  const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  return JSON.parse(JSON.stringify(new vm.Script(`
    const fixtures=${JSON.stringify(fixtures)},metadata=${JSON.stringify(metadata)},$e=${JSON.stringify(params)};
    const q=Object.fromEntries(metadata.map(p=>[p.id,p.client_type_id])),kt=[];
    for(const p of metadata)kt[p.client_type_id]={name:p.id,combatPriority:p.combat_priority,appliesWhenInvading:p.combat_participation_flags.invading,appliesWhenDefending:p.combat_participation_flags.defending,appliesInTransit:p.combat_participation_flags.transit};
    const he={RulesVersion:4300},B={Sub:1,Outpost:2},He={Moving:1},Z=c=>{if(!c)throw new Error('Reference assertion')};
    const wrap=a=>({count:a.length,get:i=>a[i]});
    const br=(e,n)=>e.world.subs.get(0),Rr=(e,n)=>e.world.subs.get(1),_s=(e,n)=>e.world.outposts.get(0);
    const other=(e,n)=>n.otherLocation.type===B.Outpost?_s(e,n):Rr(e,n);
    const Wa=(e,n)=>other(e,n).ownerIndex,Zo=(e,n)=>other(e,n).drillers,Ka=(e,n)=>other(e,n).specialistCache;
    const pne=(e,n)=>e.world.cachedValues.get(br(e,n).ownerIndex),mne=(e,n)=>e.world.cachedValues.get(Wa(e,n));
    const jG=(n,e,t,r)=>{const side=t?br(e,n):other(e,n);return e.world.specialists.get(side.specialistCache.get(r)).ownerIndex!==side.ownerIndex};
    const te={getScreenName:(info,i)=>String(i)};
    const V={isSpecialistCaptive:(w,i)=>{const p=w.specialists.get(i);return p.ownerIndex!==(p.location.type===B.Sub?w.subs.get(p.location.index):w.outposts.get(p.location.index)).ownerIndex},
      sendSubToNearestFriendlyOutpost:(w,i)=>w.subs.get(i).returned=true,
      changeSpecialistOwnership:function(${ownership.parameters.map(p=>p.getText(reference.tree)).join(',')})${ownership.body.getText(reference.tree)}};
    ${['lX','a2e','r2e'].map(extract).join('\n')}
    fixtures.map(f=>{
      const specs=[],make=(side,loc)=>{const list=[];for(const p of side.specialists){list.push(specs.length);specs.push({id:p.id,type:q[p.type],ownerIndex:p.owner,isDying:p.dead,location:loc});}return{ownerIndex:side.owner??-1,drillers:side.drillers,specialistCache:wrap(list),shieldCharge:f.shield,returned:false}};
      const a=make(f.attacker,{type:B.Sub,index:0}),d=make(f.defender,{type:f.isOutpost?B.Outpost:B.Sub,index:f.isOutpost?0:1});
      const caches=Object.fromEntries(Object.entries(f.globals).map(([i,counts])=>{const values=Array(31).fill(0);for(const p of metadata)values[p.client_type_id]=counts[p.id]??(p.id==='Queen'?[f.attacker,f.defender].flatMap(s=>s.specialists.filter(x=>!x.dead&&x.owner===s.owner&&x.owner===Number(i)&&x.type==='Queen')).length:0);return[i,{freeSpecialistCount:values}]}));
      const world={subs:wrap([a,d]),outposts:wrap([d]),specialists:wrap(specs),cachedValues:{get:i=>caches[i]}};
      const e={world,info:{},listener:{handleDoubleAgentActivated(){}}};
      const n={subIndex:0,otherLocation:{type:f.isOutpost?B.Outpost:B.Sub,index:f.isOutpost?0:1},subInitialOwner:a.ownerIndex,otherLocationInitialOwner:d.ownerIndex,outcome:0,combatText:'',combatTextMarker:0};
      n.subSpecialistParticipatesInCombat=a.specialistCache?Array.from({length:a.specialistCache.count},(_,i)=>lX(e,a.specialistCache.get(i),n.otherLocation)):[];
      n.otherLocationSpecialistParticipatesInCombat=Array.from({length:d.specialistCache.count},(_,i)=>lX(e,d.specialistCache.get(i),{type:B.Sub,index:0}));
      n.subHasElder=a.specialistCache.count>0&&Array.from({length:a.specialistCache.count},(_,i)=>i).some(i=>specs[a.specialistCache.get(i)].type===q.ReveredElder&&n.subSpecialistParticipatesInCombat[i]);
      n.otherLocationHasElder=Array.from({length:d.specialistCache.count},(_,i)=>i).some(i=>specs[d.specialistCache.get(i)].type===q.ReveredElder&&n.otherLocationSpecialistParticipatesInCombat[i]);
      for(let priority=2;priority<=8&&n.outcome!==4;priority++){
        const queue=[];for(const [side,flags,attacking] of [[a,n.subSpecialistParticipatesInCombat,true],[d,n.otherLocationSpecialistParticipatesInCombat,false]])for(let i=0;i<side.specialistCache.count;i++){
          const index=side.specialistCache.get(i),p=specs[index];if(!p.isDying&&flags[i]&&kt[p.type].combatPriority===priority)queue.push([index,attacking]);
        }
        for(const [index,attacking]of queue)r2e(n,e,attacking,index);
      }
      const summary=side=>({owner:side.ownerIndex<0?null:side.ownerIndex,drillers:side.drillers,specialists:Array.from({length:side.specialistCache.count},(_,i)=>{const p=specs[side.specialistCache.get(i)];return{id:p.id,type:kt[p.type].name,owner:p.ownerIndex,dead:p.isDying}})});
      return{attacker:summary(a),defender:summary(d),shield:f.isOutpost?d.shieldCharge:0,ended:n.outcome===4,returnAttacker:a.returned,returnDefender:d.returned};
    });
  `).runInContext(context,{timeout:3000})));
}

/** Original toroidal pursuit methods. Only the target speed/item lookup are adapters. */
export function runReferencePursuit(reference,fixtures){
  const owner=reference.tree.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V');
  const names=['getUnwrappedPosWithDimensions','getUnwrappedPos','getPursuitFallbackDir','calculateSubToTargetIntersection','getPosToTarget'];
  const methods=names.map(name=>{
    const node=owner.members.find(n=>ts.isMethodDeclaration(n)&&n.name?.getText(reference.tree)===name);
    if(!node?.body)throw new Error(`Missing reviewed pursuit method ${name}`);
    return `V.${name}=function(${node.parameters.map(p=>p.getText(reference.tree)).join(',')})${node.body.getText(reference.tree)};`;
  }).join('\n');
  const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  return JSON.parse(JSON.stringify(new vm.Script(`
    const fixtures=${JSON.stringify(fixtures)},Zn=999999974e-13,he={RulesVersion:4300},B={Nothing:0,Sub:1,Outpost:2},ta=3.402823466e38;
    const So=n=>Number.isInteger(n)?n>>31|1:n>=0?1:-1;
    class G{
      constructor(x=0,y=0){this.x=x;this.y=y}clone(){return new G(this.x,this.y)}
      set(x,y){this.x=x;this.y=y;return this}
      add(v){this.x+=v.x;this.y+=v.y;return this}subtract(v){this.x-=v.x;this.y-=v.y;return this}
      multiplyScalar(v){this.x*=v;this.y*=v;return this}lengthSqr(){return this.x*this.x+this.y*this.y}length(){return Math.sqrt(this.lengthSqr())}
      normalize(){let n=this.x*this.x+this.y*this.y;if(n>0){n=1/Math.sqrt(n);this.x*=n;this.y*=n}return this}
      static add(out,a,b){out.x=a.x+b.x;out.y=a.y+b.y;return out}
      static subtract(out,a,b){out.x=a.x-b.x;out.y=a.y-b.y;return out}
    }
    const na=new G(),s3e=new G(),pf=Array.from({length:4},()=>new G()),LS=Array.from({length:4},()=>new G());
    const V={getSubSpeed:w=>w.speed};${methods}
    const vec=p=>new G(p.x,p.y);
    fixtures.map(f=>{
      const target={used:f.target.used,prevPos:vec(f.target.previous),trueDestPos:vec(f.target.trueDestination),destination:{type:B.Outpost,index:0}};
      const world={...f.size,speed:f.target.speed,subs:{get:()=>target}};
      const result=V.getPosToTarget(world,vec(f.pursuer),f.speed,{type:B.Sub,index:0});return{x:result.x,y:result.y};
    });
  `).runInContext(context,{timeout:3000})));
}
