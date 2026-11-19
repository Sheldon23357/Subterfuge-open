/** Wall-clock round limits; independent of game ticks and provider-call timeout. */
export function decisionBudget(firstRound:boolean){
 const hardMs=firstRound?20*60_000:10*60_000;
 return {hardMs,yieldMs:hardMs-30_000,warnMs:hardMs-90_000};
}
