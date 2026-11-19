/** Command countdowns in APK4300 truncate secondsSinceLastTick to whole seconds. */
export function commandSeconds(seconds:number,previous=0):number{
  if(!Number.isInteger(seconds)||seconds<0||seconds>=600||seconds<previous)throw new RangeError('Invalid command seconds');
  return seconds;
}

/** Current ordinary countdowns use whole command seconds and strict completion boundaries. */
export const commandTime={
 shieldRemaining:(o:{secsUntilShieldDisable:number},seconds:number)=>Math.max(o.secsUntilShieldDisable-Math.trunc(seconds),0),
 mining:(o:{private_secsUntilMineCreation:number},seconds:number)=>o.private_secsUntilMineCreation===0?false:Math.max(o.private_secsUntilMineCreation-Math.trunc(seconds),0),
 outpostType:(o:{private_type:number;private_secsUntilMineCreation:number},seconds:number)=>o.private_secsUntilMineCreation>0&&o.private_secsUntilMineCreation<Math.trunc(seconds)?0:o.private_type,
 launchRemaining:(f:{state:string;secsUntilLaunch:number},seconds:number)=>f.state==='waiting'?f.secsUntilLaunch-Math.trunc(seconds):0,
 gift:(f:{private_isGift:boolean;secsUntilGifting:number},seconds:number)=>f.private_isGift||f.secsUntilGifting>0&&f.secsUntilGifting<Math.trunc(seconds),
 gifting:(f:{secsUntilGifting:number},seconds:number)=>f.secsUntilGifting!==0&&Math.max(f.secsUntilGifting-Math.trunc(seconds),0)>0,
};

export function outpostTypeAtPhase<T extends 'mine'|'factory'|'generator'>(outpost:{type:T;minePending:boolean;mineSeconds?:number},seconds:number):T|'mine'{
 return outpost.minePending&&(outpost.mineSeconds??600)>0&&(outpost.mineSeconds??600)<Math.trunc(seconds)?'mine':outpost.type;
}
