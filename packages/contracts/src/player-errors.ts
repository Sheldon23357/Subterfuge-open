import {DISPATCH_LOCK_MESSAGE} from './dispatch-guard.js';
/** Explicit public messages only: never forward arbitrary engine/storage errors. */
const errors:Record<string,[string,string]>={
  [DISPATCH_LOCK_MESSAGE]:['DISPATCH_SOURCE_LOCKED',DISPATCH_LOCK_MESSAGE],
  'Commander directives require independent controller':['commander-controller-required','当前指挥官指令需要独立 AI 控制器处理；请连接独立控制器，或由玩家确认撤销全部指示后再使用旧托管 AI。'],
  '指挥官指令已经更新，请重新讨论此方案':['commander-proposal-stale','指挥官指令已经更新，请让 AI 重新整理方案后确认。'],
  '指挥官指令已更新':['commander-version-stale','指挥官指令已更新，请重新读取。'],
  '引用对象当前不可见':['commander-reference-unavailable','引用对象当前不可见，请重新选择。'],
  '请等当前讨论回复后再发送':['commander-queue-full','已有多条讨论等待回复，请稍后再发送。'],
  '方案不存在':['commander-proposal-unavailable','此方案已不可用，请刷新对话。'],
  'Player confirmation required':['commander-confirmation-required','新指示需要玩家单独确认。'],
  '消息标识冲突':['commander-message-conflict','这条消息的标识已用于其他内容，请重新发送。'],
  '本局对话记录已满':['commander-history-full','本局对话记录已满。'],
  '对话存储已满':['commander-storage-full','对话存储已满，请联系游戏管理员。'],

  '未来预约必须在整数世界天执行；请选择明确的整天时刻，不会自动取整':['integer-scheduled-day-required','预约必须选择整数绝对世界日，例如第3天；不会自动取整。'],
  '未来预约出发必须为整数世界天，不会自动取整':['integer-scheduled-day-required','预约出发必须选择整数绝对世界日，例如第3天；不会自动取整。'],
  'Insufficient drillers':['insufficient-drillers','当前驻兵不足；重新读取来源据点和开矿费用。'],
  'Invalid source or destination':['invalid-route','来源必须归你控制，且不能与目的地相同。'],
  'Outpost not owned by issuer':['not-owned','该据点不归你控制。'],
  'Fleet not owned by issuer':['not-owned','该舰队不可由你操作。'],
  'Unknown fleet':['unavailable-target','舰队不可用或不可见。'],
  'Unknown target':['unavailable-target','目标不可用或不可见。'],
  'Fleet has departed':['already-departed','舰队已出航，不能取消。'],
  'Departure can no longer be edited':['departure-locked','出航编辑窗口已结束。'],
  'Already a mine':['already-mine','该据点已经是矿场。'],
  'Mine cancellation window expired':['mine-locked','开矿取消窗口已结束。'],
  'Mining is disabled in domination mode':['mining-disabled','统治模式不能开矿。'],
  'Game has ended':['game-ended','对局已结束。'],
  'A related launch modification failed':['related-launch-failed','关联的出航或修改指令失败，请核对同一舰队的前序指令。'],
  'Command id conflict':['command-id-conflict','命令ID已用于不同内容，不要作为同一命令重试。'],
  'Schedule id conflict':['command-id-conflict','预约ID发生冲突，请检查已有预约。'],
};
export function publicPlayerError(error:unknown) {
  const item=error instanceof Error?errors[error.message]:undefined;
  return item?{error:'Request rejected',code:item[0],message:item[1]}:{error:'Request rejected',code:'request-rejected',message:'参数或操作不合法，请检查最新情报及工具参数。'};
}
