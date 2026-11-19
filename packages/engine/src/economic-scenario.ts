import {commandSeconds,outpostTypeAtPhase} from './command-time.js';
import {commandTime} from './command-time.js';
import {PROFILE_ID,RULES,shieldRechargeStep} from '../../rules/src/index.js';
import {integer} from './numeric.js';
import {factoryPeriodTicks,mineCreationCost,minePeriodTicks,productionAmount,startSpeedFactor} from './economy.js';

/** A boundary-tick research scenario, deliberately NOT the complete game/save schema.
 * No fleets; commands can only be issued at tick boundaries.
 * This isolates the original p3e economic phase for differential verification.
 */
export interface EconomicPlayer { neptunium:number; active:boolean; minesCreated:number }
export interface EconomicOutpost {
  /** Transient prediction marker; never accepted in initial authoritative setup. */
  futureUnknown?:boolean;
  mineSeconds?:number;shieldDisableSeconds?:number;
  destroyed?:boolean;
  id:string; owner:number|null; type:'factory'|'generator'|'mine'; drillers:number;
  shield:number; shieldMax:number; shieldsEnabled:boolean;
  productionProgress:number; miningProgress:number; shieldProgress:number;
  minePending:boolean; shieldDisablePending:boolean;
}
export interface EconomicSetup {
  players:EconomicPlayer[]; outposts:EconomicOutpost[]; teamSize:number; initialTick:number;
}
export type EconomicAction =
  |{kind:'toggle-mine';outpostId:string}
  |{kind:'set-shields';outpostId:string;enabled:boolean}
  |{kind:'toggle-funding';recipient:number};
