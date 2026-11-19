import fs from 'node:fs';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const fn=name=>{const node=ref.tree.statements.find(n=>n.name?.text===name);if(!node)throw Error(name);return node.getText(ref.tree);};
const method=(owner,name)=>{
  const cls=ref.tree.statements.find(n=>n.name?.text===owner);
  const m=cls?.members.find(n=>n.name?.getText(ref.tree)===name);
  if(!m)throw Error(`${owner}.${name}`);return m.getText(ref.tree);
};
const code=`// @ts-nocheck
// Verbatim APK12075 authoritative future queue. Do not format. SHA256 ${ref.sha}
// Regenerate: node scripts/extract-scheduling.mjs
import {RULES} from '../../rules/src/index.js';
const he=RULES.GameParams,fe={instance:()=>null},Re={LaunchSub:2},K={MaxSubsPerPlayer:128};
const De={Resigned:2,AutoResigned:3,Eliminated:4};
class te{${method('te','teamOf')} ${method('te','isAlly')}}
class Gg{${method('Gg','isSameFutureSubLaunch')}}
${fn('F2e')}
class ut{${method('ut','findNextAvailableSubIndex')}}
class kr{static perform(action,state){return state.perform(action);}
${method('kr','reserveSubIndex')}
${method('kr','cancelFutureAction')}}
export const originalNextFleetSlot=(state,player)=>ut.findNextAvailableSubIndex(state,player);
export const originalReserveFleetSlot=(state,player)=>kr.reserveSubIndex(state,player);
export const originalSameFutureLaunch=Gg.isSameFutureSubLaunch;
export const originalCancelFutureAction=(state,actions,player,uid)=>kr.cancelFutureAction(state,{count:actions.length,actions},player,{uid});
class tr{${method('tr','applyFutureActionsIfAny')} ${method('tr','isFutureActionKnownToLocalPlayer')}}
export function originalFutureActionKnown(teamSize,viewer,issuer,seatState){return tr.isFutureActionKnownToLocalPlayer({info:{teamSize},youPlayerIndex:viewer,playerStates:{get:()=>({seatState})}},{playerIndex:issuer});}
export const originalSameTeam=(teamSize,a,b)=>te.isAlly({teamSize},a,b);
/** Authoritative only; player forecasts must supply their own filtered input. */
export function applyOriginalFutureQueue(actions,tick,perform){return tr.applyFutureActionsIfAny({count:actions.length,actions},{tickCount:tick,perform});}
`;
const path='packages/engine/src/original-scheduling.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Scheduling extraction differs from APK');console.log('Scheduling excerpt matches locked APK.');}
else fs.writeFileSync(path,code);
