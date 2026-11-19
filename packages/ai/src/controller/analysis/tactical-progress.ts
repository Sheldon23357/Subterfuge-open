import type {BotSearchProgress} from '../../../../contracts/src/index.js';
import type {BotCandidate} from './tactical-candidates.js';
/** Search membership comes from the actual generator, not names or geometric proximity. */
export function botSearchBranch(c:BotCandidate,status:string,utility:number|null):BotSearchProgress['branches'][number]{
 const node=(p:Pick<BotCandidate,'id'|'kind'|'targets'|'drafts'|'reasons'>)=>({
  id:p.id,kind:p.kind,targets:p.targets,reasons:p.reasons,
  actions:p.drafts.map(d=>({issueTick:d.issueTick,action:{kind:typeof d.action.kind==='string'?d.action.kind:'unknown',...Object.fromEntries(Object.entries(d.action).filter(([key,value])=>
   ['source','destination','outpostId','fleetId'].includes(key)&&typeof value==='string'||key==='drillers'&&typeof value==='number'||key==='enabled'&&typeof value==='boolean'))}})),
  routes:p.drafts.flatMap(d=>typeof d.action.source==='string'&&typeof d.action.destination==='string'?[{source:d.action.source,target:d.action.destination,drillers:typeof d.action.drillers==='number'?d.action.drillers:null}]:[]),
 });
 return {...node(c),status,utility,...(c.components?.length?{components:c.components.map(node)}:{})};
}
