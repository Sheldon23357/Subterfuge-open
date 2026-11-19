import {dispatchDraftsAllowed,type PlayerObservation} from '../../../../contracts/src/index.js';

/** Conservative candidate-only screen, not a statement that each hypothetical
 * action will succeed. Actual writes and previews retain engine validation. */
export function botDispatchPlanAllowed(observation:PlayerObservation,drafts:readonly {id:string;issueTick:number;action:Record<string,unknown>}[]):boolean{
 if(!dispatchDraftsAllowed(observation,drafts))return false;
 const {view}=observation,guard=observation.dispatchGuard;
 // Missing capability means older server/fixture semantics, not an invented lock.
 if(!guard||guard.tick!==view.tick)return true;
 const locked=new Set(guard.lockedSources);
 const fleets=view.fleets.filter(f=>f.owner===view.player&&f.state==='waiting'&&f.source&&f.destination).map(f=>({
  id:f.id,source:f.source!,destination:f.destination!.id,kind:f.destination!.kind,drillers:f.drillers,
 }));
 const scheduled=new Set(observation.scheduled.filter(p=>p.player===view.player&&p.status==='pending'&&p.action.kind==='launch').map(p=>p.id));
 for(const draft of drafts){
  const a=draft.action;
  if(a.kind==='cancel-launch'){
   const index=fleets.findIndex(f=>f.id===a.fleetId);
   if(index>=0){locked.add(fleets[index]!.source);fleets.splice(index,1);}continue;
  }
  if(a.kind!=='launch'||typeof a.source!=='string')continue;
  if(locked.has(a.source))return false;
  const old=fleets.find(f=>f.source===a.source&&f.destination===a.destination&&(!a.fleetId||f.id===a.fleetId));
  if(draft.issueTick>view.tick){
   if(typeof a.fleetId==='string'&&(old||scheduled.has(a.fleetId)))locked.add(a.source);
   scheduled.add(draft.id);continue;
  }
  if(old){locked.add(a.source);old.drillers=Number(a.drillers);}
  else if(Number(a.delaySeconds??0)>0)fleets.push({id:typeof a.fleetId==='string'?a.fleetId:draft.id,source:a.source,destination:String(a.destination),kind:'outpost',drillers:Number(a.drillers)});
 }
 return true;
}
