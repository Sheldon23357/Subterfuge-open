import type {PlayerObservation} from '../../../../contracts/src/index.js';

/** Authorized production facts and a steady-rate estimate, without simulation. */
export function capacityPressure(o:PlayerObservation){
 const v=o.view,headroom=Math.max(0,v.self.capacity-v.self.drillers);
 const factories=v.outposts.filter(p=>p.owner===v.player&&!p.destroyed&&p.type==='factory'&&p.metrics?.active&&p.metrics.output>0);
 const pausedFactories=v.self.active&&v.self.drillers>=v.self.capacity?factories.filter(p=>p.metrics!.paused).length:0;
 const rate=factories.reduce((n,p)=>{const m=p.metrics!;return n+(m.cycleMinutes!==null&&m.cycleMinutes>0?m.output*10/m.cycleMinutes:0);},0);
 const fill=rate>0?headroom/rate:null;
 const near=v.self.active&&v.self.capacity>0&&v.self.drillers>=v.self.capacity*0.9&&fill!==null&&fill<=12;
 const state=pausedFactories>0?'blocked':near&&headroom>0?'tight':'none';
 return {state,pausedFactories,nominalOutputPer24WorldDays:Math.round(rate*24*10)/10,
  estimatedFillWorldDays:fill===null?null:Math.round(fill*10)/10,
  strength:state==='blocked'?1:state==='tight'?0.5*(1-headroom/(rate*12)):0};
}

export const CAPACITY_PRESSURE_GUIDE='满兵／临近满兵应提高主动进攻意愿：把停产机会成本与守备、停战和胜利时限一起权衡，优先可守住的近程扩张、夺供能点或合理开矿，不无限囤兵。出兵仍占总容量；有价值的战损或新增容量才可能恢复生产，勿送兵腾位。nominalOutputPer24WorldDays是按当前工厂周期折算的24天名义产能，非已损失产兵或保证补兵；estimatedFillWorldDays是忽略生产相位／未来变化的估计。pressureBonus只调整可见兵力有余量的新攻势优先分，不证明安全。决定暂缓须在现有计划中写具体障碍和重评条件；已有方案且事实未变不重复推演。';
