import {colors} from './theme.js';
import {PLAYER_NAMES} from '../../contracts/src/index.js';
import type {BotSettings} from '../../contracts/src/index.js';
import type {ConsoleSettings,ConsoleSeat} from '../../contracts/src/index.js';
export type {ConsoleSettings,ConsoleSeat} from '../../contracts/src/index.js';
export type ConsoleDetailTab='live'|'logs'|'notes'|'assessment'|'stats'|'config';
export function consoleDetailTabs(mode:NonNullable<ConsoleSettings['mode']>):readonly (readonly [ConsoleDetailTab,string])[]{
 return [['live','实时运转'],['logs','日志'],['notes','笔记'],['assessment','攻防评估'],['stats','统计'],['config','配置']];
}

export const consoleSeatName=(s:ConsoleSeat)=>s.bound!==false&&s.gamePlayer!==undefined?(PLAYER_NAMES[s.gamePlayer]??'玩家 '+(s.gamePlayer+1)):(s.controllerSlot!==undefined?'AI '+String(s.controllerSlot+1).padStart(2,'0'):'席位 '+(s.lobbySeat+1));
export const consoleSeatColor=(s:ConsoleSeat)=>s.bound!==false&&s.gamePlayer!==undefined?colors[s.gamePlayer]:undefined;
export interface ConsoleJob {id:string;seat:string;action:string;status:'running'|'completed'|'failed';error?:string}
/** A paused offline bot may have zero model calls but still have real run history. */
export function consoleShowsStart(seat:ConsoleSeat,snapshot:import('../../contracts/src/index.js').BotLiveSnapshot|null){
 if(seat.bound===false)return true;
 if(seat.enabled||seat.busy||seat.starting||seat.stopping||seat.error||seat.status==='error'||seat.status==='ended')return false;
 return !!snapshot&&snapshot.round===0&&!snapshot.decision&&!snapshot.directive&&!snapshot.tasks.length&&!snapshot.operations.length&&seat.calls===0&&!(seat.telemetry?.round);
}
export function seatActions(seat:ConsoleSeat,jobs:ConsoleJob[],connected:boolean){
 const running=jobs.filter(j=>j.seat===seat.id&&j.status==='running');
 const stopping=!!seat.stopping||running.some(j=>j.action==='pause');
 const active=seat.enabled||seat.busy||!!seat.starting||running.some(j=>j.action!=='pause');
 const ended=seat.status==='ended';
 return {start:connected&&seat.bound!==false&&!active&&!stopping&&!ended,pause:connected&&active&&!stopping,settings:connected&&!active&&!stopping&&!ended};
}
export const consoleStatusLabel=(value:string)=>({paused:'已暂停',waiting:'待命',thinking:'思考中',error:'异常',ended:'已结束'}[value]??value);
export const consoleEventLabel=(kind:string)=>({'mode-hybrid-decision':'战术方案已形成','mode-hybrid-validation':'方案已复核','mode-hybrid-search-failed':'战术搜索失败','mode-hybrid-model-call':'AI 模型调用详情','mode-hybrid-task-dispatched':'AI 任务已发送','mode-hybrid-task-failed':'AI 任务失败','mode-hybrid-task-skipped':'AI 任务已跳过','mode-hybrid-background-settled':'AI 回复已返回','mode-hybrid-usage':'AI 调用用量','mode-hybrid-diplomacy-trigger':'外交评估已触发','batch-recovered':'批量回执已恢复','write-dispatch-intent':'发送身份已保存','write-reconciled':'操作回执核对','query-progress':'查询进度已保存','tool-intent':'工具请求','tool-result':'工具已返回','tool-rejected':'工具被拒绝','tool-unknown':'操作结果未知',completed:'轮次完成',paused:'已暂停',started:'已启动','agent-started':'申请控制','agent-settings':'设置已更新',usage:'用量','call-completed':'模型已返回','call-reserved':'模型调用'}[kind]??kind);

/** A fixed controller slot can be rebound within the same room or across servers. */
export function diagnosticViewKey(seat:ConsoleSeat,tab:string){return JSON.stringify([seat.id,seat.diagnosticGeneration,seat.roomId,seat.lobbySeat,tab]);}
