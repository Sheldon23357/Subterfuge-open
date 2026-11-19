/** Presentation only: never changes clock, prediction or player authority. */
export function headerClockState(input: { offset: number; playing: boolean; pending: boolean; realtime: boolean; ready: boolean; refreshing?: boolean }) {
  const { offset, playing, pending, realtime, ready } = input;
  const stepReason = !ready ? '等待对局加载' : input.refreshing ? '正在同步所选视野' : pending ? '正在提交操作' : realtime ? '实时对局由服务器推进' : offset !== 0 ? '回到现在后可单步推进' : playing ? '请先暂停自动推进' : '';
  return {
    stepReason,
    autoReason: !ready ? '等待对局加载' : pending ? '正在提交操作' : realtime ? '实时对局由服务器推进' : '',
    timeLabel: offset < 0 ? '历史回看' : offset > 0 ? '未来预览' : '当前局面',
    clockLabel: realtime ? '实时推进' : playing ? '自动推进中' : '已暂停',
  };
}

export function aiHeaderSummary(seats: readonly { enabled: boolean; status: string; recovering?: boolean; error: string | null }[], unavailable: boolean, loaded = false) {
  if (unavailable) return {label:'不可用', detail:'AI 状态暂不可用'};
  if (!seats.length) return loaded ? {label:'未启用', detail:'本局尚未配置 AI 席位'} : {label:'读取中', detail:'正在读取 AI 状态'};
  const thinking=seats.filter(s=>s.enabled&&s.status==='thinking').length;
  const attention=seats.filter(s=>s.status==='error'||s.recovering||s.error).length;
  return {label:attention?`${attention} 需关注`:`${thinking} 思考中`, detail:`${thinking} 席思考中，${attention} 席异常或等待恢复`};
}
