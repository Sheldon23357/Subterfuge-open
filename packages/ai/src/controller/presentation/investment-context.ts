import type {PlayerObservation} from '../../../../contracts/src/index.js';
import {scheduledCommitments} from '../analysis/scheduled-commitments.js';

export const INVESTMENT_STRATEGY_GUIDE='投资：采矿局在首矿/增矿机会或关键资源变化时，比较直接开矿、集兵补防后开矿、扩产/扩张与等待；未满兵不构成跳过比较的理由，有钱也不构成开矿理由。已有矿同样需要持续持有评估，新增矿不能抽空其他矿和关键产能点。资金线索仅为当前驻兵扣预约，未扣战略守备，不证明运输、建设或持续持有；使用compare联合验证，短窗口不冒充长期收益。暂缓记具体障碍、资源变化条件及复查时点，事实未变复用已有比较，障碍消失时重新选择。';

/** Current authorized funding arithmetic only. No route/safety assertion,
 * hypothetical production, hidden garrison or automatic spending decision. */
export function investmentContext(o:PlayerObservation){
  const v=o.view;
  if(v.match?.mode!=='mining'||!v.self.active||v.match.ended)return null;
  const own=v.outposts.filter(p=>p.owner===v.player&&!p.destroyed&&p.visibility===2);
  const firstMine=!own.some(p=>p.type==='mine'||p.minePending);
  const commitments=new Map(scheduledCommitments(o).map(c=>[c.source,c]));
  const rows=own.map(p=>{
    const c=commitments.get(p.id),unknown=p.drillers===undefined||!!c?.unknownSchedules.length;
    return {id:p.id,type:p.type,available:unknown?null:Math.max(0,p.drillers!-(c?.drillers??0))};
  });
  const known=rows.filter((p):p is typeof p&{available:number}=>p.available!==null);
  const cost=v.self.mineCreationCost;
  const candidates=known.filter(p=>p.type!=='mine'&&!own.find(post=>post.id===p.id)!.minePending).sort((a,b)=>b.available-a.available||a.id.localeCompare(b.id)).slice(0,3).map(p=>{
    const missing=Math.max(0,cost-p.available);
    let remaining=missing;
    const transfers=known.filter(d=>d.id!==p.id&&d.available>0).flatMap(d=>{
      const drillers=Math.min(d.available,remaining);remaining-=drillers;
      return drillers>0?[{source:d.id,drillers}]:[];
    }).slice(0,7); // leave one of compare's eight slots for mine construction
    const supplied=transfers.reduce((n,d)=>n+d.drillers,0);
    return {outpost:p.id,type:p.type,available:p.available,missing,transfers,unfunded:Math.max(0,missing-supplied)};
  });
  return {firstMine,cost,knownAvailable:known.reduce((n,p)=>n+p.available,0),
    unknownSources:rows.filter(p=>p.available===null).map(p=>p.id),candidates,
    scope:'仅当前驻兵扣已接受预约的资金线索；未扣战略守备，未验证航程、集结及建矿安全，无未来产兵假设'};
}
