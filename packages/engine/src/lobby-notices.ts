/** Lobby notices are independent of world units and combat rules. */
export function lifecycleNotices(kind:string,capacity:number,occupied:number,actor:number,secondsUntilGameInProgress=0){
 if(!['join','leave','starting','started'].includes(kind))throw Error('Invalid lifecycle notice');
 return Array.from({length:capacity},(_,player)=>({player,
  text:kind==='join'?`${player===actor?'You':actor} joined the game (${capacity-occupied} seats available)`:
   kind==='leave'?(player===actor?'':`${actor} left the game (${capacity-occupied} seats available)`):
   kind==='starting'?`All players have joined. Game will start in ${secondsUntilGameInProgress/3600} hours`:'Game has started!',
  notify:kind==='started',priority:kind==='starting'?1:0}));
}
