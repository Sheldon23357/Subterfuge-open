import {inheritFleetJournals} from '../../engine/src/index.js';
import type {LabRoom} from './planning.js';

/** Freeze only private, verified snapshots before sharing them with readers. */
export function freezeSnapshot<T>(value:T):T{
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  for(const item of Object.values(value))freezeSnapshot(item);
  Object.freeze(value);
 }
 return value;
}

/** Keep event-time facts attached when a caller needs a mutable working copy. */
export function inheritRoomJournals(source:LabRoom|undefined,target:LabRoom|undefined){
 if(source&&target)inheritFleetJournals(source.state,target.state);
}
