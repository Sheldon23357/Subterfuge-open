import type {FleetScenario,Fleet} from './fleet-scenario.js';
/** Unknown arrival records an unresolved outcome. It does not assert a capture
 * or defeat, and cannot trigger asset-loss elimination of the observing seat. */
export function arriveAtUnknownOutpost(s:FleetScenario,f:Fleet,fraction:number,destroy:()=>void){
 const post=s.economy.outposts.find(o=>o.id===f.destination)!;
 s.events.push({sequence:s.events.length,tick:s.economy.tick,fraction,kind:'future-unknown-arrival',subject:f.id,details:{outpost:post.id,owner:f.owner}});
 f.drillers=0;post.drillers=0;destroy();
}