export interface EconomicCommand {id:string;player:number;action:EconomicAction}
export interface EconomicEvent {sequence:number;tick:number;kind:string;subject:string;amount:number}
export interface EconomicRecord extends EconomicCommand {tick:number;seconds?:number}
export interface EconomicScenario {
  secondsSinceLastTick?:number;
  format:'economic-scenario/1';profile:typeof PROFILE_ID;initial:EconomicSetup;tick:number;
  players:EconomicPlayer[];outposts:EconomicOutpost[];funding:boolean[][];
  commands:EconomicRecord[];events:EconomicEvent[];
}
const clone=<T>(value:T):T=>structuredClone(value);
const MAX_TICKS=10000;
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Expected object');
  return value as Record<string,unknown>;
}
function exact(value:Record<string,unknown>,keys:string[]):void {
  if(Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!(key in value)))throw new TypeError('Unexpected or missing fields');
}
function count(value:unknown,name:string,max=1e9):asserts value is number{
  if(typeof value!=='number')throw new TypeError(name);
  integer(value,name);if(value>max)throw new RangeError(name);
}
function progress(value:unknown):asserts value is number{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1e9)throw new RangeError('Invalid progress');
}
function boolean(value:unknown):asserts value is boolean {if(typeof value!=='boolean')throw new TypeError('Expected boolean');}
function identifier(value:unknown):asserts value is string {if(typeof value!=='string'||!value.length||value.length>128)throw new TypeError('Invalid identifier');}
function validateSetup(input:unknown):asserts input is EconomicSetup {
  const setup=object(input);exact(setup,['players','outposts','teamSize','initialTick']);
  if(!Array.isArray(setup.players)||setup.players.length<2||setup.players.length>10)throw new RangeError('2–10 players required');
  if(!Array.isArray(setup.outposts)||setup.outposts.length<1||setup.outposts.length>100)throw new RangeError('1–100 outposts required');
  count(setup.teamSize,'teamSize',setup.players.length);count(setup.initialTick,'initialTick',1e7);
  for(const raw of setup.players){const p=object(raw);exact(p,['neptunium','active','minesCreated']);count(p.neptunium,'neptunium');count(p.minesCreated,'minesCreated');boolean(p.active);}
  const ids=new Set<string>();
  for(const raw of setup.outposts){
    const o=object(raw);exact(o,['id','owner','type','drillers','shield','shieldMax','shieldsEnabled','productionProgress','miningProgress','shieldProgress','minePending','shieldDisablePending',...(Object.hasOwn(o,'destroyed')?['destroyed']:[])]);
    if(Object.hasOwn(o,'destroyed'))boolean(o.destroyed);
    identifier(o.id);if(ids.has(o.id))throw new Error('Duplicate outpost id');ids.add(o.id);
    if(o.owner!==null)count(o.owner,'owner',setup.players.length-1);
    if(typeof o.type!=='string'||!['factory','generator','mine'].includes(o.type))throw new TypeError('Unsupported outpost type');
    for(const key of ['drillers','shield','shieldMax'])count(o[key],key);
    for(const key of ['productionProgress','miningProgress','shieldProgress'])progress(o[key]);
    for(const key of ['shieldsEnabled','minePending','shieldDisablePending'])boolean(o[key]);
    if(o.minePending||o.shieldDisablePending)throw new Error('Initial pending commands must be represented in the command log');
  }
}
function validateCommandShape(raw:unknown):asserts raw is EconomicCommand{
  const c=object(raw);exact(c,['id','player','action']);identifier(c.id);count(c.player,'player',9);
  const a=object(c.action);
  switch(a.kind){
    case 'toggle-mine':exact(a,['kind','outpostId']);identifier(a.outpostId);break;
    case 'set-shields':exact(a,['kind','outpostId','enabled']);identifier(a.outpostId);boolean(a.enabled);break;
    case 'toggle-funding':exact(a,['kind','recipient']);count(a.recipient,'recipient',9);break;
    default:throw new Error('Unsupported scenario action');
  }
}
export function createEconomicScenario(setup:EconomicSetup):EconomicScenario{
  validateSetup(setup);
  return{format:'economic-scenario/1',profile:PROFILE_ID,initial:clone(setup),tick:setup.initialTick,
    players:clone(setup.players),outposts:clone(setup.outposts),funding:setup.players.map(()=>setup.players.map(()=>false)),commands:[],events:[]};
}
function emit(s:EconomicScenario,kind:string,subject:string,amount=0){s.events.push({sequence:s.events.length,tick:s.tick,kind,subject,amount});}
function team(s:EconomicScenario,player:number){return s.initial.teamSize>0?Math.floor(player/s.initial.teamSize):player;}
function members(s:EconomicScenario,player:number){return s.players.map((_,i)=>i).filter(i=>team(s,i)===team(s,player));}
function miningPending(s:EconomicScenario,o:EconomicOutpost){return !!commandTime.mining({private_secsUntilMineCreation:o.minePending?(o.mineSeconds??600):0},s.secondsSinceLastTick??0);}
export function economicMineCreationCost(s:EconomicScenario,player:number){
  const seats=members(s,player);
  return mineCreationCost(seats.reduce((n,i)=>n+s.players[i]!.minesCreated,0),s.outposts.some(o=>o.owner!==null&&seats.includes(o.owner)&&miningPending(s,o)));
}
function finishMine(s:EconomicScenario,o:EconomicOutpost){
  o.type='mine';o.productionProgress=0;o.miningProgress=0;o.minePending=false;delete o.mineSeconds;
  if(o.owner!==null)s.players[o.owner]!.minesCreated++;
  emit(s,'mine-created',o.id);
}
function canFund(s:EconomicScenario,from:number,to:number){
  return from!==to&&!!s.players[from]?.active&&!!s.players[to]?.active&&s.players[from]!.neptunium>=s.players[to]!.neptunium+RULES.GameParams.NeptuniumLeadRequiredForFunding;
}
/** Returns a new state. Rejection never mutates the input; duplicate IDs cannot execute twice. */
export function submitEconomicCommand(state:EconomicScenario,command:EconomicCommand,seconds=state.secondsSinceLastTick??0):{state:EconomicScenario;duplicate:boolean}{
  validateCommandShape(command);
  const normalize=(a:EconomicAction):EconomicAction=>a.kind==='toggle-funding'?{kind:a.kind,recipient:a.recipient}:a.kind==='toggle-mine'?{kind:a.kind,outpostId:a.outpostId}:{kind:a.kind,outpostId:a.outpostId,enabled:a.enabled};
  const canonical={id:command.id,player:command.player,action:normalize(command.action)},prior=state.commands.find(c=>c.id===command.id);
  if(prior){
    if(prior.player!==command.player||JSON.stringify(normalize(prior.action))!==JSON.stringify(canonical.action))throw new Error('Command id conflict');
    return{state,duplicate:true};
  }
  if(!state.players[command.player]?.active)throw new Error('Inactive or unknown player');
  commandSeconds(seconds,state.secondsSinceLastTick??0);
  const next=clone(state),a=canonical.action;if(seconds>0)next.secondsSinceLastTick=seconds;
  if(a.kind==='toggle-funding'){
    if(!next.players[a.recipient]||a.recipient===command.player)throw new Error('Invalid funding recipient');
    const row=next.funding[command.player]!;
    if(!row[a.recipient]&&!canFund(next,command.player,a.recipient))throw new Error('Funding lead is insufficient');
    row[a.recipient]=!row[a.recipient];emit(next,'funding-toggled',`${command.player}:${a.recipient}`,Number(row[a.recipient]));
  }else{
    const o=next.outposts.find(o=>o.id===a.outpostId);
    if(!o||o.owner!==command.player)throw new Error('Outpost not owned by issuer');
    if(a.kind==='set-shields'){
      const remaining=commandTime.shieldRemaining({secsUntilShieldDisable:o.shieldDisablePending?(o.shieldDisableSeconds??600):0},seconds);
      if(a.enabled){if(o.shieldsEnabled&&remaining===0)throw new Error('Shields already enabled');o.shieldsEnabled=true;o.shieldDisablePending=false;delete o.shieldDisableSeconds;}
      else{if(!o.shieldsEnabled||remaining>0)throw new Error('Shields already disabled or pending');o.shieldDisablePending=true;if(seconds>0)o.shieldDisableSeconds=600+seconds;else delete o.shieldDisableSeconds;}
      emit(next,'shield-order',o.id,Number(a.enabled));
    }else{
      if(o.destroyed)throw new Error('Destroyed outpost cannot become a mine');
      if(o.type==='mine')throw new Error('Already a mine');
      if(o.minePending&&!miningPending(next,o))throw new Error('Mine cancellation window expired');
      if(o.minePending){
        o.minePending=false;delete o.mineSeconds;
        // Original cancel branch clears the flag BEFORE asking for the current refund.
        const refund=economicMineCreationCost(next,command.player)-(next.outposts.some(x=>x.owner===command.player&&miningPending(next,x))?50:0);
        o.drillers+=refund;emit(next,'mine-cancelled',o.id,refund);
      }else{
        const price=economicMineCreationCost(next,command.player);
        if(o.drillers<price)throw new Error('Insufficient drillers');
        const seats=members(next,command.player);
        for(const other of next.outposts)if(other.owner!==null&&seats.includes(other.owner)&&miningPending(next,other))finishMine(next,other);
        o.drillers-=price;o.minePending=true;if(seconds>0)o.mineSeconds=600+seconds;emit(next,'mine-ordered',o.id,price);
      }
    }
  }
  next.commands.push({...canonical,tick:next.tick,...(seconds>0?{seconds}:{})});return{state:next,duplicate:false};
}
export function economicTotals(s:EconomicScenario,externalDrillers:readonly number[]=[],seconds=s.secondsSinceLastTick??0){
  return s.players.map((_,index)=>{
    const owned=s.outposts.filter(o=>o.owner===index);
    const funders=s.funding.filter(row=>row[index]).length;
    return{drillers:owned.reduce((sum,o)=>sum+o.drillers,externalDrillers[index]??0),outposts:owned.filter(o=>!o.destroyed).length,funders,
      capacity:RULES.GameParams.BaseElectricalOutput+owned.filter(o=>!o.destroyed&&outpostTypeAtPhase(o,seconds)==='generator').length*RULES.OutpostParams.GeneratorElectricalOutput+funders*RULES.GameParams.FundingElectricalOutputBonus};
  });
}
/** Run just the economics phase at exact tick boundaries; does not claim full-world update. */

