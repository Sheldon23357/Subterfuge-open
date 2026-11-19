/** Permission comes from the authenticated control endpoint, never from a UI role flag. */
export interface PlayerControlView {
  protocol: string; roomId: string; player: number; mode: 'manual' | 'agent';
  controller?: 'manual' | 'hosted' | 'external'; expiresAt: number | null;
  manualCommandsAllowed?: boolean;
}
export function validatePlayerControl(value: PlayerControlView, roomId: string, player: number): void {
  if (value.protocol !== 'player-control/2' || value.roomId !== roomId || value.player !== player ||
    !['manual', 'agent'].includes(value.mode) || !['manual', 'hosted', 'external'].includes(value.controller ?? '') ||
    (value.mode === 'agent') !== (value.controller === 'external') ||
    value.manualCommandsAllowed !== undefined && typeof value.manualCommandsAllowed !== 'boolean')
    throw Error('控制权身份不匹配，请重新连接。');
}
export function playerControlPresentation(value: PlayerControlView | null, error = '') {
  const ai = value?.mode === 'agent' || value?.controller === 'hosted';
  const collaborative = ai && value?.manualCommandsAllowed === true;
  return {
    blocked: !value || ai && !collaborative,
    // Collaborative orders do not authorize chat writes or automatic check-in.
    exclusiveBlocked: !value || ai,
    collaborative,
    label: !value ? (error ? '控制权不可用' : '确认控制权…') : collaborative ? '手动优先 · AI 协作' : ai ? (value.controller === 'hosted' ? '服务器托管' : '外部 AI 控制') : '人工控制',
  };
}
