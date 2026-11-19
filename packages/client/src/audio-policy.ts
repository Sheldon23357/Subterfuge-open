/** Pure sound policy. Only confirmed commands and player-authorized notifications enter here. */
export const MUSIC_TRACKS = [
  { id: 'bgm_abyssal_planning', name: '深渊航图', mood: '规划 · 96 秒' },
  { id: 'bgm_abyssal_tension', name: '暗流警戒', mood: '紧张 · 96 秒' },
  { id: 'bgm_departure', name: '深潜启航', mood: '启航 · 96 秒' },
  { id: 'bgm_unmapped_waters', name: '未知海域', mood: '探索 · 120 秒' },
  { id: 'bgm_quiet_accord', name: '静海协定', mood: '休整 · 108 秒' },
] as const;
export type TrackId = typeof MUSIC_TRACKS[number]['id'];
export type SoundId = 'ui_click_a'|'ui_click_b'|'ui_select'|'ui_panel_open'|'ui_panel_close'|'day_advance'|'order_confirm'|'order_reject'|'fleet_launch'|'order_cancel'|'mine_build'|'message_received'|'sonar_arrival'|'threat_alert'|'shield_toggle'|'victory'|'defeat';
export function actionSound(path: string, input: unknown): SoundId | null {
  if (['preview','step','auto-advance','state','import','reset'].includes(path)) return null;
  if (path === 'cancel-schedule') return 'order_cancel';
  if (path === 'schedule' || path === 'schedule-order') return 'order_confirm';
  const data = input as { action?: {kind?:string}; order?: {action?:{kind?:string}} } | null;
  const kind = data?.action?.kind ?? data?.order?.action?.kind;
  const sounds: Record<string,SoundId> = {
    launch:'fleet_launch', 'cancel-launch':'order_cancel',
    'toggle-mine':'mine_build', 'set-shields':'shield_toggle',
  };
  return sounds[kind ?? ''] ?? 'order_confirm';
}
export function notificationSound(kind: string, urgent: boolean): SoundId | null {
  if (kind === 'dormant-arrival') return 'sonar_arrival';
  if (kind === 'mine-created') return 'mine_build';
  // A game-ended notice alone does not prove this player won. Never guess a victory cue.
  if (kind === 'game-ended') return 'message_received';
  if (urgent || ['battle','departed','mine-captured'].includes(kind)) return 'threat_alert';
  return null;
}
/** Observe authoritative time only; baseline new rooms and never replay missed days. */
export class AudioDayCursor {
  private previous: {roomId:string;tick:number;automatic:boolean} | null = null;
  accept(roomId:string, tick:number, automatic:boolean): SoundId | null {
    const previous = this.previous;
    this.previous = {roomId,tick,automatic};
    return previous && previous.roomId === roomId && tick > previous.tick &&
      (previous.automatic || automatic) ? 'day_advance' : null;
  }
}
/** Baseline history silently, then sound only genuinely new, server-authorized entries. */
export class AudioEventCursor {
  private high = -1;
  private ready = false;
  accept(entries: readonly {id:number;kind:string;urgent:boolean;sendNotification:boolean}[], hasMore:boolean): SoundId | null {
    const fresh = entries.filter(e => e.id > this.high);
    for (const e of entries) this.high = Math.max(this.high,e.id);
    if (!this.ready) { if (!hasMore) this.ready=true; return null; }
    const eligible = fresh.filter(e=>e.sendNotification);
    const event = eligible.find(e=>e.urgent) ?? eligible.at(-1);
    return event ? notificationSound(event.kind,event.urgent) : null;
  }
}