function tickEconomy(s:EconomicScenario,externalDrillers:readonly number[]=[],deferPostprocess=false){
  delete s.secondsSinceLastTick;s.tick++;
  const cached=economicTotals(s,externalDrillers),speed=startSpeedFactor(s.tick);
  for(const o of s.outposts){
    if(o.destroyed)continue;
    const cache=o.owner===null?null:cached[o.owner]!;
    if(o.type==='factory'&&cache&&cache.drillers<cache.capacity){
      o.productionProgress+=speed;
      const period=factoryPeriodTicks();
      if(o.productionProgress>=period){
        const amount=productionAmount({funders:cache.funders,capacity:cache.capacity,currentDrillers:cache.drillers});
        o.drillers+=amount;cache.drillers+=amount;
        o.productionProgress=speed>1&&period>0?o.productionProgress%period:0;emit(s,'drillers-produced',o.id,amount);
      }
    }else if(o.type==='mine'&&cache&&s.players[o.owner!]!.active){
      o.miningProgress++;
      const period=minePeriodTicks(cache.outposts);
      if(o.miningProgress>=period){o.miningProgress-=period;s.players[o.owner!]!.neptunium++;emit(s,'neptunium-produced',o.id,1);}
    }
    if(o.shieldDisablePending){const remaining=(o.shieldDisableSeconds??600)-600;if(remaining<=0){o.shieldDisablePending=false;delete o.shieldDisableSeconds;o.shield=0;o.shieldsEnabled=false;emit(s,'shield-disabled',o.id);}else o.shieldDisableSeconds=remaining;}
    const maximum=o.shieldsEnabled?o.shieldMax:0;
    if(o.owner!==null&&o.shield<maximum){
      const next=shieldRechargeStep(o.shield,o.shieldProgress,maximum,speed);
      if(next.charge>o.shield)emit(s,'shield-recharged',o.id,1);
      o.shield=next.charge;o.shieldProgress=next.progress;
    }
    if(o.minePending){const remaining=(o.mineSeconds??600)-600;if(remaining<=0)finishMine(s,o);else o.mineSeconds=remaining;}
  }
  if(!deferPostprocess)finishEconomicTick(s);
}
/** Research-world integration: caller owns this mutable state and runs this after movement. */
export function finishEconomicTick(s:EconomicScenario):void{
  // World postprocess w3e clamps shields, then I3e validates funding after all economics.
  for(const o of s.outposts)o.shield=Math.min(o.shield,o.shieldsEnabled?o.shieldMax:0);
  for(let from=0;from<s.players.length;from++)for(let to=0;to<s.players.length;to++){
    if(s.funding[from]![to]&&!canFund(s,from,to)){s.funding[from]![to]=false;emit(s,'funding-expired',`${from}:${to}`);}
  }
}
/** Research-world integration: one economic phase, fleet drillers included in capacity.
 * Returns an owned copy; caller must finishEconomicTick after movement/combat.
 */
