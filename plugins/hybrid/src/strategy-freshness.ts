import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {HybridState,Objective} from './contracts.js';

export function currentObjectives(o:PlayerObservation,goals:readonly Objective[]):Objective[]{
 return goals.flatMap(g=>{
  if(!g.targets.length)return [g];
  const targets=g.targets.filter(id=>{
   const p=o.view.outposts.find(p=>p.id===id);if(!p||p.owner===undefined)return true;
   if(p.destroyed)return false;
   if(g.kind==='mine')return p.owner===o.view.player&&p.type!=='mine'&&!p.minePending;
   if(['capture','expand'].includes(g.kind))return p.owner!==o.view.player;
   return p.owner===o.view.player;
  });
  return targets.length?[{...g,targets}]:[];
 });
}
export function reconcileStrategy(o:PlayerObservation,state:HybridState):boolean{
 const d=state.directive;if(!d)return false;
 const before=JSON.stringify(state);
 // Strategic judgments keep their original observation basis until replaced.
 // State changes retire only goals that deterministic current facts rule out.
 if(state.assessments){
  const assessments=Object.values(state.assessments);
  d.forbiddenPlayers=[...new Set(assessments.flatMap(a=>a.forbiddenPlayers))];
  d.protectedSources=[...new Set(assessments.flatMap(a=>a.protectedSources))];
  d.reserves=assessments.flatMap(a=>a.reserves);d.reviewOn=[...new Set(assessments.flatMap(a=>a.reviewOn))];
 }
 d.objectives=currentObjectives(o,d.objectives);
 const changed=JSON.stringify(state)!==before;if(changed)d.version++;
 return changed;
}
