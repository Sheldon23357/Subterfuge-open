import {commandTime} from './command-time.js';

type Launch={state:string;secondsUntilLaunch:number;source:string|null;used?:boolean};
export function departureCommitted(f:Pick<Launch,'state'|'secondsUntilLaunch'>,seconds=0,deadlineLock=true){
  return f.state!=='waiting'||deadlineLock&&commandTime.launchRemaining({state:f.state,secsUntilLaunch:f.secondsUntilLaunch},seconds)<=0;
}
export function canCancelFleetLaunch(f:Launch,seconds=0,deadlineLock=true){
  return f.used!==false&&f.state==='waiting'&&f.source!==null&&!departureCommitted(f,seconds,deadlineLock);
}