export function beginEconomicTick(state:EconomicScenario,externalDrillers:readonly number[]):EconomicScenario{
  return beginOwnedEconomicTick(clone(state),externalDrillers);
}
/** Fleet advancement already owns its outer cloned world. Advance that owned
 * economic phase without copying its accumulated history again on every tick.
 * Public immutable advancement continues to clone before calling this helper. */
export function beginOwnedEconomicTick(state:EconomicScenario,externalDrillers:readonly number[]):EconomicScenario{
  if(externalDrillers.length!==state.players.length)throw new RangeError('Fleet totals must match players');
  for(const value of externalDrillers)count(value,'fleet drillers');
  tickEconomy(state,externalDrillers,true);return state;
}
export function advanceEconomicScenario(state:EconomicScenario,targetTick:number):EconomicScenario{
  count(targetTick,'targetTick',1e7);
  if(targetTick<state.tick||targetTick-state.tick>MAX_TICKS)throw new RangeError('Invalid scenario horizon');
  const next=clone(state);while(next.tick<targetTick)tickEconomy(next);return next;
}
export interface EconomicReplay {format:'economic-replay/1';profile:typeof PROFILE_ID;initial:EconomicSetup;commands:EconomicRecord[];targetTick:number}
export function exportEconomicReplay(s:EconomicScenario):EconomicReplay{
  return{format:'economic-replay/1',profile:PROFILE_ID,initial:clone(s.initial),commands:clone(s.commands),targetTick:s.tick};
}
function advanceEconomicReplayTo(s:EconomicScenario,target:number):EconomicScenario{
  while(s.tick<target)s=advanceEconomicScenario(s,Math.min(target,s.tick+MAX_TICKS));return s;
}
export function replayEconomicScenario(input:unknown):EconomicScenario{
  const r=object(input);exact(r,['format','profile','initial','commands','targetTick']);
  if(r.format!=='economic-replay/1'||r.profile!==PROFILE_ID)throw new Error('Unsupported replay version or profile');
  validateSetup(r.initial);count(r.targetTick,'targetTick',1e7);
  if(!Array.isArray(r.commands)||r.commands.length>10000)throw new RangeError('Invalid command history');
  let state=createEconomicScenario(r.initial);
  if(r.targetTick<state.tick)throw new RangeError('Invalid replay horizon');
  for(const raw of r.commands){
    const record=object(raw);exact(record,['id','player','action','tick',...(Object.hasOwn(record,'seconds')?['seconds']:[])]);count(record.tick,'tick',r.targetTick);
    if(record.tick<state.tick)throw new Error('Commands must be chronological');
    const command={id:record.id,player:record.player,action:record.action};validateCommandShape(command);
    state=advanceEconomicReplayTo(state,record.tick);
    const result=submitEconomicCommand(state,command,record.seconds===undefined?0:commandSeconds(record.seconds as number));
    if(result.duplicate)throw new Error('Duplicate command in replay');state=result.state;
  }
  return advanceEconomicReplayTo(state,r.targetTick);
}
export function saveEconomicSnapshot(s:EconomicScenario):string{
  if(s.commands.length>10000)throw new RangeError('Portable snapshot command limit');
  const serialized=JSON.stringify({format:'economic-snapshot/1',replay:exportEconomicReplay(s),expected:s});
  if(serialized.length>20_000_000)throw new RangeError('Snapshot too large');
  return serialized;
}
export function restoreEconomicSnapshot(serialized:string):EconomicScenario{
  if(serialized.length>20_000_000)throw new RangeError('Snapshot too large');
  const envelope=object(JSON.parse(serialized));exact(envelope,['format','replay','expected']);
  if(envelope.format!=='economic-snapshot/1')throw new Error('Unsupported snapshot format');
  const restored=replayEconomicScenario(envelope.replay);
  if(JSON.stringify(restored)!==JSON.stringify(envelope.expected))throw new Error('Snapshot and replay disagree');
  return restored;
}
