import type {AttackRoutes,PlayerObservation} from '../../contracts/src/index.js';
import {basicRouteTicks} from './route-timing.js';
import {clientDistanceSquared,fleetSpeed,wrapClientPoint} from '../../engine/src/index.js';

/** Consumes ONLY the authenticated projection. No authority-state parameter. */
export function attackRoutes(observation:PlayerObservation,windows={attackTicks:108,localTicks:48,holdTicks:24}):AttackRoutes {
  if(!windows||Object.keys(windows).sort().join(',')!=='attackTicks,holdTicks,localTicks'||Object.values(windows).some(n=>!Number.isSafeInteger(n)||n<1||n>144))throw Error('Invalid local route windows');
  const v=observation.view,maxTicks=144;
  const postTicks:AttackRoutes['postTicks']={},fleetTicks:AttackRoutes['fleetTicks']={};
  const bounds=new Map<number,number>();
  const route=(from:{x:number;y:number},to:{x:number;y:number},ticks:number)=>{
    // Optimistic distance bound includes even launch-wait ticks, so it never
    // rejects a reachable route. Exact timings still use the movement engine.
    if(!bounds.has(ticks)){
      let distance=0;for(let i=1;i<=ticks;i++)distance+=fleetSpeed(v.tick+i)*10;
      bounds.set(ticks,(distance+0.001)**2);
    }
    if(clientDistanceSquared(wrapClientPoint(from,v.size),wrapClientPoint(to,v.size),v.size)>bounds.get(ticks)!)return null;
    return basicRouteTicks(from,to,v.size,v.tick,ticks);
  };
  // First establish reachability from our territory. Only then compute support
  // routes into that frontier and defensive routes into our own territory.
  const own=v.outposts.filter(p=>p.owner===v.player&&!p.destroyed);
  const others=v.outposts.filter(p=>p.owner!==v.player&&!p.destroyed);
  const frontier=new Set<string>();
  // A remote attacker may be beyond our solo range, while a prospective
  // partner can reach its rear. Keep those outreach routes in the matrix too.
  const ownIds=new Set(own.map(p=>p.id));
  const attackers=new Set(v.fleets.filter(f=>f.owner!==v.player&&!f.gift&&f.destination?.kind==='outpost'&&ownIds.has(f.destination.id)).map(f=>f.owner));
  for(const p of others)if(p.owner!==null&&p.owner!==undefined&&attackers.has(p.owner))frontier.add(p.id);
  for(const from of own){
    const row:Record<string,number|null>={};postTicks[from.id]=row;
    for(const to of own.filter(p=>p.id!==from.id))row[to.id]=route(from.position,to.position,windows.attackTicks);
    for(const to of others){
      const ticks=route(from.position,to.position,windows.attackTicks);
      row[to.id]=ticks;if(ticks!==null)frontier.add(to.id);
    }
  }
  for(const from of others){
    const row:Record<string,number|null>={};postTicks[from.id]=row;
    for(const to of own)row[to.id]=route(from.position,to.position,windows.localTicks);
    for(const to of others.filter(p=>frontier.has(p.id)&&p.id!==from.id))
      row[to.id]=route(from.position,to.position,Math.min(maxTicks,windows.attackTicks+windows.holdTicks));
  }
  // Only the existing destination is considered; screening never invents a
  // course change for a fleet which may be unable to turn.
  for(const f of v.fleets){
    const target=f.destination?.kind==='outpost'?v.outposts.find(o=>o.id===f.destination!.id):undefined;
    if(!target)continue;
    const wait=f.state==='moving'?-1:f.state==='waiting'?(f.secondsUntilLaunch??f.launchRemainingSeconds??600):null;
    fleetTicks[f.id]=wait===null?null:basicRouteTicks(f.position,target.position,v.size,v.tick,maxTicks,wait);
  }
  return {roomId:observation.roomId,revision:observation.revision,observedTick:v.tick,maxTicks,postTicks,fleetTicks,basis:'ordinary-speed-public-geometry'};
}
