import {consoleStatusLabel,type ConsoleSeat} from './agent-console-state.js';
export function liveSeatPhase(seat:ConsoleSeat,connected:boolean){
 if(!connected)return '连接中断';
 if(seat.bound===false)return '未绑定';
 if(seat.error||seat.status==='error')return '异常';
 if(seat.stopping)return '暂停中';
 if(seat.starting)return '连接中';
 if(seat.waitingForGame)return '等待开局';
 if(!seat.enabled||seat.status==='ended')return consoleStatusLabel(seat.status);
 if(seat.telemetry?.foreground==='readiness')return '就绪上报';
 if(seat.telemetry?.foreground==='observation')return '后台观察';
 if(seat.telemetry?.phase==='model')return '模型决策中';
 if(seat.telemetry?.foreground==='planning-sync')return '本轮同步';
 if(seat.busy){const t=seat.telemetry;if(t?.phase==='tool')return '校验与执行';if(t?.phase==='local')return t.search?.sequence===t.round?'战术搜索':'整理本轮材料';return '同步授权事实';}
 if(seat.telemetry?.background?.active)return 'AI 指导处理中';
 if(seat.telemetry?.background?.queued)return 'AI 任务待调度';
 return '监听局势';
}
