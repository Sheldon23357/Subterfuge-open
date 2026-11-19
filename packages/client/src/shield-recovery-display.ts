import {RULES,shieldChargePeriod} from '../../rules/src/index.js';
import {formatWorldDays} from '../../contracts/src/index.js';

/** Public visible values only; never inspect or reconstruct the hidden timer. */
export function shieldRecoveryDisplay(input:{shield:number;shieldMax:number;shieldsEnabled:boolean;owner:number|null},tick:number):{summary:string;detail:string} {
  const {shield,shieldMax:maximum,shieldsEnabled,owner}=input;
  if(!Number.isFinite(maximum)||maximum<0||!Number.isFinite(shield)||!Number.isFinite(tick))
    return {summary:'恢复节奏未知',detail:'缺少可见护盾数据。'};
  if(maximum===0)return {summary:'无护盾容量',detail:'护盾上限为0，不恢复护盾。'};
  const period=shieldChargePeriod(maximum)!;
  const normal=Math.max(1,period);
  const nextTick=Math.floor(tick)+1;
  const accelerated=nextTick<=RULES.GameParams.GameStartSpeedupTicks;
  const speed=accelerated?RULES.GameParams.GameStartSpeedupFactor:1;
  const average=Math.max(1,period/speed);
  const baseline=`正常每${formatWorldDays(normal)}恢复1盾`;
  const detail=`按可见护盾上限推算：${baseline}。逐天离散结算，每次最多1盾；${accelerated?'开局加速期间间隔可能交替，结束后恢复正常节奏；':''}未读取隐藏进度，不是下次恢复时间。战斗或护盾开关变化会影响实际护盾。`;
  if(!shieldsEnabled)return {summary:'护盾已关闭',detail:`当前不恢复。${detail}`};
  if(owner===null)return {summary:'中立据点不恢复',detail};
  if(shield>=maximum)return {summary:'护盾已满',detail};
  if(period===0)return {summary:'每1天最多恢复1盾',detail};
  return {summary:accelerated?`当前平均每${formatWorldDays(average)}恢复1盾`:baseline,detail};
}
