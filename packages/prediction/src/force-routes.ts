import type {PlayerObservation} from '../../contracts/src/index.js';
import {basicRouteTicks} from './route-timing.js';

/** Ordinary authorized movement only. A route estimate never invents new
 * destinations, encounters or future ownership. */
export function knownForceRouteEstimator(o:PlayerObservation){
 const v=o.view,cache=new Map<string,number|null>();
 return {
  post(source:string,destination:string,maxTicks=144):number|null {
   const from=v.outposts.find(p=>p.id===source),to=v.outposts.find(p=>p.id===destination);
   if(!from||!to||from.owner==null||from.visibility!==2||from.destroyed)return null;
   return basicRouteTicks(from.position,to.position,v.size,v.tick,maxTicks);
  },
  fleet(id:string,maxTicks=144):number|null {
   const key=id+':'+maxTicks;if(cache.has(key))return cache.get(key)!;
   const f=v.fleets.find(f=>f.id===id),target=v.outposts.find(p=>p.id===f?.destination?.id);
   if(!f||!target)return null;
   const wait=f.state==='moving'?-1:f.state==='waiting'?(f.secondsUntilLaunch??f.launchRemainingSeconds??600):f.state==='arriving'?0:null;
   const time=f.state==='arriving'?0:wait===null?null:basicRouteTicks(f.position,target.position,v.size,v.tick,maxTicks,wait);cache.set(key,time);return time;
  },
 };
}
