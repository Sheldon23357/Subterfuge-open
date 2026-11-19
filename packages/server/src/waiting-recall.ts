import {originalLobby,submitFleetOrder} from '../../engine/src/index.js';
import {createHash} from 'node:crypto';
import type {LabRoom} from './planning.js';
/** Run the original leave loop over real slot order. Waiting worlds cannot
 * advance ticks, so their launched vessels are still cancellable at source.
 * Use journaled commands so replay restores resources and allocation order.
 */
export function recallWaitingFleets(room:LabRoom,player:number,leaveId:string):LabRoom{
 if(room.clock||room.state.economy.tick!==0||(room.state.secondsSinceLastTick??0)!==0)throw Error('Expected frozen waiting world');
 let state=room.state;
 const fleets=state.fleets.filter(f=>f.used).sort((a,b)=>a.slot-b.slot);
 const bridge={status:1,info:{playerCount:1},playerStates:{get:()=>({seatState:1})},
  world:{subs:{count:fleets.length,get:(i:number)=>({used:state.fleets.find(f=>f.id===fleets[i]!.id)!.used,ownerIndex:fleets[i]!.owner})}},
  hooks:{cancelSub:(i:number)=>{
   const fleet=fleets[i]!;
   const id='lobby-leave-'+createHash('sha256').update(leaveId).digest('hex')+'-'+fleet.slot;
   state=submitFleetOrder(state,{id,player,action:{kind:'recall-waiting-fleet',fleetId:fleet.id}},0).state;
  }},listener:{handlePlayerLeft:()=>{}}};
 if(!originalLobby.leave(bridge,player))throw Error('Original leave recall rejected');
 return state===room.state?room:{...room,state};
}
