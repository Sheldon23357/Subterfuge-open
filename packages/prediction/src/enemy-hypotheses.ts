import type {PlayerObservation} from '../../contracts/src/index.js';

/** Explicit counterfactual using already visible assets, never a forecast of
 * intent or permission to issue an enemy order to the real game. */
export interface KnownEnemyLaunch {
  id:string;player:number;issueTick:number;source:string;destination:string;
  drillers:number;
}
export function validateEnemyHypotheses(o:PlayerObservation,launches:readonly KnownEnemyLaunch[]):void {
  if(!Array.isArray(launches)||launches.length>Math.max(6,o.view.outposts.length))throw Error('Enemy hypotheses exceed visible source budget');
  const spent=new Map<string,number>(),ids=new Set<string>();
  for(const h of launches){
    if(!h||Object.keys(h).some(k=>!['id','player','issueTick','source','destination','drillers'].includes(k))
      ||typeof h.id!=='string'||!h.id.trim()||h.id.length>128||ids.has(h.id)||!Number.isSafeInteger(h.player)||h.player===o.view.player
      ||!Number.isSafeInteger(h.issueTick)||h.issueTick<o.view.tick||h.issueTick>o.view.tick+144
      ||!Number.isSafeInteger(h.drillers)||h.drillers<=0)throw Error('Invalid visible enemy hypothesis');
    ids.add(h.id);
    const source=o.view.outposts.find(p=>p.id===h.source),destination=o.view.outposts.find(p=>p.id===h.destination);
    if(!source||source.visibility!==2||source.destroyed||source.owner!==h.player||source.drillers===undefined
      ||!destination||destination.visibility!==2||destination.destroyed||source.id===destination.id
      ||o.intel.find(p=>p.player===h.player)?.active!==true)throw Error('Enemy hypothesis requires visible active assets');
    if(o.view.fleets.some(f=>f.owner===h.player&&f.state==='waiting'&&f.destination?.id===destination.id
      &&(f.source===source.id||!f.source&&f.position.x===source.position.x&&f.position.y===source.position.y)))throw Error('Enemy hypothesis cannot silently edit a waiting fleet');
    const total=(spent.get(source.id)??0)+h.drillers;spent.set(source.id,total);
    if(total>source.drillers)throw Error('Enemy hypotheses reuse visible troops');

  }
}
