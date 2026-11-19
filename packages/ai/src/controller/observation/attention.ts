import type {PlayerObservation} from '../../../../contracts/src/index.js';

/** Actual fleets and accepted schedules only; prose plans do not reserve units. */
export function attentionTargets(o:PlayerObservation){
 const refs=new Map<string,string[]>();
 const add=(id:string,ref:string)=>refs.set(id,[...(refs.get(id)??[]),ref]);
 for(const f of o.view.fleets)if(f.owner===o.view.player&&!f.gift&&f.destination?.kind==='outpost')add(f.destination.id,f.id);
 for(const plan of o.scheduled){
   const a=plan.action;
   if(plan.status==='pending'&&plan.player===o.view.player&&plan.issueTick<=o.view.tick+144&&a.kind==='launch'&&a.destinationKind!=='fleet'&&typeof a.destination==='string')add(a.destination,`schedule:${plan.id}`);
 }
 return refs;
}
